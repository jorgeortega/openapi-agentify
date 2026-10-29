import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentifyConfig } from "../config.js";
import { type Agentify, chooseDispatcher, type GuardResult, type RequestContext } from "../core.js";
import type { Dispatcher } from "../dispatch.js";
import { headersToObject, toAgentify } from "./shared.js";

/**
 * Fastify 5:
 *
 *   await app.register(agentifyFastify, config);   // before your routes
 *
 * The surfaces are routes in their own encapsulated context (their own body
 * parser, so your parsers are untouched). The guard runs as global hooks:
 * onRequest (detect, rate-limit, charge), onSend (settle, or withhold the
 * result), onResponse (meter). Tool calls use app.inject().
 */

type Guarded = Extract<GuardResult, { action: "continue" }>;
const GUARD = Symbol("agentify.guard");
const BUFFERED = Symbol("agentify.body");
type Buffered = { head: Buffer; rest: AsyncIterator<unknown> | null; complete: boolean };
type Tagged = FastifyRequest & { [GUARD]?: Guarded; [BUFFERED]?: Buffered };

export function fastifyDispatcher(app: FastifyInstance): Dispatcher {
  return async (request, info) => {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => (headers[k] = v));
    const payload = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const res = await app.inject({
      method: request.method as "GET",
      url: `${url.pathname}${url.search}`,
      authority: url.host,
      headers,
      ...(payload ? { payload } : {}),
      remoteAddress: info.remoteAddress ?? "127.0.0.1",
      payloadAsStream: true,
    });
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const x of v) out.append(k, String(x));
      else out.set(k, String(v));
    }
    const status = res.statusCode;
    const body = status === 204 || status === 304 || request.method === "HEAD" ? null : (Readable.toWeb(res.stream()) as ReadableStream<Uint8Array>);
    return new Response(body, { status, statusText: res.statusMessage, headers: out });
  };
}

function toRequest(req: FastifyRequest, body?: Buffer): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else headers.set(k, String(v));
  }
  const method = req.method;
  return new Request(`${req.protocol}://${req.host}${req.url}`, {
    method,
    headers,
    ...(body && method !== "GET" && method !== "HEAD" ? { body: body as Uint8Array<ArrayBuffer> } : {}),
  });
}

async function send(reply: FastifyReply, response: Response) {
  reply.code(response.status);
  for (const [k, v] of Object.entries(headersToObject(response.headers))) reply.header(k, v);
  return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
}

async function payloadBuffer(payload: unknown): Promise<Buffer> {
  if (payload === null || payload === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(payload)) return payload;
  if (typeof payload === "string") return Buffer.from(payload);
  if (payload instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const c of payload) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
    return Buffer.concat(chunks);
  }
  return Buffer.from(JSON.stringify(payload));
}

const MAX_PREREAD = 1024 * 1024;

async function agentifyPlugin(app: FastifyInstance, opts: AgentifyConfig | { agentify: Agentify }) {
  const ag = toAgentify("agentify" in opts && opts.agentify ? opts.agentify : (opts as AgentifyConfig));
  const dispatch = chooseDispatcher(ag.config, fastifyDispatcher(app));
  const ctxFor = (req: Tagged): RequestContext => ({
    dispatch,
    ip: req.ip ?? null,
    rawPath: req.raw.url,
    readBody: async () => {
      if (req[BUFFERED]) return req[BUFFERED].complete ? req[BUFFERED].head : null;
      const len = Number(req.headers["content-length"] ?? "0");
      if (len > MAX_PREREAD || req.raw.readableEnded) return null;
      // onRequest runs before Fastify reads the body: read it here and hand it back in
      // preParsing. Past 1 MiB, stop reading (no hash) but keep the rest for your route.
      const it = req.raw[Symbol.asyncIterator]();
      const chunks: Buffer[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await it.next();
        if (done) break;
        chunks.push(value as Buffer);
        size += (value as Buffer).length;
        if (size > MAX_PREREAD) {
          req[BUFFERED] = { head: Buffer.concat(chunks), rest: it, complete: false };
          return null;
        }
      }
      req[BUFFERED] = { head: Buffer.concat(chunks), rest: null, complete: true };
      return req[BUFFERED].head;
    },
  });

  // The surfaces, in their own context with a raw-buffer body parser.
  await app.register(async (child) => {
    child.removeAllContentTypeParsers();
    child.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 4 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    for (const url of ag.surfacePaths()) {
      child.route({
        method: ["GET", "POST", "OPTIONS", "DELETE"],
        url,
        handler: async (req, reply) => {
          const response = await ag.handle(toRequest(req, req.body as Buffer | undefined), ctxFor(req as Tagged));
          if (!response) return reply.callNotFound();
          return send(reply, response);
        },
      });
    }
  });

  app.addHook("onRequest", async (req: Tagged, reply) => {
    const path = req.url.split("?")[0]!.replace(/(.)\/+$/, "$1");
    if (ag.surfacePaths().includes(path) && !ag.isInternal(toRequest(req).headers)) return;
    const g = await ag.guard(toRequest(req), ctxFor(req));
    if (g.action === "respond") return send(reply, g.response);
    for (const h of g.removeHeaders) delete req.headers[h.toLowerCase()];
    for (const [k, v] of Object.entries(g.setHeaders)) req.headers[k.toLowerCase()] = v;
    for (const [k, v] of Object.entries(g.responseHeaders)) reply.header(k, v);
    req[GUARD] = g;
  });

  app.addHook("preParsing", async (req: Tagged, _reply, payload) => {
    const b = req[BUFFERED];
    if (!b) return payload;
    const rest = b.rest;
    return Readable.from(
      (async function* () {
        yield b.head;
        if (rest) for (let r = await rest.next(); !r.done; r = await rest.next()) yield r.value as Buffer;
      })(),
    );
  });

  app.addHook("onSend", async (req: Tagged, reply, payload) => {
    const g = req[GUARD];
    if (!g?.buffer || !g.finish) return payload;
    req[GUARD] = { ...g, finish: null }; // finish once
    const body = await payloadBuffer(payload);
    const headers = new Headers();
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
    const out = await g.finish({ status: reply.statusCode, headers, body, bytes: body.length });
    if (out.replace) {
      for (const name of Object.keys(reply.getHeaders())) reply.removeHeader(name);
      reply.code(out.replace.status);
      for (const [k, v] of Object.entries(headersToObject(out.replace.headers))) reply.header(k, v);
      return Buffer.from(await out.replace.arrayBuffer());
    }
    for (const [k, v] of Object.entries(out.headers ?? {})) reply.header(k, v);
    reply.removeHeader("content-length");
    return body;
  });

  app.addHook("onResponse", async (req: Tagged, reply) => {
    const g = req[GUARD];
    if (!g?.finish || g.buffer) return;
    await g.finish({ status: reply.statusCode, headers: new Headers(), body: null, bytes: Number(reply.getHeader("content-length") ?? 0) });
  });
}

// Like fastify-plugin: the hooks apply to the whole app, not just this plugin's context.
(agentifyPlugin as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;
(agentifyPlugin as unknown as Record<symbol, unknown>)[Symbol.for("fastify.display-name")] = "agentify";

export const agentifyFastify = agentifyPlugin;
export default agentifyPlugin;
export type { Agentify };
