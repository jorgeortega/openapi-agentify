import type { AgentifyConfig } from "../config.js";
import { type Agentify, chooseDispatcher, type RequestContext } from "../core.js";
import { type Dispatcher, INTERNAL_HEADER } from "../dispatch.js";
import { applyFinish, contentLength, readBodyCapped, toAgentify } from "./shared.js";

/**
 * Next.js App Router (15 and 16):
 *
 *   // lib/agentify.ts
 *   export const ag = agentifyNext(config, { routes });     // routes: agentify.routes.ts (init writes it)
 *
 *   // app/[...agentify]/route.ts: the surfaces (/mcp, /llms.txt, /.well-known/…)
 *   export const { GET, POST, OPTIONS, DELETE } = ag.routes;
 *
 *   // app/v1/orders/[id]/route.ts: your handlers, wrapped
 *   export const GET = ag.wrap(async (req, { params }) => { … });
 *
 * Tool calls go straight to the route module's exported function (with
 * `params` as a Promise, as Next 15+ passes them). They don't pass through
 * proxy.ts / middleware.ts: if your auth lives there, use dispatch "http".
 * The wrapper is where detection, Idempotency-Key and your `guardRoute` hook
 * run: a proxy can't see the response, so it can't act on it (cache an
 * idempotent answer, settle a payment only on success).
 */

type Params = Record<string, string | string[]>;
type Handler = (request: Request, context: { params: Promise<any> }) => Response | Promise<Response>;
type RouteModule = Partial<Record<"GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS", Handler>>;
export type NextRoutes = Record<string, RouteModule | (() => Promise<RouteModule>)>;

interface CompiledRoute {
  pattern: string;
  re: RegExp;
  names: Array<{ name: string; catchAll: boolean }>;
  score: number;
  load: () => Promise<RouteModule>;
}

/** "/v1/orders/[id]" → a matcher; "(group)" segments are dropped, "[...slug]" and "[[...slug]]" catch the rest. */
export function compileNextRoute(pattern: string): Omit<CompiledRoute, "load"> {
  const names: CompiledRoute["names"] = [];
  let score = 0;
  const parts = pattern
    .split("/")
    .filter((p) => p && !/^\(.*\)$/.test(p))
    .map((p) => {
      let m = /^\[\[\.\.\.(\w+)\]\]$/.exec(p);
      if (m) {
        names.push({ name: m[1]!, catchAll: true });
        return "(?:/(.*))?";
      }
      m = /^\[\.\.\.(\w+)\]$/.exec(p);
      if (m) {
        names.push({ name: m[1]!, catchAll: true });
        return "/(.+)";
      }
      m = /^\[(\w+)\]$/.exec(p);
      if (m) {
        names.push({ name: m[1]!, catchAll: false });
        score += 1;
        return "/([^/]+)";
      }
      score += 10;
      return `/${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    });
  return { pattern, re: new RegExp(`^${parts.join("") || "/"}/?$`), names, score };
}

export function nextDispatcher(routes: NextRoutes): Dispatcher {
  const compiled: CompiledRoute[] = Object.entries(routes)
    .map(([pattern, mod]) => ({ ...compileNextRoute(pattern), load: typeof mod === "function" ? (mod as () => Promise<RouteModule>) : async () => mod as RouteModule }))
    .sort((a, b) => b.score - a.score);
  return async (request) => {
    const path = new URL(request.url).pathname;
    for (const r of compiled) {
      const m = r.re.exec(path);
      if (!m) continue;
      const params: Params = {};
      r.names.forEach((n, i) => {
        const raw = m[i + 1];
        if (raw === undefined) return;
        params[n.name] = n.catchAll ? raw.split("/").map((s) => decodeURIComponent(s)) : decodeURIComponent(raw);
      });
      const mod = await r.load();
      const method = request.method as keyof RouteModule;
      const fn = mod[method] ?? (method === "HEAD" ? mod.GET : undefined);
      if (!fn) return new Response(null, { status: 405 });
      // The in-process marker never reaches a handler (wrapped or not): it's carried beside
      // the request, and wrap() hands it to the guard, which checks it.
      const marker = request.headers.get(INTERNAL_HEADER);
      let req = request;
      if (marker) {
        const headers = new Headers(request.headers);
        headers.delete(INTERNAL_HEADER);
        req = cloneWith(request, headers);
      }
      const nreq = await asNextRequest(req);
      if (marker) markers.set(nreq, marker);
      return fn(nreq, { params: Promise.resolve(params) });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}

const markers = new WeakMap<Request, string>();

function cloneWith(request: Request, headers: Headers): Request {
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, signal: request.signal };
  if (request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(request.url, init);
}

let NextRequestClass: (new (input: Request | string, init?: RequestInit) => Request) | null | undefined;

/** Your handlers may use req.nextUrl: give them a NextRequest when next is installed. */
async function asNextRequest(request: Request): Promise<Request> {
  if (NextRequestClass === undefined) {
    try {
      const specifier = "next/server"; // a variable: the adapter doesn't need Next's types
      NextRequestClass = ((await import(specifier)) as { NextRequest?: typeof NextRequestClass }).NextRequest ?? null;
    } catch {
      NextRequestClass = null;
    }
  }
  if (!NextRequestClass || request.constructor === NextRequestClass) return request;
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers: request.headers, signal: request.signal };
  if (request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  return new NextRequestClass(request.url, init);
}

// Next.js removed request.ip. The client address is only in X-Forwarded-For,
// which anyone can send unless a proxy you trust sets it: set `trustProxy: true`
// on Vercel (or behind your own proxy) and the core reads it.
const ipOf = (_request: Request): string | null => null;

export function agentifyNext(config: AgentifyConfig | Agentify, opts: { routes: NextRoutes }) {
  const ag = toAgentify(config);
  const dispatch = chooseDispatcher(ag.config, nextDispatcher(opts.routes ?? {}));
  const ctxFor = (request: Request): RequestContext => ({
    dispatch,
    ip: ipOf(request),
    readBody: () => readBodyCapped(request),
  });

  const surfaces = async (request: Request) => (await ag.handle(request, ctxFor(request))) ?? Response.json({ error: "not_found" }, { status: 404 });

  function wrap<C extends { params: Promise<any> }>(handler: (request: any, context: C) => Response | Promise<Response>) {
    return async (request: Request, context: C): Promise<Response> => {
      const ctx = ctxFor(request);
      const marker = markers.get(request);
      let guardRequest = request;
      if (marker) {
        const h = new Headers(request.headers);
        h.set(INTERNAL_HEADER, marker);
        guardRequest = new Request(request.url, { method: request.method, headers: h });
      }
      const g = await ag.guard(guardRequest, ctx);
      if (g.action === "respond") return g.response;
      let req = request;
      if (g.removeHeaders.length || Object.keys(g.setHeaders).length) {
        const headers = new Headers(request.headers);
        for (const h of g.removeHeaders) headers.delete(h);
        for (const [k, v] of Object.entries(g.setHeaders)) headers.set(k, v);
        const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, signal: request.signal };
        if (request.body) {
          init.body = request.body;
          init.duplex = "half";
        }
        req = await asNextRequest(new Request(request.url, init));
      }
      const res = await handler(req, context);
      if (g.buffer && g.finish) {
        const body = new Uint8Array(await res.arrayBuffer());
        return applyFinish(res, body, await g.finish({ status: res.status, headers: res.headers, body, bytes: body.byteLength }), g.responseHeaders);
      }
      if (g.finish) await g.finish({ status: res.status, headers: res.headers, body: null, bytes: contentLength(res.headers) });
      if (!Object.keys(g.responseHeaders).length) return res;
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(g.responseHeaders)) headers.set(k, v);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    };
  }

  return {
    agentify: ag,
    /** For app/[...agentify]/route.ts. */
    routes: { GET: surfaces, HEAD: surfaces, POST: surfaces, OPTIONS: surfaces, DELETE: surfaces },
    /** Wraps one of your route handlers with detection, idempotency and the guardRoute hook. */
    wrap,
  };
}

export type { Agentify };
