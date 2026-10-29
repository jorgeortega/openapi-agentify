import type { AgentifyHooks, ToolCall, ToolCallResult, ToolListing, ToolRefusal } from "../hooks.js";
import { bearerChallenge, hasScope, type Principal } from "../principal.js";
import type { Logger } from "../util/log.js";
import {
  detectEra,
  type Era,
  ErrorCode,
  type HeaderSource,
  type Id,
  isJsonRpcRequest,
  isLegacyVersion,
  LATEST_LEGACY_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
  META,
  MODERN_VERSIONS,
  ProtocolError,
  rpcError,
  rpcResult,
} from "./protocol.js";
import {
  countValues,
  DEFAULT_MAX_ARGUMENT_VALUES,
  textError,
  type ToolContext,
  type ToolDefinition,
  type ToolOutput,
  type ToolRegistry,
  tooManyValues,
} from "./tools.js";


/**
 * The MCP server core: a pure function of (message, caller) → reply, for both
 * protocol eras:
 *
 *   initialize (2025-xx) · server/discover (2026-07-28) · ping · tools/list · tools/call
 *
 * tools/call, in this order:
 *   visibility → scope (403 step-up) → validate → beforeToolCall hooks →
 *   dispatch into your app → afterToolCall hooks.
 *
 * Arguments are validated before any hook runs, so a malformed call never
 * reaches a rate limiter, a payment or your app.
 */

/** App-level JSON-RPC codes, outside the range JSON-RPC and MCP reserve. */
export const AppErrorCode = { Unauthorized: -31001, Forbidden: -31003, RateLimited: -31029 } as const;

export interface McpServerOptions {
  tools: ToolRegistry;
  name: string;
  version: string;
  instructions?: string;
  /** Anonymous callers: "allow" (your API decides) or "deny". */
  anonymous: "allow" | "deny";
  /** RFC 9728 metadata URL for challenges, when there is one. */
  resourceMetadataUrl: (origin: string) => string | null;
  hooks?: AgentifyHooks;
  listTtlMs?: number;
  /** The most values a tool call's arguments may hold (default DEFAULT_MAX_ARGUMENT_VALUES). */
  maxArgumentValues?: number;
}

/**
 * The scope a tool needs. Operation tools get theirs from agentify.tools.json,
 * or api:read for GET/HEAD and api:write otherwise (operationTool sets it);
 * any other tool without one needs api:write. Callers whose scopes are "*"
 * (passthrough, anonymous) hold every scope: your API decides.
 */
export function requiredScope(tool: ToolDefinition): string {
  return tool.scope ?? "api:write";
}

export interface McpRequestContext {
  principal: Principal;
  logger: Logger;
  requestId: string;
  signal: AbortSignal;
  headers: HeaderSource;
  origin: string;
  userAgent: string | null;
  /** The caller's IP, when known. */
  ip?: string | null;
  now: () => number;
  /** How tools reach your app for this request (built per tool call, with the hooks' extra headers). */
  toolCall: (tool: ToolDefinition, extraHeaders: Record<string, string>) => Pick<ToolContext, "fetchApp" | "call">;
}

export interface McpReply {
  status: number;
  body: JsonRpcResponse | null;
  headers?: Record<string, string>;
}

const reply = (body: JsonRpcResponse | null, status = 200, headers?: Record<string, string>): McpReply => ({ status, body, headers });

export class McpServer {
  constructor(private readonly opts: McpServerOptions) {}

  get serverInfo() {
    return { name: this.opts.name, version: this.opts.version };
  }

  async handle(raw: unknown, ctx: McpRequestContext): Promise<McpReply> {
    if (Array.isArray(raw)) return reply(rpcError(null, ErrorCode.InvalidRequest, "JSON-RPC batching is not supported"), 400);
    if (!isJsonRpcRequest(raw)) {
      const m = raw as Record<string, unknown> | null;
      // A client's JSON-RPC response: we never send requests, so there's nothing to match it to.
      if (m && m.jsonrpc === "2.0" && ("result" in m || "error" in m) && !("method" in m)) return reply(null, 202);
      const id = m && (typeof m.id === "string" || typeof m.id === "number") ? m.id : null;
      return reply(rpcError(id, ErrorCode.InvalidRequest, "Invalid JSON-RPC request"), 400);
    }
    const msg = raw;
    if (!("id" in msg)) return reply(null, 202); // notifications need no answer
    if (msg.id === null || (typeof msg.id !== "string" && typeof msg.id !== "number")) {
      return reply(rpcError(null, ErrorCode.InvalidRequest, "Request id must be a string or number"), 400);
    }
    const id = msg.id;

    let era: Era;
    try {
      era = detectEra(msg, ctx.headers);
    } catch (err) {
      if (err instanceof ProtocolError) return reply(rpcError(id, err.code, err.message, err.data), err.httpStatus);
      throw err;
    }

    const ok = (result: Record<string, unknown>) => reply(rpcResult(id, this.finish(era, result)));
    switch (msg.method) {
      case "initialize":
        return ok(this.initialize(msg));
      case "server/discover":
        return ok(this.discover());
      case "ping":
        return ok({});
      case "tools/list":
        if (msg.params?.cursor !== undefined) return reply(rpcError(id, ErrorCode.InvalidParams, "Invalid cursor"));
        return ok(this.listTools(ctx.principal, era));
      case "tools/call":
        return this.callTool(id, msg, era, ctx);
      default:
        // 2026-07-28: an unknown method is HTTP 404 with -32601.
        return reply(rpcError(id, ErrorCode.MethodNotFound, `Method not found: ${msg.method}`), era.kind === "modern" ? 404 : 200);
    }
  }

  /** Modern results carry resultType and serverInfo in every result. */
  private finish(era: Era, result: Record<string, unknown>): Record<string, unknown> {
    if (era.kind === "legacy") return result;
    const meta = { ...(result._meta as Record<string, unknown> | undefined), [META.serverInfo]: this.serverInfo };
    return { resultType: "complete", ...result, _meta: meta };
  }

  private initialize(msg: JsonRpcRequest) {
    const requested = msg.params?.protocolVersion;
    return {
      protocolVersion: isLegacyVersion(requested) ? requested : LATEST_LEGACY_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.serverInfo,
      ...(this.opts.instructions ? { instructions: this.opts.instructions } : {}),
    };
  }

  private discover() {
    const meta = this.opts.hooks?.serverMeta?.();
    return {
      supportedVersions: [...MODERN_VERSIONS],
      capabilities: { tools: { listChanged: false } },
      ...(this.opts.instructions ? { instructions: this.opts.instructions } : {}),
      ...(meta ? { _meta: meta } : {}),
      ttlMs: this.opts.listTtlMs ?? 300_000,
      cacheScope: "public",
    };
  }

  /**
   * Whether `principal` sees `tool`. A `toolVisible` hook decides first. Then:
   * callers with the scope see it (passthrough and anonymous callers hold "*":
   * your API decides); callers marked `stepUp` (OAuth) also see tools they
   * lack the scope for, and calling one gets a 403 challenge to step up.
   */
  visible(tool: ToolDefinition, principal: Principal): boolean {
    const v = this.opts.hooks?.toolVisible?.(tool, principal);
    if (typeof v === "boolean") return v;
    if (principal.type === "anonymous" && this.opts.anonymous !== "allow") return false;
    return hasScope(principal.scopes, requiredScope(tool)) || Boolean(principal.stepUp);
  }

  private listTools(principal: Principal, era: Era) {
    const listTool = this.opts.hooks?.listTool;
    const tools = this.opts.tools
      .all()
      .filter((t) => this.visible(t, principal))
      .map((t) => {
        const listing: ToolListing = {
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        };
        return listTool ? listTool(listing, t, principal) : listing;
      });
    // The list depends on the caller, so it may only be cached per caller.
    return era.kind === "modern" ? { tools, ttlMs: this.opts.listTtlMs ?? 300_000, cacheScope: "private" } : { tools };
  }

  private async callTool(id: Id, msg: JsonRpcRequest, era: Era, ctx: McpRequestContext): Promise<McpReply> {
    const { principal } = ctx;
    const hooks = this.opts.hooks;
    const name = msg.params?.name;
    if (typeof name !== "string") return reply(rpcError(id, ErrorCode.InvalidParams, "params.name is required"));
    const args = msg.params?.arguments ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) return reply(rpcError(id, ErrorCode.InvalidParams, "params.arguments must be an object"));
    const tool = this.opts.tools.get(name);
    const prm = this.opts.resourceMetadataUrl(ctx.origin);

    // Anonymous callers get the auth challenge for anything they can't call,
    // so clients that support OAuth still discover how to sign in.
    if (principal.type === "anonymous" && (!tool || !this.visible(tool, principal)) && (this.opts.anonymous !== "allow" || tool)) {
      return reply(rpcError(id, AppErrorCode.Unauthorized, "Authentication required"), 401, { "WWW-Authenticate": bearerChallenge(prm) });
    }
    if (!tool || !this.visible(tool, principal)) return reply(rpcError(id, ErrorCode.InvalidParams, `Unknown tool: ${name}`));

    const started = performance.now();
    const call: ToolCall = {
      tool,
      arguments: args,
      principal,
      requestId: ctx.requestId,
      origin: ctx.origin,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent,
      headers: ctx.headers,
      meta: (msg.params?._meta ?? undefined) as Record<string, unknown> | undefined,
      state: {},
    };
    /** Tells afterToolCall hooks what happened, and lets them change what the agent gets. */
    const after = async (result: Omit<ToolCallResult, "latencyMs">): Promise<{ output: ToolOutput; meta?: Record<string, unknown> }> => {
      if (!hooks?.afterToolCall) return { output: result.output };
      try {
        const r = await hooks.afterToolCall(call, { ...result, latencyMs: performance.now() - started });
        return { output: r?.output ?? result.output, meta: r?.meta };
      } catch (err) {
        ctx.logger.error("after_tool_call_failed", { tool: name, err });
        return { output: result.output };
      }
    };

    const scope = requiredScope(tool);
    if (!hasScope(principal.scopes, scope)) {
      await after({ outcome: "forbidden", output: textError(`Missing required scope: ${scope}`), success: false, httpStatus: 403 });
      return reply(rpcError(id, AppErrorCode.Forbidden, `Missing required scope: ${scope}`, { scope }), 403, {
        "WWW-Authenticate": bearerChallenge(prm, { error: "insufficient_scope", scope }),
      });
    }

    // Counted before the schema runs: what checking costs grows with the values.
    const most = this.opts.maxArgumentValues ?? DEFAULT_MAX_ARGUMENT_VALUES;
    const valid = countValues(args, most) > most ? tooManyValues(most) : tool.validate(args);
    if (!valid.ok) {
      const text = `Invalid arguments for ${tool.name}: ${valid.issues.map((i) => `${i.path || "(root)"} ${i.message}`).join("; ")}`;
      const out = await after({ outcome: "invalid_input", output: textError(text, { error: "invalid_input", issues: valid.issues }), success: false, httpStatus: 400 });
      return this.toolReply(id, era, out.output, out.meta);
    }
    call.arguments = valid.value;

    let extraHeaders: Record<string, string> = {};
    if (hooks?.beforeToolCall) {
      const r = await hooks.beforeToolCall(call);
      if (r && "refuse" in r) return this.refused(id, era, r.refuse, after);
      if (r?.headers) extraHeaders = r.headers;
    }

    const res = await this.opts.tools.call(tool, valid.value, {
      principal,
      requestId: ctx.requestId,
      signal: ctx.signal,
      logger: ctx.logger,
      ...ctx.toolCall(tool, extraHeaders),
    });
    const success = res.status === "ok" && (res.output.status === undefined || (res.output.status >= 200 && res.output.status < 300));
    const out = await after({
      outcome: success ? "ok" : "error",
      output: res.output,
      status: res.status,
      success,
      httpStatus: res.output.status,
      ...(res.pending ? { pending: res.pending } : {}),
    });
    ctx.logger.info("tool_call", { tool: name, status: res.status, http_status: res.output.status, duration_ms: Math.round(performance.now() - started) });
    return this.toolReply(id, era, out.output, out.meta);
  }

  private async refused(
    id: Id,
    era: Era,
    r: ToolRefusal,
    after: (result: Omit<ToolCallResult, "latencyMs">) => Promise<{ output: ToolOutput; meta?: Record<string, unknown> }>,
  ): Promise<McpReply> {
    if (r.kind === "result") {
      const out = await after({ outcome: r.outcome ?? "refused", output: r.output, success: false });
      return this.toolReply(id, era, out.output, out.meta);
    }
    await after({ outcome: r.outcome ?? "refused", output: textError(r.message, r.data === undefined ? undefined : r.data), success: false, httpStatus: r.status });
    return reply(rpcError(id, r.code, r.message, r.data), r.status, r.headers);
  }

  private toolReply(id: Id, era: Era, output: ToolOutput, meta?: Record<string, unknown>): McpReply {
    const structured = output.structuredContent;
    // Before 2026-07-28, structuredContent had to be an object.
    const keepStructured = structured !== undefined && (era.kind === "modern" || (structured !== null && typeof structured === "object" && !Array.isArray(structured)));
    const result: Record<string, unknown> = {
      content: output.content,
      ...(keepStructured ? { structuredContent: structured } : {}),
      isError: Boolean(output.isError),
      ...(meta ? { _meta: meta } : {}),
    };
    return reply(rpcResult(id, this.finish(era, result)));
  }
}
