import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type AgentifyConfig, originOf, validateConfig } from "./config.js";
import { detectAgent, pathMatcher, userAgentMatcher } from "./detect.js";
import { childTraceparent, DEFAULT_MAX_RESPONSE_BYTES, type Dispatcher, httpDispatcher, INTERNAL_HEADER, newInternalSecret } from "./dispatch.js";
import { type AgentifyHooks, composeHooks, type FinishInput, type FinishOutput, type RouteGuardResult } from "./hooks.js";
import { type IdempotencyStore, memoryIdempotencyStore } from "./idempotency.js";
import { ErrorCode, rpcError } from "./mcp/protocol.js";
import { operationTool } from "./mcp/operation-tool.js";
import { AppErrorCode, McpServer } from "./mcp/server.js";
import { pathParamValidator, type ToolDefinition, ToolRegistry } from "./mcp/tools.js";
import { importOpenApi } from "./openapi/convert.js";
import { credentialLocations, fetchSpec, type Json, readSpecFile } from "./openapi/load.js";
import { type Manifest, type ManifestTool, parseManifest, readManifest } from "./openapi/manifest.js";
import { anonymousPrincipal, bearerChallenge, credentialId, type Principal } from "./principal.js";
import { AGENT_INDEX_PATH, agentIndexDoc, agentIndexHtml } from "./surfaces/agent-index.js";
import { AI_CATALOG_PATH, aiCatalogDoc } from "./surfaces/ai-catalog.js";
import { llmsFullTxt, llmsTxt } from "./surfaces/llms-txt.js";
import { CORS_HEADERS, type Doc, serve, type SurfaceModel } from "./surfaces/model.js";
import { openapiJson, openapiYaml } from "./surfaces/openapi.js";
import { SERVER_CARD_ALIAS, SERVER_CARD_SUFFIX, serverCardDoc } from "./surfaces/server-card.js";
import { createLogger, type Logger } from "./util/log.js";
import { VERSION } from "./version.js";

export type { FinishInput, FinishOutput } from "./hooks.js";

/**
 * The core, on Fetch `Request`/`Response`, that every adapter wraps:
 *
 *   handle(request)  the agent surfaces: /mcp, /openapi.json, /llms.txt,
 *                    the server card, the AI Catalog, /agent, and any
 *                    documents hooks add. Returns null for anything else.
 *   guard(request)   on your own routes: strips forged X-Agentify-* headers,
 *                    detects agents, honours Idempotency-Key on agent writes,
 *                    and runs the `guardRoute` hook. Everything else passes
 *                    through untouched.
 */

export interface RequestContext {
  /** Hands a request to the app in-process (the adapter provides it). */
  dispatch: Dispatcher;
  /** The client's address as the adapter saw it. */
  ip?: string | null;
  /**
   * The request body, without taking it from your routes (for Idempotency-Key
   * checks). Adapters whose body can only be read once make it re-readable.
   */
  readBody?: () => Promise<Uint8Array | null>;
  /** The path and query exactly as the client sent them (before URL parsing tidied them up). */
  rawPath?: string;
}

export type GuardResult =
  | { action: "respond"; response: Response }
  | {
      action: "continue";
      /** Set on the request before your routes see it. */
      setHeaders: Record<string, string>;
      /** Removed from the request before your routes see it. */
      removeHeaders: string[];
      /** Added to every response for this request. */
      responseHeaders: Record<string, string>;
      /** The adapter must hold the response body and call finish() before sending. */
      buffer: boolean;
      /** Call once with the response (after it's sent, when buffer is false). */
      finish: ((res: FinishInput) => Promise<FinishOutput>) | null;
    };

export interface Agentify {
  readonly config: AgentifyConfig;
  /** Loads the spec and the manifest (once), and runs the hooks' setup. Adapters call it; you may too, to fail fast. */
  ready(ctx?: Partial<RequestContext>): Promise<void>;
  handle(request: Request, ctx: RequestContext): Promise<Response | null>;
  guard(request: Request, ctx: RequestContext): Promise<GuardResult>;
  /** Paths the surfaces answer on (for adapters that register routes). */
  surfacePaths(): string[];
  isInternal(headers: Headers): boolean;
  manifest(): Promise<Manifest>;
  tools(): Promise<ToolRegistry>;
  /** The model the discovery documents are built from, for one origin. */
  surfaceModel(origin: string): Promise<SurfaceModel>;
  close(): Promise<void>;
}

const MAX_MCP_BODY = 4 * 1024 * 1024;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Compiles "/v1/orders/{id}" to a matcher; static segments rank above parameters. */
export function compilePath(path: string): { re: RegExp; exact: RegExp; score: number; names: string[] } {
  const parts = path.split("/").filter(Boolean);
  const names: string[] = [];
  let score = 0;
  const re = parts
    .map((p) => {
      const whole = /^\{([^}]+)\}$/.exec(p);
      if (whole) {
        names.push(whole[1]!);
        return "([^/]+)";
      }
      score += 1;
      return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{([^}]+)\\\}/g, (_m, name: string) => {
        names.push(name.replace(/\\(.)/g, "$1"));
        return "([^/]+)";
      });
    })
    .join("/");
  // `re` is case-insensitive, like Express's default router, for deciding which operation a
  // request is. `exact` decides whether a caller may be handed a credential (`canonical`):
  // only when the request is spelled the way the spec spells it.
  return { re: new RegExp(`^/${re}/?$`, "i"), exact: new RegExp(`^/${re}/?$`), score, names };
}

/**
 * Paths a router might resolve differently from us: dot segments (plain or
 * encoded), empty segments, an encoded "/" or "\". Agent requests like these
 * are refused rather than guessed at.
 */
export function ambiguousPath(rawPath: string): boolean {
  const p = rawPath.split("?")[0]!;
  if (/\/\//.test(p) || /%2f|%5c|\\/i.test(p)) return true;
  return p.split("/").some((seg) => /^(\.|%2e){1,2}$/i.test(seg));
}

export function createAgentify(config: AgentifyConfig): Agentify {
  const warnings = validateConfig(config);
  const logger: Logger = config.logger ?? createLogger(config.logLevel ?? (process.env.NODE_ENV === "test" ? "error" : "info"));
  const now = config.now ?? Date.now;
  const fetchImpl = config.fetch ?? fetch;
  const root = config.root ?? process.cwd();
  const anonymous = config.anonymous ?? "allow";
  const hooks: AgentifyHooks = composeHooks(config.hooks);
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const mcpPath = "/mcp";
  const surfaces = {
    mcp: true,
    openapi: true,
    llmsTxt: true,
    serverCard: true,
    serverCardAlias: true,
    aiCatalog: true,
    agentIndex: true,
    linkHeaders: true,
    robots: false,
    ...config.surfaces,
  };
  const idem = config.idempotency;
  const idempotencyTtlMs = idem === false ? 0 : ((typeof idem === "object" ? idem.ttlSeconds : undefined) ?? 86_400) * 1000;
  const idempotencyStore: IdempotencyStore | null = idem === false ? null : ((typeof idem === "object" ? idem.store : undefined) ?? memoryIdempotencyStore({ now }));
  // Agentify's own in-process calls carry X-Agentify-Internal with a fresh random value per
  // dispatch, valid only while that dispatch runs. Handlers mounted before Agentify can see
  // it, so it's single-use: a value that leaks (a log line) is already dead.
  const liveMarkers = new Map<string, number>();
  const MARKER_TTL_MS = 10 * 60_000;
  function issueMarker(): string {
    const t = Date.now();
    if (liveMarkers.size > 10_000) for (const [k, exp] of liveMarkers) if (exp < t) liveMarkers.delete(k);
    const m = newInternalSecret();
    liveMarkers.set(m, t + MARKER_TTL_MS);
    return m;
  }
  /** Runs one in-process dispatch with its own marker, retired when the app has answered. */
  function markedDispatch(dispatch: Dispatcher, request: Request, info: { remoteAddress: string | null }): Promise<Response> {
    const marker = issueMarker();
    request.headers.set(INTERNAL_HEADER, marker);
    return dispatch(request, info).finally(() => liveMarkers.delete(marker));
  }
  const matchUa = userAgentMatcher(config.detect?.userAgents);
  const inScope = pathMatcher(config.detect?.include, config.detect?.exclude);
  for (const w of warnings) logger.warn("config", { message: w });

  // ── State loaded once ────────────────────────────────────────────────────
  interface Route {
    tool: ManifestTool;
    method: string;
    re: RegExp;
    exact: RegExp;
    score: number;
    /** One per path parameter, in order: null when its schema doesn't constrain it. */
    checks: Array<((raw: string) => boolean) | null>;
  }
  interface Loaded {
    spec: Json | null;
    manifest: Manifest;
    registry: ToolRegistry;
    mcp: McpServer;
    credentials: { headers: string[]; cookies: string[] };
    /** Every operation in agentify.tools.json, enabled or not, most specific first. */
    routes: Route[];
    version: string;
    description: string;
  }
  let loading: Promise<Loaded> | null = null;
  let loaded: Loaded | null = null;
  const models = new Map<string, SurfaceModel>();
  const docs = new Map<string, Doc | null>();

  async function loadSpec(ctx?: Partial<RequestContext>): Promise<Json | null> {
    const s = config.spec;
    if (!s) {
      for (const name of ["openapi.json", "openapi.yaml", "openapi.yml"]) if (existsSync(resolve(root, name))) return readSpecFile(resolve(root, name));
      return null;
    }
    if (typeof s === "object") return structuredClone(s) as Json;
    if (/^https?:\/\//.test(s)) return fetchSpec(s, fetchImpl);
    if (s.startsWith("app:")) {
      if (!ctx?.dispatch) throw new Error(`agentify: spec "${s}" is read from your app on the first request`);
      const url = new URL(s.slice(4), config.baseUrl ?? "http://localhost");
      const res = await markedDispatch(ctx.dispatch, new Request(url, { headers: { accept: "application/json" } }), { remoteAddress: "127.0.0.1" });
      if (!res.ok) throw new Error(`agentify: your app answered ${res.status} for ${url.pathname}`);
      const { parseSpecText } = await import("./openapi/load.js");
      return parseSpecText(await res.text(), s);
    }
    return readSpecFile(resolve(root, s));
  }

  function loadManifest(spec: Json | null): Manifest {
    const t = config.tools ?? "./agentify.tools.json";
    if (typeof t === "object") return parseManifest(t, "config.tools");
    const file = resolve(root, t);
    const m = readManifest(file);
    if (m) return m;
    if (!spec) {
      logger.warn("no_tools", { message: `No ${t} and no spec: /mcp has no operation tools. Run \`npx openapi-agentify init\`.` });
      return { tools: [] };
    }
    logger.warn("no_tools_file", { message: `No ${t}: tools made from the spec with defaults (reads on, writes off). Run \`npx openapi-agentify init\` to review them.` });
    return importOpenApi(spec, { specSource: typeof config.spec === "string" ? config.spec : "config" }).manifest;
  }

  async function load(ctx?: Partial<RequestContext>): Promise<Loaded> {
    const spec = await loadSpec(ctx);
    const manifest = loadManifest(spec);
    const registry = new ToolRegistry();
    for (const t of manifest.tools) if (t.enabled) registry.register(operationTool(t, maxResponseBytes));
    if (config.codeTools?.length) registry.register(...config.codeTools);
    await hooks.setup?.({ config, spec, manifest, logger });
    const version = config.version ?? (typeof spec?.info?.version === "string" ? spec.info.version : VERSION);
    const description = config.description ?? (typeof spec?.info?.description === "string" ? spec.info.description : `${config.name}, for agents.`);
    const mcp = new McpServer({
      tools: registry,
      name: config.name,
      version,
      instructions: config.instructions,
      anonymous,
      hooks,
      resourceMetadataUrl: (origin) => modelFor(origin, partial).auth.resourceMetadataUrl,
      maxArgumentValues: config.maxArgumentValues,
    });
    // Every operation, enabled or not, so a disabled static path (/v1/orders/export) is never
    // taken for an enabled template (/v1/orders/{id}): matching it means "disabled".
    const routes: Route[] = manifest.tools
      .map((tool) => {
        const c = compilePath(tool.path);
        const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
        const checks = c.names.map((name) => {
          const p = tool.params.find((x) => x.in === "path" && x.name === name);
          return pathParamValidator(p ? props[p.arg] : undefined);
        });
        return { tool, method: tool.method, re: c.re, exact: c.exact, score: c.score, checks };
      })
      .sort((a, b) => b.score - a.score);
    const partial: Loaded = { spec, manifest, registry, mcp, credentials: credentialLocations(spec), routes, version, description };
    logger.info("agentify_ready", { tools: registry.size, spec: Boolean(spec), hooks: Object.keys(hooks).length > 0 });
    return partial;
  }

  async function ready(ctx?: Partial<RequestContext>): Promise<Loaded> {
    if (loaded) return loaded;
    // Assigned before load() runs a single line: a spec read from your app ("app:") re-enters
    // Agentify through your middleware while loading, and must find this promise.
    loading ??= Promise.resolve().then(() => load(ctx)).then(
      (l) => (loaded = l),
      (err) => {
        loading = null; // try again on the next request
        throw err;
      },
    );
    return loading;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function hops(): number {
    return config.trustProxy === true ? 1 : Math.max(1, Number(config.trustProxy));
  }

  /**
   * The client's IP. Behind proxies you trust (`trustProxy: true` = one hop, or
   * the number of hops), it's the entry that many hops from the right of
   * X-Forwarded-For: what your proxy saw, not what the client wrote.
   */
  function clientIp(request: Request, ctx: RequestContext): string | null {
    if (config.trustProxy) {
      const xff = (request.headers.get("x-forwarded-for") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const hit = xff[xff.length - hops()];
      if (hit) return hit;
    }
    if (!ctx.ip && !warnedNoIp) {
      warnedNoIp = true;
      logger.warn("no_client_ip", { message: "No client IP for this request. Behind a proxy (or on Vercel), set trustProxy." });
    }
    return ctx.ip ?? null;
  }
  let warnedNoIp = false;

  /**
   * This API's origin: baseUrl whenever it's set. Without it, the request's Host; behind
   * proxies you trust, X-Forwarded-Host/-Proto read like X-Forwarded-For: the entry your
   * proxy added (that many hops from the right), not what the client wrote first.
   */
  function originFor(request: Request): string {
    if (config.baseUrl) return originOf(config.baseUrl);
    const u = new URL(request.url);
    if (config.trustProxy) {
      const hop = (name: string) => {
        const list = (request.headers.get(name) ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return list[list.length - hops()] ?? list[0];
      };
      const proto = hop("x-forwarded-proto");
      const host = hop("x-forwarded-host");
      const p = proto === "http" || proto === "https" ? proto : undefined;
      const h = host && /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(host) ? host : undefined;
      if (p || h) return `${p ?? u.protocol.replace(":", "")}://${h ?? u.host}`;
    }
    return u.origin;
  }

  function isInternal(headers: Headers): boolean {
    const v = headers.get(INTERNAL_HEADER);
    if (!v) return false;
    const exp = liveMarkers.get(v);
    return exp !== undefined && exp > Date.now();
  }

  function forwardHeaderNames(l: Loaded): string[] {
    if (config.auth?.forward?.length) return config.auth.forward.map((h) => h.toLowerCase());
    return l.credentials.headers;
  }

  type AuthResult = { ok: true; principal: Principal } | { ok: false; response: Response };

  /** Who is calling /mcp: the authenticate hook, else passthrough, else anonymous. */
  async function authenticate(request: Request, l: Loaded, ip: string | null, origin: string): Promise<AuthResult> {
    const prm = modelFor(origin, l).auth.resourceMetadataUrl;
    if (hooks.authenticate) {
      const r = await hooks.authenticate(request, { ip, origin, resourceMetadataUrl: prm });
      if (r instanceof Response) return { ok: false, response: r };
      if (r) return { ok: true, principal: r };
    }
    const forward: Record<string, string> = {};
    for (const h of forwardHeaderNames(l)) {
      const v = request.headers.get(h);
      if (v) forward[h] = v;
    }
    const first = Object.values(forward)[0];
    if (first) {
      const id = credentialId(first);
      return { ok: true, principal: { type: "passthrough", id, label: id, scopes: ["*"], forward } };
    }
    if (anonymous === "deny") {
      return { ok: false, response: json(rpcError(null, AppErrorCode.Unauthorized, "Authentication required"), 401, { "www-authenticate": bearerChallenge(prm) }) };
    }
    return { ok: true, principal: anonymousPrincipal(ip) };
  }

  /**
   * Browsers send Origin; other clients (agents, curl) don't, and aren't subject to it.
   * With baseUrl: pages from this origin or allowedOrigins. Without it (local development)
   * the request's own Host can't be trusted — a DNS-rebinding page makes Host and Origin
   * agree — so both must be loopback, or the Origin must be in allowedOrigins.
   */
  function originAllowed(origin: string | null, request: Request): boolean {
    if (!origin) return true;
    if (config.allowedOrigins?.includes(origin)) return true;
    if (config.baseUrl) return origin === originOf(config.baseUrl);
    const loopback = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
    try {
      return loopback(new URL(origin).hostname) && loopback(new URL(request.url).hostname);
    } catch {
      return false;
    }
  }

  const mcpAllowHeaders = ["Content-Type", "Authorization", "Accept", "Mcp-Protocol-Version", "Mcp-Method", "Mcp-Name", ...(hooks.mcpRequestHeaders ?? [])].join(", ");
  function mcpCors(origin: string | null): Record<string, string> {
    return origin
      ? {
          "access-control-allow-origin": origin,
          vary: "Origin",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": mcpAllowHeaders,
          "access-control-expose-headers": "WWW-Authenticate, Retry-After",
        }
      : {};
  }

  async function readBody(request: Request, max: number): Promise<string | null> {
    const len = Number(request.headers.get("content-length") ?? "0");
    if (len > max) return null;
    if (!request.body) return "";
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function handleMcp(request: Request, ctx: RequestContext, l: Loaded): Promise<Response> {
    const origin = originFor(request);
    const reqOrigin = request.headers.get("origin");
    if (!originAllowed(reqOrigin, request)) return json(rpcError(null, AppErrorCode.Forbidden, "Origin not allowed"), 403);
    const cors = mcpCors(reqOrigin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST", ...cors } });

    const text = await readBody(request, MAX_MCP_BODY);
    if (text === null) return json(rpcError(null, ErrorCode.InvalidRequest, "Request body too large"), 413, cors);
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return json(rpcError(null, ErrorCode.ParseError, "Parse error"), 400, cors);
    }
    const ip = clientIp(request, ctx);
    const auth = await authenticate(request, l, ip, origin);
    if (!auth.ok) {
      // Answer in JSON-RPC with the request's id when the refusal is JSON.
      const rawId = (msg as { id?: unknown } | null)?.id;
      const type = auth.response.headers.get("content-type") ?? "";
      if (!/json/.test(type)) {
        const headers = new Headers(auth.response.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(auth.response.body, { status: auth.response.status, headers });
      }
      const body = (await auth.response.json()) as Record<string, unknown>;
      if (typeof rawId === "string" || typeof rawId === "number") body.id = rawId;
      return json(body, auth.response.status, { ...Object.fromEntries(auth.response.headers), ...cors });
    }
    const principal = auth.principal;
    const requestId = request.headers.get("x-request-id")?.slice(0, 128) || randomUUID();
    const userAgent = request.headers.get("user-agent");
    const meta = (msg as { params?: { _meta?: Record<string, unknown> } } | null)?.params?._meta;
    const parentTrace = typeof meta?.traceparent === "string" ? meta.traceparent : request.headers.get("traceparent");

    const reply = await l.mcp.handle(msg, {
      principal,
      logger,
      requestId,
      signal: request.signal,
      headers: (name) => request.headers.get(name) ?? undefined,
      origin,
      userAgent,
      ip,
      now,
      toolCall: (_tool, extraHeaders) => {
        const headers: Record<string, string> = {
          ...principal.forward,
          ...extraHeaders,
          "x-request-id": requestId,
          traceparent: childTraceparent(parentTrace),
          "user-agent": `agentify/${VERSION} (mcp${userAgent ? `; ${userAgent.replace(/[\r\n]/g, " ").slice(0, 120)}` : ""})`,
          ...(ip ? { "x-forwarded-for": ip } : {}),
        };
        // The socket address your app sees is the real one; a proxy-reported client IP only goes in X-Forwarded-For.
        // Each dispatch gets its own single-use X-Agentify-Internal marker.
        const dispatch = (req: Request) => markedDispatch(ctx.dispatch, req, { remoteAddress: ctx.ip ?? null });
        return {
          call: { origin, headers, dispatch },
          fetchApp: (path, init = {}) => {
            const h = new Headers(init.headers);
            for (const [k, v] of Object.entries(headers)) h.set(k, v);
            return dispatch(new Request(new URL(path, origin), { ...init, headers: h, redirect: "manual" }));
          },
        };
      },
    });
    const headers = { ...cors, ...(reply.headers ?? {}) };
    if (!reply.body) return new Response(null, { status: 202, headers });
    return json(reply.body, reply.status, headers);
  }

  // ── Surfaces ─────────────────────────────────────────────────────────────

  function modelFor(origin: string, l: Loaded): SurfaceModel {
    const cached = models.get(origin);
    if (cached) return cached;
    const enabledOps = new Map(l.manifest.tools.filter((t) => t.enabled).map((t) => [t.name, t]));
    const u = (on: boolean, path: string) => (on ? `${origin}${path}` : null);
    const base: SurfaceModel = {
      name: config.name,
      description: l.description,
      version: l.version,
      origin,
      mcpUrl: `${origin}${mcpPath}`,
      auth: {
        mode: "passthrough",
        headers: forwardHeaderNames(l),
        issuer: null,
        scopes: [],
        resourceMetadataUrl: null,
        anonymous,
      },
      // Only what agents may call: a disabled operation is never advertised.
      tools: l.registry.all().map((def) => ({ def, op: enabledOps.get(def.name) ?? null })),
      spec: l.spec,
      notes: [],
      showPrices: false,
      links: {
        openapi: u(surfaces.openapi && Boolean(l.spec), "/openapi.json"),
        openapiYaml: u(surfaces.openapi && Boolean(l.spec), "/openapi.yaml"),
        llmsTxt: u(surfaces.llmsTxt, "/llms.txt"),
        llmsFullTxt: u(surfaces.llmsTxt, "/llms-full.txt"),
        serverCard: u(surfaces.serverCard, `${mcpPath}${SERVER_CARD_SUFFIX}`),
        aiCatalog: u(surfaces.aiCatalog, AI_CATALOG_PATH),
        agentIndex: u(surfaces.agentIndex, AGENT_INDEX_PATH),
      },
      extraLinks: [],
      extensions: {},
    };
    const m = hooks.describe ? hooks.describe(base) : base;
    if (models.size > 16) models.clear(); // requests from many hosts (no baseUrl): don't grow without bound
    models.set(origin, m);
    return m;
  }

  function cachedDoc(key: string, make: () => Doc | null): Doc | null {
    if (docs.has(key)) return docs.get(key)!;
    const d = make();
    if (docs.size > 256) docs.clear();
    docs.set(key, d);
    return d;
  }

  const extensions = new Map((hooks.surfaces ?? []).map((s) => [s.path, s]));
  /** Only the surfaces that are on: a path that's off stays your app's (Fastify registers routes from this list). */
  const activePaths = [
    ...(surfaces.mcp ? [mcpPath] : []),
    ...(surfaces.serverCard ? [`${mcpPath}${SERVER_CARD_SUFFIX}`, ...(surfaces.serverCardAlias ? [SERVER_CARD_ALIAS] : [])] : []),
    ...(surfaces.aiCatalog ? [AI_CATALOG_PATH] : []),
    ...(surfaces.openapi ? ["/openapi.json", "/openapi.yaml"] : []),
    ...(surfaces.llmsTxt ? ["/llms.txt", "/llms-full.txt"] : []),
    ...(surfaces.agentIndex ? [AGENT_INDEX_PATH] : []),
    ...(surfaces.robots ? ["/robots.txt"] : []),
    ...extensions.keys(),
  ];
  const activeSet = new Set(activePaths);
  function surfacePaths(): string[] {
    return [...activeSet];
  }

  async function handle(request: Request, ctx: RequestContext): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/(.)\/+$/, "$1");
    if (!activeSet.has(path)) return null;
    // Agentify's own in-process calls go to your routes, never back into the surfaces.
    if (isInternal(request.headers)) return null;
    const l = await ready(ctx);
    const origin = originFor(request);
    const m = modelFor(origin, l);
    const get = request.method === "GET" || request.method === "HEAD";
    if (path === mcpPath && surfaces.mcp) return handleMcp(request, ctx, l);
    const ext = extensions.get(path);
    if (ext) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (!get && !ext.methods?.includes(request.method)) return new Response(null, { status: 405, headers: { allow: ["GET", "HEAD", ...(ext.methods ?? [])].join(", ") } });
      if (ext.cache !== false && get) {
        const d = docs.get(`${origin} ext:${path}`);
        if (d) return serve(d, request, Boolean(config.baseUrl));
      }
      const out = await ext.serve(request, m);
      if (!out) return null;
      if (out instanceof Response) return out;
      if (ext.cache !== false) cachedDoc(`${origin} ext:${path}`, () => out);
      return serve(out, request, Boolean(config.baseUrl));
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (!get) return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    const ops = l.manifest.tools;
    const pick = (on: boolean, key: string, make: () => Doc | null) => {
      if (!on) return null;
      const d = cachedDoc(`${origin} ${key}`, make);
      return d ? serve(d, request, Boolean(config.baseUrl)) : null;
    };
    switch (path) {
      case `${mcpPath}${SERVER_CARD_SUFFIX}`:
        return pick(surfaces.serverCard, "card", () => serverCardDoc(m));
      case SERVER_CARD_ALIAS:
        return pick(surfaces.serverCard && surfaces.serverCardAlias, "card", () => serverCardDoc(m));
      case AI_CATALOG_PATH:
        return pick(surfaces.aiCatalog, "catalog", () => aiCatalogDoc(m));
      case "/openapi.json":
        return pick(surfaces.openapi, "openapi.json", () => openapiJson(m, ops));
      case "/openapi.yaml":
        return pick(surfaces.openapi, "openapi.yaml", () => openapiYaml(m, ops));
      case "/llms.txt":
        return pick(surfaces.llmsTxt, "llms", () => llmsTxt(m));
      case "/llms-full.txt":
        return pick(surfaces.llmsTxt, "llms-full", () => llmsFullTxt(m));
      case AGENT_INDEX_PATH: {
        const html = /text\/html/.test(request.headers.get("accept") ?? "") && !/application\/json/.test(request.headers.get("accept") ?? "");
        return pick(surfaces.agentIndex, html ? "agent.html" : "agent.json", () => (html ? agentIndexHtml(m) : agentIndexDoc(m)));
      }
      case "/robots.txt":
        return new Response(`User-agent: *\nAllow: /\n\n# For AI agents: ${origin}/llms.txt and ${origin}${AGENT_INDEX_PATH}\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return null;
  }

  // ── The route guard ──────────────────────────────────────────────────────

  /**
   * The operation a request is for: the most specific route whose path parameters also
   * pass their schema (pattern, enum, format…). A value that fails isn't this operation
   * (GET /v1/orders/export is not getOrder when id has a pattern).
   */
  function matchRoute(l: Loaded, method: string, path: string): Route | null {
    const m = method === "HEAD" ? "GET" : method;
    const p = normalizePath(path);
    for (const r of l.routes) {
      if (r.method !== m) continue;
      const hit = r.re.exec(p);
      if (!hit) continue;
      if (r.checks.every((check, i) => !check || check(hit[i + 1]!))) return r;
    }
    return null;
  }

  async function guard(request: Request, ctx: RequestContext): Promise<GuardResult> {
    // Agentify's own call while it's still loading (reading an "app:" spec): waiting for the
    // load would wait for itself. Just drop the marker.
    if (!loaded && isInternal(request.headers)) return { action: "continue", setHeaders: {}, removeHeaders: [INTERNAL_HEADER], responseHeaders: {}, buffer: false, finish: null };
    let l: Loaded;
    try {
      l = await ready(ctx);
    } catch (err) {
      // Agentify can't load (the spec is broken, a hook's setup failed): your API keeps
      // serving. Forged X-Agentify-* headers are still stripped. Retried next request.
      logger.error("agentify_unavailable", { err });
      const strip = [...request.headers.keys()].filter((k) => k.startsWith("x-agentify-"));
      return { action: "continue", setHeaders: {}, removeHeaders: strip, responseHeaders: {}, buffer: false, finish: null };
    }
    const url = new URL(request.url);
    const path = url.pathname;
    const internal = isInternal(request.headers);
    // Nobody outside Agentify may set X-Agentify-* on your routes: strip forged ones.
    const removeHeaders = [...request.headers.keys()].filter((k) => k.startsWith("x-agentify-") && (!internal || k === INTERNAL_HEADER));
    const responseHeaders: Record<string, string> =
      surfaces.linkHeaders && path === "/"
        ? {
            link: [
              surfaces.llmsTxt && '</llms.txt>; rel="llms-txt"; type="text/markdown"',
              surfaces.openapi && l.spec && '</openapi.json>; rel="service-desc"; type="application/json"',
              surfaces.serverCard && `<${mcpPath}${SERVER_CARD_SUFFIX}>; rel="mcp-server-card"; type="application/mcp-server-card+json"`,
              surfaces.agentIndex && `<${AGENT_INDEX_PATH}>; rel="service-meta"; type="application/json"`,
            ]
              .filter(Boolean)
              .join(", "),
          }
        : {};
    const plain: GuardResult = { action: "continue", setHeaders: {}, removeHeaders, responseHeaders, buffer: false, finish: null };

    if (internal) {
      // The MCP layer (and its hooks) already handled this call; only idempotency applies
      // here, and only to operations in agentify.tools.json (anything else is your app's).
      // Scoped like on the routes: who paid or which key (set by a hook), the forwarded
      // credential, else the caller's IP.
      const route = matchRoute(l, request.method, path);
      if (!route?.tool.enabled) return plain;
      const hooked = request.headers.get("x-agentify-agent") ?? request.headers.get("x-agentify-payer");
      const credential = [...new Set([...forwardHeaderNames(l), "authorization", "cookie"])].map((h) => request.headers.get(h)).find(Boolean);
      const fwd = request.headers.get("x-forwarded-for");
      const scope = hooked ? `hook:${hooked.toLowerCase()}` : credential ? credentialId(credential) : fwd ? `ip:${fwd}` : null;
      // A caller we can't tell apart from others gets no shared idempotency namespace.
      return scope ? withIdempotency(request, ctx, scope, plain, null) : plain;
    }
    // Match what a router would route: tidied path, case-insensitive (see compilePath).
    const rawPathname = (ctx.rawPath ?? `${path}${url.search}`).split("?")[0]!;
    if (!inScope(normalizePath(path))) return plain;

    const route = matchRoute(l, request.method, path);
    // An operation you disabled in agentify.tools.json is not an operation for agents.
    const op = route?.tool.enabled ? route.tool : null;
    const disabled = route && !route.tool.enabled ? route.tool : null;
    const ip = clientIp(request, ctx);
    const detected = detectAgent(request.headers, matchUa);
    const ambiguous = ambiguousPath(rawPathname);

    // A path your router might resolve differently from us (dot segments, "//", an
    // encoded "/") is refused for agents, rather than guessed at.
    if (ambiguous && detected.agent) {
      return { action: "respond", response: json({ error: "ambiguous_path", message: "Send the path without dot segments, empty segments or encoded slashes" }, 400) };
    }
    // Spelled exactly as the spec spells the operation (a case-sensitive router could route another spelling elsewhere).
    const canonical = Boolean(op) && route!.exact.test(rawPathname);
    const hasCredentials = forwardHeaderNames(l).some((h) => request.headers.has(h)) || request.headers.has("cookie");

    let hooked: Exclude<RouteGuardResult, void | undefined | { respond: Response }> | null = null;
    if (hooks.guardRoute) {
      const r = await hooks.guardRoute(request, { path, rawPath: rawPathname, operation: op, disabled, canonical, ambiguous, detected, hasCredentials, ip, origin: originFor(request) });
      if (r && "respond" in r) return { action: "respond", response: r.respond };
      if (r) hooked = r;
    }
    const base: GuardResult = {
      action: "continue",
      setHeaders: { ...(hooked?.setHeaders ?? {}) },
      removeHeaders: [...removeHeaders, ...(hooked?.removeHeaders ?? [])],
      responseHeaders: { ...responseHeaders, ...(hooked?.responseHeaders ?? {}) },
      buffer: Boolean(hooked?.buffer),
      finish: hooked?.finish ?? null,
    };
    // Idempotency-Key: only on operations in agentify.tools.json, from agents (anything else
    // is your app's business, header and all). Scoped to who is calling, as precisely as we
    // know it: the hook's scope (a key, a payer), the credential they sent, their cookies
    // (a browser session), only then the agent and its IP.
    if (!op || !(detected.agent || hooked?.idempotencyScope)) return base;
    const credential = [...forwardHeaderNames(l), "cookie"].map((h) => request.headers.get(h)).find(Boolean);
    const scope = hooked?.idempotencyScope ?? (credential ? credentialId(credential) : ip ? `ua:${detected.name ?? "agent"}:${ip}` : null);
    return scope ? withIdempotency(request, ctx, scope, base, hooked?.cancel ?? null) : base;
  }

  /** Idempotency-Key on agent POST/PATCH: a retry with the same key gets the first answer. */
  async function withIdempotency(request: Request, ctx: RequestContext, scope: string, base: GuardResult, cancel: (() => Promise<void>) | null): Promise<GuardResult> {
    if (base.action !== "continue" || !idempotencyTtlMs || !idempotencyStore) return base;
    if (request.method !== "POST" && request.method !== "PATCH") return base;
    const key = request.headers.get("idempotency-key");
    if (!key) return base;
    const giveBack = async () => {
      await cancel?.().catch(() => {});
    };
    if (!/^[\x21-\x7e]{1,255}$/.test(key)) {
      await giveBack();
      return { action: "respond", response: json({ error: "bad_request", message: "Idempotency-Key must be 1–255 printable ASCII characters" }, 400) };
    }
    // The raw body bytes, whatever the content type. Past 1 MiB (or unreadable) there's no
    // hash to compare a retry against: no replay protection from us, the request goes on.
    const body = ctx.readBody ? await ctx.readBody() : null;
    if (body === null) {
      logger.debug("idempotency_skipped", { reason: "body over 1 MiB or unreadable", path: new URL(request.url).pathname });
      return base;
    }
    const path = new URL(request.url).pathname;
    const scopeKey = createHash("sha256").update(`${scope}\0${key}`).digest("hex");
    const requestHash = createHash("sha256")
      .update(`${request.method}\0${path}\0${new URL(request.url).search}\0`)
      .update(body)
      .digest("hex");
    const store = idempotencyStore;
    const begin = await store.beginIdempotent(scopeKey, requestHash, 60_000, idempotencyTtlMs);
    if (begin.state === "mismatch") {
      await giveBack();
      return { action: "respond", response: json({ error: "idempotency_key_reused", message: "This Idempotency-Key was used with a different request" }, 422) };
    }
    if (begin.state === "in_progress") {
      await giveBack();
      return { action: "respond", response: json({ error: "idempotency_in_progress", message: "A request with this Idempotency-Key is still running" }, 409, { "retry-after": "1" }) };
    }
    if (begin.state === "completed") {
      // A replay: the stored response.
      await giveBack();
      const headers = new Headers(begin.response.headers);
      headers.set("idempotent-replayed", "true");
      return { action: "respond", response: new Response(Buffer.from(begin.response.body, "base64"), { status: begin.response.status, headers }) };
    }
    const inner = base.finish;
    return {
      ...base,
      buffer: true,
      finish: async (res) => {
        const out = inner ? await inner(res) : {};
        const status = out.replace ? out.replace.status : res.status;
        if (!out.replace && status < 500 && status !== 429 && res.body) {
          const headers: Record<string, string> = {};
          // What a replay needs to be read the same way (compression after Agentify included).
          for (const h of ["content-type", "content-encoding", "content-language", "location", "vary"]) {
            const v = res.headers.get(h);
            if (v) headers[h] = v;
          }
          await store.completeIdempotent(scopeKey, { status, headers, body: Buffer.from(res.body).toString("base64") }).catch((err) => logger.error("idempotency_store_failed", { err }));
        } else {
          await store.releaseIdempotent(scopeKey).catch(() => {});
        }
        return out;
      },
    };
  }

  return {
    config,
    ready: async (ctx) => {
      await ready(ctx);
    },
    handle,
    guard,
    surfacePaths,
    isInternal,
    manifest: async () => (await ready()).manifest,
    tools: async () => (await ready()).registry,
    surfaceModel: async (origin) => modelFor(origin, await ready()),
    close: async () => {
      await hooks.close?.();
    },
  };
}

/**
 * The path as routers see it, for matching operations: percent-encoded
 * characters decoded within each segment (an encoded "/" stays one segment),
 * repeated slashes collapsed. So /v1/reports/%73ales is /v1/reports/sales, as
 * Hono and others would route it.
 */
export function normalizePath(path: string): string {
  const segs = path.split("/").filter((s, i, a) => s !== "" || i === 0 || i === a.length - 1);
  return segs
    .map((s) => {
      try {
        return decodeURIComponent(s.replace(/%2f/gi, "%252F")).replace(/%2F/g, "%2F");
      } catch {
        return s;
      }
    })
    .join("/")
    .replace(/\/{2,}/g, "/");
}

/** Dispatch for `dispatch: { mode: "http" }`, or the adapter's in-process one. */
export function chooseDispatcher(config: AgentifyConfig, inProcess: Dispatcher): Dispatcher {
  if (config.dispatch?.mode === "http") {
    const target = config.dispatch.url ?? config.baseUrl!;
    const sameApp = config.baseUrl ? originOf(target) === originOf(config.baseUrl) : undefined;
    return httpDispatcher(target, config.fetch ?? fetch, 30_000, sameApp || undefined);
  }
  return inProcess;
}

export type { ToolDefinition };
