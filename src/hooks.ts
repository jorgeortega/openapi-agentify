import type { Detection } from "./detect.js";
import type { CallStatus, JsonSchemaObject, ToolAnnotations, ToolDefinition, ToolOutput } from "./mcp/tools.js";
import type { Json } from "./openapi/load.js";
import type { Manifest, ManifestTool } from "./openapi/manifest.js";
import type { Principal } from "./principal.js";
import type { Doc, SurfaceModel } from "./surfaces/model.js";
import type { Logger } from "./util/log.js";

/**
 * Extension points. With no hooks, Agentify serves /mcp and the discovery
 * documents, runs every tool call in-process through your own routes and auth
 * middleware, and leaves who-may-do-what to your API. Hooks add what a
 * deployment needs on top: its own credentials (API keys, OAuth), rate limits,
 * usage metering, payments, extra discovery documents.
 *
 *   agentify({ ...config, hooks: { authenticate, beforeToolCall, afterToolCall } })
 *
 * `hooks` may be one object or an array; an array runs in order (see
 * `composeHooks` for exactly how). docs/extending.md has worked examples.
 */
export interface AgentifyHooks {
  /** Called once when Agentify loads (the first request, or `ready()`): open stores, read secrets. */
  setup?(ctx: SetupContext): void | Promise<void>;
  /** Called by `close()`. */
  close?(): void | Promise<void>;

  // ── /mcp ────────────────────────────────────────────────────────────────

  /**
   * Who is calling /mcp. Return a Principal to accept the caller, a Response to
   * refuse (a 401 with a challenge, say), or null/undefined for the built-in
   * behaviour: forward the credentials your API accepts (passthrough), else
   * anonymous (refused with 401 when `anonymous: "deny"`).
   */
  authenticate?(request: Request, info: AuthenticateInfo): Promise<Principal | Response | null | undefined> | Principal | Response | null | undefined;
  /** Whether `principal` sees `tool` in tools/list and may call it. undefined: the built-in rule (scopes). */
  toolVisible?(tool: ToolDefinition, principal: Principal): boolean | undefined;
  /** Changes one tools/list entry for this caller (a price note in the description, `_meta`). */
  listTool?(listing: ToolListing, tool: ToolDefinition, principal: Principal): ToolListing;
  /** `_meta` for the `server/discover` result (2026-07-28). */
  serverMeta?(): Record<string, unknown> | undefined;
  /** Extra request headers browsers may send to /mcp (CORS), e.g. ["Payment-Signature"]. */
  mcpRequestHeaders?: string[];
  /**
   * Runs before a tool call is dispatched, after its arguments are validated.
   * Return `{ refuse }` to stop it (a rate limit, a payment required), or
   * `{ headers }` to add headers to the in-process request (a service
   * credential, who paid). `call.state` is yours, and reaches `afterToolCall`.
   */
  beforeToolCall?(call: ToolCall): Promise<BeforeToolCallResult> | BeforeToolCallResult;
  /**
   * Runs after every tools/call that named a known tool, whatever happened
   * (refused, invalid input, ran). Return `{ output }` to replace what the
   * agent gets (withhold a result), `{ meta }` to add result `_meta` (a
   * receipt). Use it to meter usage, settle payments, audit.
   */
  afterToolCall?(call: ToolCall, result: ToolCallResult): Promise<AfterToolCallResult> | AfterToolCallResult;

  // ── Your own routes ─────────────────────────────────────────────────────

  /**
   * Runs on every request to your own routes (inside `detect.include`), not
   * on Agentify's own in-process calls. Return `{ respond }` to answer instead
   * of your route (429, 402), or headers to set/remove, a `finish` to run on
   * the response, and the scope `Idempotency-Key` records are kept under.
   */
  guardRoute?(request: Request, info: RouteInfo): Promise<RouteGuardResult> | RouteGuardResult;

  // ── Discovery ───────────────────────────────────────────────────────────

  /** Changes what every discovery document is built from: links, auth text, notes, `extensions`. */
  describe?(model: SurfaceModel): SurfaceModel;
  /** More documents, served like the built-in ones (an ETag, CORS, cached per origin when a Doc). */
  surfaces?: SurfaceExtension[];
}

export interface SetupContext {
  config: import("./config.js").AgentifyConfig;
  spec: Json | null;
  manifest: Manifest;
  logger: Logger;
}

export interface AuthenticateInfo {
  /** The client's IP (behind `trustProxy`, the one your proxy reported). */
  ip: string | null;
  /** This API's origin (baseUrl, else the request's). */
  origin: string;
  /** Where the discovery documents point clients for OAuth metadata, if anywhere (see `describe`). */
  resourceMetadataUrl: string | null;
}

export interface ToolListing {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchemaObject;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

export interface ToolCall {
  tool: ToolDefinition;
  /** The arguments: validated when `beforeToolCall` and a successful `afterToolCall` see them. */
  arguments: unknown;
  principal: Principal;
  requestId: string;
  origin: string;
  ip: string | null;
  userAgent: string | null;
  /** The /mcp request's headers. */
  headers: (name: string) => string | undefined;
  /** The tools/call's `params._meta` (where MCP clients put payments and trace context). */
  meta: Record<string, unknown> | undefined;
  /** Shared by this call's hooks: set it in beforeToolCall, read it in afterToolCall. */
  state: Record<string, unknown>;
}

/** A JSON-RPC error with an HTTP status (429, 403…), or a tool result with isError (402 terms, say). */
export type ToolRefusal =
  | { kind: "error"; status: number; code: number; message: string; data?: unknown; headers?: Record<string, string>; outcome?: string }
  | { kind: "result"; output: ToolOutput; outcome?: string };

export type BeforeToolCallResult = void | undefined | { refuse: ToolRefusal } | { headers?: Record<string, string> };

export interface ToolCallResult {
  /**
   * "ok" and "error" ran; the others didn't: "forbidden" (missing scope),
   * "invalid_input", or a refusal's own outcome ("rate_limited", "payment_required"…).
   */
  outcome: "ok" | "error" | "forbidden" | "invalid_input" | (string & {});
  /** What the agent gets unless a hook replaces it. */
  output: ToolOutput;
  /** The registry's status, when the tool ran. */
  status?: CallStatus;
  /** Ran and answered 2xx (or a code tool returned without error). */
  success: boolean;
  /** Your route's HTTP status, for operation tools. */
  httpStatus?: number;
  latencyMs: number;
  /**
   * Set when the call was cut short (timeout, client gone): the handler's own
   * promise. Your app may still finish the work; the outcome is unknown until
   * this settles.
   */
  pending?: Promise<ToolOutput>;
}

export type AfterToolCallResult = void | undefined | { output?: ToolOutput; meta?: Record<string, unknown> };

export interface RouteInfo {
  /** The URL path. */
  path: string;
  /** The path as the client sent it (before URL parsing tidied it). */
  rawPath: string;
  /** The enabled operation in agentify.tools.json this request is for, if any. */
  operation: ManifestTool | null;
  /** An operation this request matches that is disabled for agents. */
  disabled: ManifestTool | null;
  /** The request is spelled exactly as the spec spells `operation` (safe to hand it a credential). */
  canonical: boolean;
  /** A path routers may resolve differently (dot segments, `//`, encoded slashes). */
  ambiguous: boolean;
  /** User-agent and Web Bot Auth detection. */
  detected: Detection;
  /** Sent a credential your API accepts (a forwarded header) or a cookie. */
  hasCredentials: boolean;
  ip: string | null;
  origin: string;
}

export interface FinishInput {
  status: number;
  headers: Headers;
  /** The response body, when the guard asked for it (`buffer: true`). */
  body: Uint8Array | null;
  bytes: number;
}

export interface FinishOutput {
  /** Send this instead (a settlement failed, so the result is withheld). */
  replace?: Response;
  /** Add these to the response. */
  headers?: Record<string, string>;
}

export type RouteGuardResult =
  | void
  | undefined
  | { respond: Response }
  | {
      setHeaders?: Record<string, string>;
      removeHeaders?: string[];
      responseHeaders?: Record<string, string>;
      /** Hold the response body until `finish` has run. */
      buffer?: boolean;
      /** Called once with your route's response. */
      finish?: (res: FinishInput) => Promise<FinishOutput>;
      /** Whose `Idempotency-Key` namespace this request uses (an API key id, a payer). Default: the credential, cookies, else the IP. */
      idempotencyScope?: string;
      /** Called instead of `finish` when Agentify answers itself after all (an idempotent replay, a reused key). */
      cancel?: () => Promise<void>;
    };

export interface SurfaceExtension {
  /** The exact path, e.g. "/.well-known/oauth-protected-resource". */
  path: string;
  /** Allowed methods besides GET and HEAD (they get 405 otherwise). */
  methods?: string[];
  /** A Doc is cached per origin and served with an ETag and CORS; a Response is sent as is; null is your app's. */
  serve(request: Request, model: SurfaceModel): Doc | Response | null | Promise<Doc | Response | null>;
  /** Doc results are cached per origin unless false (a document that depends on the request). */
  cache?: boolean;
}

/**
 * Several hook sets as one, in order:
 *
 *   setup, close                  each in order
 *   authenticate                  the first that returns a Principal or a Response wins
 *   toolVisible                   the first that returns a boolean wins
 *   listTool, describe            chained in order
 *   serverMeta                    merged
 *   beforeToolCall                in order; the first refusal stops the rest; headers merge
 *   afterToolCall                 in reverse order (the last-added wraps the call);
 *                                 each sees the output the previous one left; metas merge
 *   guardRoute                    in order; the first `respond` stops the rest (earlier
 *                                 ones are cancelled); headers merge; finishes run in reverse
 *   surfaces, mcpRequestHeaders   concatenated
 */
export function composeHooks(input: AgentifyHooks | AgentifyHooks[] | undefined): AgentifyHooks {
  const list = (Array.isArray(input) ? input : input ? [input] : []).filter(Boolean);
  if (list.length <= 1) return list[0] ?? {};
  const has = <K extends keyof AgentifyHooks>(k: K) => list.filter((h) => h[k] !== undefined);
  const out: AgentifyHooks = {};
  if (has("setup").length) out.setup = async (ctx) => { for (const h of list) await h.setup?.(ctx); };
  if (has("close").length) out.close = async () => { for (const h of list) await h.close?.(); };
  if (has("authenticate").length) {
    out.authenticate = async (request, info) => {
      for (const h of list) {
        const r = await h.authenticate?.(request, info);
        if (r) return r;
      }
      return null;
    };
  }
  if (has("toolVisible").length) {
    out.toolVisible = (tool, principal) => {
      for (const h of list) {
        const v = h.toolVisible?.(tool, principal);
        if (typeof v === "boolean") return v;
      }
      return undefined;
    };
  }
  if (has("listTool").length) out.listTool = (listing, tool, principal) => list.reduce((l, h) => (h.listTool ? h.listTool(l, tool, principal) : l), listing);
  if (has("describe").length) out.describe = (model) => list.reduce((m, h) => (h.describe ? h.describe(m) : m), model);
  if (has("serverMeta").length) {
    out.serverMeta = () => {
      const merged = Object.assign({}, ...list.map((h) => h.serverMeta?.() ?? {})) as Record<string, unknown>;
      return Object.keys(merged).length ? merged : undefined;
    };
  }
  const extraHeaders = list.flatMap((h) => h.mcpRequestHeaders ?? []);
  if (extraHeaders.length) out.mcpRequestHeaders = extraHeaders;
  const surfaces = list.flatMap((h) => h.surfaces ?? []);
  if (surfaces.length) out.surfaces = surfaces;
  if (has("beforeToolCall").length) {
    out.beforeToolCall = async (call) => {
      const headers: Record<string, string> = {};
      for (const h of list) {
        const r = await h.beforeToolCall?.(call);
        if (r && "refuse" in r) return r;
        if (r?.headers) Object.assign(headers, r.headers);
      }
      return { headers };
    };
  }
  if (has("afterToolCall").length) {
    out.afterToolCall = async (call, result) => {
      let output = result.output;
      let meta: Record<string, unknown> | undefined;
      for (const h of [...list].reverse()) {
        const r = await h.afterToolCall?.(call, { ...result, output });
        if (r?.output) output = r.output;
        if (r?.meta) meta = { ...meta, ...r.meta };
      }
      return { ...(output !== result.output ? { output } : {}), ...(meta ? { meta } : {}) };
    };
  }
  if (has("guardRoute").length) {
    out.guardRoute = async (request, info) => {
      const done: Array<Exclude<RouteGuardResult, void | undefined | { respond: Response }>> = [];
      for (const h of list) {
        const r = await h.guardRoute?.(request, info);
        if (!r) continue;
        if ("respond" in r) {
          for (const d of done.reverse()) await d.cancel?.().catch(() => {});
          return r;
        }
        done.push(r);
      }
      if (!done.length) return undefined;
      const finishes = done.map((d) => d.finish).filter((f): f is NonNullable<typeof f> => Boolean(f));
      const cancels = done.map((d) => d.cancel).filter((f): f is NonNullable<typeof f> => Boolean(f));
      return {
        setHeaders: Object.assign({}, ...done.map((d) => d.setHeaders ?? {})),
        removeHeaders: done.flatMap((d) => d.removeHeaders ?? []),
        responseHeaders: Object.assign({}, ...done.map((d) => d.responseHeaders ?? {})),
        buffer: done.some((d) => d.buffer),
        idempotencyScope: done.map((d) => d.idempotencyScope).find(Boolean),
        ...(finishes.length
          ? {
              finish: async (res: FinishInput) => {
                let merged: FinishOutput = {};
                for (const f of [...finishes].reverse()) {
                  const o = await f(res);
                  if (o.replace) merged = { ...merged, replace: o.replace };
                  if (o.headers) merged = { ...merged, headers: { ...merged.headers, ...o.headers } };
                }
                return merged;
              },
            }
          : {}),
        ...(cancels.length ? { cancel: async () => { for (const c of [...cancels].reverse()) await c().catch(() => {}); } } : {}),
      };
    };
  }
  return out;
}
