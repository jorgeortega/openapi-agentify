import type { Context, MiddlewareHandler } from "hono";
import type { AgentifyConfig } from "../config.js";
import { type Agentify, chooseDispatcher, type RequestContext } from "../core.js";
import { applyFinish, contentLength, readBodyCapped, toAgentify } from "./shared.js";

/**
 * Hono:
 *
 *   const app = new Hono();
 *   app.use(agentify(config, { app }));   // before your routes
 *
 * `app` is where tool calls go: `app.fetch(request)`, in-process, with the
 * same `env` as the MCP request (so getConnInfo and bindings still work).
 */

interface FetchApp {
  fetch: (request: Request, env?: any, executionCtx?: any) => Response | Promise<Response>;
}

function clientIp(c: Context): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? null;
}

/** On Node (@hono/node-server) the path exactly as sent; elsewhere the parsed one. */
function rawPath(c: Context): string | undefined {
  const env = c.env as { incoming?: { url?: string } } | undefined;
  return typeof env?.incoming?.url === "string" ? env.incoming.url : undefined;
}

/**
 * The env a tool call runs with: your bindings as they are, but on Node not the /mcp
 * request's own `incoming`/`outgoing` (its headers are the caller's, its response is the
 * MCP reply). `incoming` becomes a stand-in for the dispatched request, so getConnInfo()
 * still finds the caller's address.
 */
export function dispatchEnv(env: unknown, request: Request, remoteAddress: string | null): unknown {
  if (!env || typeof env !== "object" || !("incoming" in env || "outgoing" in env)) return env;
  const { incoming: _incoming, outgoing: _outgoing, ...rest } = env as Record<string, unknown>;
  const u = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => (headers[k] = v));
  return {
    ...rest,
    incoming: {
      method: request.method,
      url: `${u.pathname}${u.search}`,
      headers,
      socket: { remoteAddress: remoteAddress ?? "127.0.0.1", remotePort: 0, remoteFamily: remoteAddress?.includes(":") ? "IPv6" : "IPv4" },
    },
  };
}

export function agentify(config: AgentifyConfig | Agentify, opts: { app: FetchApp }): MiddlewareHandler {
  if (!opts?.app || typeof opts.app.fetch !== "function") throw new Error("agentify (hono): pass { app } — the Hono app tool calls are dispatched to");
  const ag = toAgentify(config);
  return async (c, next) => {
    let execution: unknown;
    try {
      execution = c.executionCtx;
    } catch {
      execution = undefined; // Node: no ExecutionContext
    }
    const inProcess = async (request: Request, info: { remoteAddress: string | null }) => opts.app.fetch(request, dispatchEnv(c.env, request, info.remoteAddress), execution);
    const ctx: RequestContext = {
      dispatch: chooseDispatcher(ag.config, inProcess),
      ip: clientIp(c),
      rawPath: rawPath(c),
      readBody: () => readBodyCapped(c.req.raw),
    };
    const surface = await ag.handle(c.req.raw, ctx);
    if (surface) return surface;

    const g = await ag.guard(c.req.raw, ctx);
    if (g.action === "respond") return g.response;
    if (g.removeHeaders.length || Object.keys(g.setHeaders).length) {
      const headers = new Headers(c.req.raw.headers);
      for (const h of g.removeHeaders) headers.delete(h);
      for (const [k, v] of Object.entries(g.setHeaders)) headers.set(k, v);
      const init: RequestInit & { duplex?: "half" } = { headers };
      if (c.req.raw.body) init.duplex = "half";
      c.req.raw = new Request(c.req.raw, init);
    }

    await next();

    const res = c.res;
    if (g.buffer && g.finish) {
      const body = new Uint8Array(await res.arrayBuffer());
      const out = await g.finish({ status: res.status, headers: res.headers, body, bytes: body.byteLength });
      // Clear first: Hono's c.res setter would otherwise copy the old headers onto the new response.
      c.res = undefined as unknown as Response;
      c.res = await applyFinish(res, body, out, g.responseHeaders);
      return;
    }
    if (Object.keys(g.responseHeaders).length) {
      try {
        for (const [k, v] of Object.entries(g.responseHeaders)) c.res.headers.set(k, v);
      } catch {
        // A response with immutable headers (e.g. straight from fetch()): copy it.
        const copy = new Response(res.body, res);
        for (const [k, v] of Object.entries(g.responseHeaders)) copy.headers.set(k, v);
        c.res = undefined as unknown as Response;
        c.res = copy;
      }
    }
    if (g.finish) await g.finish({ status: res.status, headers: res.headers, body: null, bytes: contentLength(res.headers) });
  };
}

export type { Agentify };
