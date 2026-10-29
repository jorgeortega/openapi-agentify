import type { AgentifyHooks } from "./hooks.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { Manifest } from "./openapi/manifest.js";
import type { ToolDefinition } from "./mcp/tools.js";
import type { Logger } from "./util/log.js";

/**
 * `agentify.config.ts`: one object that decides every agent-facing surface.
 *
 *   export default defineConfig({ name: "Acme Orders API", spec: "./openapi.yaml", … });
 */

export interface AuthConfig {
  /**
   * Agents send the credentials your API already accepts; tool calls forward
   * them, and your API's auth decides. Other ways to authenticate agents
   * (your own keys, OAuth) plug in through `hooks.authenticate`.
   */
  mode: "passthrough";
  /** Request headers forwarded to your routes. Default: authorization plus the spec's apiKey headers. */
  forward?: string[];
}

export interface SurfacesConfig {
  mcp?: boolean;
  openapi?: boolean;
  llmsTxt?: boolean;
  serverCard?: boolean;
  /** `/.well-known/mcp.json`, the server card at the earlier drafts' address. */
  serverCardAlias?: boolean;
  aiCatalog?: boolean;
  agentIndex?: boolean;
  /** `Link:` headers on your API root pointing at llms.txt and the server card. */
  linkHeaders?: boolean;
  /** Serve /robots.txt with an llms.txt hint (off: most apps have their own). */
  robots?: boolean;
}

export interface AgentifyConfig {
  name: string;
  description?: string;
  /** Your API's version (MCP serverInfo, server card). Default: the spec's info.version. */
  version?: string;
  /** Canonical origin for discovery documents, e.g. https://api.acme.com. */
  baseUrl?: string;
  /** OpenAPI file (JSON/YAML), a URL, "app:/docs/json" (fetched from your app in-process), or the document. */
  spec?: string | Record<string, unknown>;
  /** agentify.tools.json (path or object). Default "./agentify.tools.json"; built from the spec if missing. */
  tools?: string | Manifest;
  /** Tools that aren't routes, written with defineTool(). */
  codeTools?: ToolDefinition[];
  /** Folder relative paths resolve against. Default process.cwd(). */
  root?: string;
  auth?: AuthConfig;
  /**
   * Callers with no credentials: "allow" (default: your API decides) or
   * "deny" (/mcp answers 401).
   */
  anonymous?: "allow" | "deny";
  surfaces?: SurfacesConfig;
  detect?: {
    /** "default" (the dated list in src/detect.ts), your own list, or false. */
    userAgents?: "default" | string[] | false;
    /** Paths the route guard runs on, e.g. ["/v1/*"]. Default: every path. */
    include?: string[];
    exclude?: string[];
  };
  /**
   * "in-process" (default): tool calls go straight into your app.
   * "http": a loopback request to `url` (a separate process, another language).
   */
  dispatch?: { mode: "in-process" | "http"; url?: string };
  /**
   * Honour Idempotency-Key on agent POST/PATCH calls to operations in
   * agentify.tools.json (default true). Records are kept in memory unless you
   * pass a `store` shared by your instances.
   */
  idempotency?: boolean | { ttlSeconds?: number; store?: IdempotencyStore };
  /** Browser origins allowed to call /mcp (DNS-rebinding guard). baseUrl's origin is always allowed. */
  allowedOrigins?: string[];
  /** Trust X-Forwarded-For/-Proto/-Host (behind a proxy you run). Default false. */
  trustProxy?: boolean | number;
  /** Max bytes read from your app's response for a tool result (default 1 MiB). */
  maxResponseBytes?: number;
  /**
   * The most values a tool call's arguments may hold, counting every object, array,
   * string, number, boolean and null at any depth (default 10,000). More is refused
   * as invalid_input before the input schema runs.
   */
  maxArgumentValues?: number;
  /** Shown to MCP clients (initialize / server/discover). */
  instructions?: string;
  /** Extension points: authentication, tool-call and route hooks, extra documents. See docs/extending.md. */
  hooks?: AgentifyHooks | AgentifyHooks[];
  logger?: Logger;
  logLevel?: "debug" | "info" | "warn" | "error" | "silent";
  /** Tests: a clock, and a fetch for remote specs and `dispatch: http`. */
  now?: () => number;
  fetch?: typeof fetch;
}

/** Types your config and returns it unchanged. */
export function defineConfig<C extends AgentifyConfig>(config: C): C {
  return config;
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new Error(`"${url}" is not an absolute URL`);
  }
}

/**
 * Checks that can fail at startup, so a misconfiguration refuses to start
 * instead of leaking credentials later.
 */
export function validateConfig(config: AgentifyConfig): string[] {
  const warnings: string[] = [];
  if (!config.name?.trim()) throw new Error("agentify: `name` is required");
  if (config.baseUrl !== undefined) {
    const u = new URL(config.baseUrl);
    if (u.pathname !== "/" && u.pathname !== "") throw new Error(`agentify: baseUrl must be an origin (got path ${u.pathname}); mount Agentify on the app at /`);
  }
  const mode = config.auth?.mode ?? "passthrough";
  if (mode !== "passthrough") throw new Error(`agentify: auth.mode "${mode}" isn't built in: use "passthrough", and hooks.authenticate for anything else`);
  if (config.dispatch?.mode === "http") {
    const target = config.dispatch.url ?? config.baseUrl;
    if (!target) throw new Error("agentify: dispatch.mode http needs dispatch.url (or baseUrl)");
    // Forwarding an agent's own credential is safe only to the same resource.
    if (!config.baseUrl) throw new Error("agentify: passthrough with dispatch http needs baseUrl, to check the target is this same API");
    if (originOf(target) !== originOf(config.baseUrl) && !isLoopback(target)) {
      throw new Error(
        `agentify: passthrough refuses to start: dispatch.url (${originOf(target)}) is not baseUrl's origin (${originOf(config.baseUrl)}). ` +
          "Forwarding agents' credentials is only safe to the same API.",
      );
    }
  }
  const anon = config.anonymous as string | undefined;
  if (anon !== undefined && anon !== "allow" && anon !== "deny") throw new Error(`agentify: anonymous "${anon}" isn't built in: use "allow" or "deny" (and hooks for anything else)`);
  const most = config.maxArgumentValues;
  if (most !== undefined && !(Number.isSafeInteger(most) && most >= 1)) throw new Error("agentify: maxArgumentValues must be a whole number, 1 or more");
  if (!config.baseUrl) warnings.push("baseUrl is not set: discovery documents use each request's own origin, and /mcp only accepts browser (Origin) requests from localhost pages. Set it in production.");
  return warnings;
}

export function isLoopback(url: string): boolean {
  const h = new URL(url).hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}
