import type { IncomingMessage, OutgoingHttpHeaders, RequestListener, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { injectNode } from "./node-inject.js";
import type { AgentifyConfig } from "../config.js";
import { type Agentify, chooseDispatcher, type GuardResult, type RequestContext } from "../core.js";
import type { Dispatcher } from "../dispatch.js";
import { headersToObject, toAgentify } from "./shared.js";

/**
 * Express 4 and 5:
 *
 *   const app = express();
 *   app.use(agentify(config));   // before your routes
 *
 * Tool calls are dispatched into the app itself (node-inject.ts): an
 * in-memory request through your whole middleware stack, no port. The
 * injected request carries the agent's IP as its remote address.
 */

type Req = IncomingMessage & { app?: any; originalUrl?: string; body?: unknown; protocol?: string };
type Next = (err?: unknown) => void;

/** The app at the top of the mount chain: tool paths are absolute. */
function rootApp(req: Req): RequestListener {
  let app = req.app;
  while (app?.parent) app = app.parent;
  if (typeof app !== "function") throw new Error("agentify (express): req.app is missing; mount agentify with app.use()");
  return app as RequestListener;
}

export function expressDispatcher(appFor: () => RequestListener, maxBytes?: number): Dispatcher {
  // +1 so the tool result can tell a response was cut.
  return (request, info) => injectNode(appFor(), request, { remoteAddress: info.remoteAddress, maxBytes: maxBytes === undefined ? undefined : maxBytes + 1 });
}

function fetchUrl(req: Req): string {
  const proto = req.protocol ?? ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  return `${proto}://${req.headers.host ?? "localhost"}${req.originalUrl ?? req.url ?? "/"}`;
}

function fetchHeaders(req: Req): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) h.append(k, x);
    else h.set(k, v);
  }
  return h;
}

/** The request as Fetch, with its body when we own it (surfaces). */
function toRequest(req: Req, withBody: boolean): Request {
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers: fetchHeaders(req) };
  if (withBody && method !== "GET" && method !== "HEAD") {
    if (req.body !== undefined && (req as { _body?: boolean })._body !== false && typeof req.body === "object" && req.body !== null && !Buffer.isBuffer(req.body)) {
      // A body parser ran before us: re-serialise what it parsed.
      init.body = JSON.stringify(req.body);
    } else if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
      init.body = req.body as string;
    } else if (!req.readableEnded) {
      init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
      init.duplex = "half";
    }
  }
  return new Request(fetchUrl(req), init);
}

async function sendFetch(res: ServerResponse, response: Response, method: string): Promise<void> {
  res.statusCode = response.status;
  for (const [k, v] of Object.entries(headersToObject(response.headers))) res.setHeader(k, v);
  if (!response.body || method === "HEAD") {
    res.end();
    return;
  }
  res.end(Buffer.from(await response.arrayBuffer()));
}

const MAX_PREREAD = 1024 * 1024;

/**
 * Idempotency needs the body before your routes run, and a Node request can
 * be read once. So we read the raw bytes (up to 1 MiB) and put them back at
 * the front of the stream (`unshift`) before it ends: your own body parser
 * then reads the request exactly as the client sent it, with its own limit,
 * its `verify` hook and its error handling. Agentify never parses or sets
 * req.body. Past 1 MiB we stop, put back what we read, and hash nothing.
 */
export function prereadBody(req: IncomingMessage, max = MAX_PREREAD): Promise<Buffer | null> {
  if (req.readableEnded || req.destroyed) return Promise.resolve(null);
  if (Number(req.headers["content-length"] ?? "0") > max) return Promise.resolve(null);
  if (!req.headers["transfer-encoding"] && !Number(req.headers["content-length"] ?? "0")) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (full: boolean) => {
      if (settled) return;
      settled = true;
      req.removeListener("readable", onReadable);
      req.removeListener("error", onError);
      req.removeListener("close", onError);
      const head = Buffer.concat(chunks);
      // Back at the front of the stream: 'end' hasn't fired (it waits for the buffer to drain).
      if (head.length && !req.readableEnded && !req.destroyed) req.unshift(head);
      resolve(full ? head : null);
    };
    const onError = () => done(false);
    const ended = () => req.complete || Boolean((req as unknown as { _readableState?: { ended?: boolean } })._readableState?.ended);
    const onReadable = () => {
      for (let chunk = req.read() as Buffer | null; chunk !== null; chunk = req.read() as Buffer | null) {
        chunks.push(chunk);
        size += chunk.length;
        if (size > max) return done(false);
      }
      // The whole message has arrived and we've taken all of it.
      if (ended()) done(true);
    };
    req.on("readable", onReadable);
    req.on("error", onError);
    req.on("close", onError);
  });
}

function bodyReader(req: Req): () => Promise<Uint8Array | null> {
  let read: Promise<Buffer | null> | null = null;
  return () => {
    // A body parser mounted before Agentify already took the stream: use what it kept.
    const r = req as { rawBody?: unknown; _body?: boolean };
    if (Buffer.isBuffer(r.rawBody)) return Promise.resolve(r.rawBody);
    if (r._body || (req.readableEnded && req.body !== undefined)) return Promise.resolve(req.body === undefined ? null : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body)));
    read ??= prereadBody(req);
    return read;
  };
}

function applyRequestHeaders(req: Req, g: Extract<GuardResult, { action: "continue" }>) {
  if (!g.removeHeaders.length && !Object.keys(g.setHeaders).length) return;
  const drop = new Set([...g.removeHeaders, ...Object.keys(g.setHeaders)].map((h) => h.toLowerCase()));
  for (const h of g.removeHeaders) delete req.headers[h.toLowerCase()];
  for (const [k, v] of Object.entries(g.setHeaders)) req.headers[k.toLowerCase()] = v;
  // Keep rawHeaders in step, for middleware that reads them.
  const raw: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (!drop.has(req.rawHeaders[i]!.toLowerCase())) raw.push(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  for (const [k, v] of Object.entries(g.setHeaders)) raw.push(k, v);
  req.rawHeaders.splice(0, req.rawHeaders.length, ...raw);
}

/** Holds the response until finish() says what to send (a hook may replace it). */
function bufferResponse(req: Req, res: ServerResponse, g: Extract<GuardResult, { action: "continue" }>) {
  const original = { write: res.write, end: res.end, writeHead: res.writeHead };
  const chunks: Buffer[] = [];
  let pendingHead: { status: number; message?: string; headers?: OutgoingHttpHeaders } | null = null;
  const toBuf = (chunk: unknown, encoding?: unknown) =>
    chunk === undefined || chunk === null || typeof chunk === "function" ? null : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");

  res.writeHead = function (status: number, ...rest: unknown[]) {
    const [a, b] = rest;
    pendingHead = { status, message: typeof a === "string" ? a : undefined, headers: (typeof a === "object" ? a : b) as OutgoingHttpHeaders | undefined };
    return res;
  } as typeof res.writeHead;
  res.write = function (chunk: unknown, encoding?: unknown, cb?: unknown) {
    const b = toBuf(chunk, encoding);
    if (b) chunks.push(b);
    if (typeof encoding === "function") encoding();
    else if (typeof cb === "function") cb();
    return true;
  } as typeof res.write;
  res.end = function (chunk?: unknown, encoding?: unknown, cb?: unknown) {
    const b = toBuf(chunk, encoding);
    if (b) chunks.push(b);
    const done = typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : cb;
    res.write = original.write;
    res.end = original.end;
    res.writeHead = original.writeHead;
    const body = Buffer.concat(chunks);
    const status = pendingHead?.status ?? res.statusCode;
    if (pendingHead?.headers) for (const [k, v] of Object.entries(pendingHead.headers)) if (v !== undefined) res.setHeader(k, v as string);
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.getHeaders())) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
    g.finish!({ status, headers, body, bytes: body.length })
      .then(async (out) => {
        if (out.replace) {
          for (const name of res.getHeaderNames()) res.removeHeader(name);
          await sendFetch(res, out.replace, req.method ?? "GET");
        } else {
          for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
          res.removeHeader("content-length");
          res.statusCode = status;
          if (pendingHead?.message) res.statusMessage = pendingHead.message;
          (original.end as (...a: unknown[]) => unknown).call(res, req.method === "HEAD" ? undefined : body);
        }
        if (typeof done === "function") (done as () => void)();
      })
      .catch((err) => {
        res.statusCode = 500;
        (original.end as (...a: unknown[]) => unknown).call(res, "Internal Server Error");
        console.error("agentify: finishing the response failed", err);
      });
    return res;
  } as typeof res.end;
}

export function agentify(config: AgentifyConfig | Agentify) {
  const ag = toAgentify(config);
  return function agentifyMiddleware(req: Req, res: ServerResponse, next: Next) {
    const appFor = () => rootApp(req);
    const ctx: RequestContext = {
      dispatch: chooseDispatcher(ag.config, expressDispatcher(appFor, ag.config.maxResponseBytes ?? 1024 * 1024)),
      ip: req.socket?.remoteAddress ?? null,
      readBody: bodyReader(req),
      rawPath: req.originalUrl ?? req.url,
    };
    (async () => {
      const path = (req.originalUrl ?? req.url ?? "/").split("?")[0]!.replace(/(.)\/+$/, "$1");
      if (ag.surfacePaths().includes(path)) {
        const surface = await ag.handle(toRequest(req, true), ctx);
        if (surface) return sendFetch(res, surface, req.method ?? "GET");
      }
      const g = await ag.guard(toRequest(req, false), ctx);
      if (g.action === "respond") return sendFetch(res, g.response, req.method ?? "GET");
      applyRequestHeaders(req, g);
      for (const [k, v] of Object.entries(g.responseHeaders)) res.setHeader(k, v);
      if (g.buffer && g.finish) bufferResponse(req, res, g);
      else if (g.finish) {
        const finish = g.finish;
        res.once("finish", () => {
          finish({ status: res.statusCode, headers: new Headers(), body: null, bytes: Number(res.getHeader("content-length") ?? 0) }).catch(() => {});
        });
      }
      next();
    })().catch(next);
  };
}

export type { Agentify };
