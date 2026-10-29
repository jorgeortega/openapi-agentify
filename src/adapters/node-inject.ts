import { IncomingMessage, type RequestListener, ServerResponse } from "node:http";
import { Duplex } from "node:stream";

/**
 * Runs a Node request listener (an Express app) on an in-memory request and
 * collects its response: no port, no socket.
 *
 * Why not light-my-request: when it sees an Express app it re-parents
 * Express's shared request/response prototypes onto its own classes
 * (index.js, "Express.js detection"), which is fine in a test but breaks every
 * later real request in a running server. This does the same job with plain
 * IncomingMessage / ServerResponse objects and leaves the app untouched.
 */

class NullSocket extends Duplex {
  constructor(
    readonly remoteAddress: string,
    readonly encrypted: boolean,
  ) {
    super();
  }
  override _read() {}
  override _write(_chunk: unknown, _enc: string, cb: () => void) {
    cb();
  }
  setTimeout() {
    return this;
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  get remotePort() {
    return 0;
  }
  address() {
    return { address: "127.0.0.1", family: "IPv4", port: 0 };
  }
}

export async function injectNode(handler: RequestListener, request: Request, opts: { remoteAddress?: string | null; maxBytes?: number } = {}): Promise<Response> {
  const url = new URL(request.url);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
  const socket = new NullSocket(opts.remoteAddress ?? "127.0.0.1", url.protocol === "https:");
  const req = new IncomingMessage(socket as never);
  req.method = request.method;
  req.url = `${url.pathname}${url.search}`;
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.httpVersion = "1.1";
  const headers: Record<string, string> = {};
  const raw: string[] = [];
  request.headers.forEach((v, k) => {
    headers[k] = v;
    raw.push(k, v);
  });
  if (!headers.host) {
    headers.host = url.host;
    raw.push("host", url.host);
  }
  if (body && !headers["content-length"]) {
    headers["content-length"] = String(body.length);
    raw.push("content-length", String(body.length));
  }
  req.headers = headers;
  req.rawHeaders = raw;
  if (body?.length) req.push(body);
  // Like Node's HTTP parser: the message is complete, then the stream ends.
  req.complete = true;
  req.push(null);

  const res = new ServerResponse(req);
  const max = opts.maxBytes ?? Number.POSITIVE_INFINITY;
  return new Promise<Response>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const take = (chunk: unknown, encoding?: unknown) => {
      if (chunk === undefined || chunk === null || typeof chunk === "function") return;
      const b = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
      if (size < max) chunks.push(size + b.length > max ? b.subarray(0, max - size) : b);
      size += b.length;
    };
    const finish = () => {
      if (done) return;
      done = true;
      const out = new Headers();
      for (const [k, v] of Object.entries(res.getHeaders())) {
        if (v === undefined) continue;
        if (Array.isArray(v)) for (const x of v) out.append(k, String(x));
        else out.set(k, String(v));
      }
      const status = res.statusCode;
      const empty = status === 204 || status === 304 || request.method === "HEAD";
      resolve(new Response(empty ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage || "", headers: out }));
    };
    // Own properties win over Express's prototype methods (it re-parents res to app.response).
    Object.assign(res, {
      writeHead(status: number, a?: unknown, b?: unknown) {
        res.statusCode = status;
        if (typeof a === "string") res.statusMessage = a;
        const h = (typeof a === "object" ? a : b) as Record<string, string | string[]> | string[] | undefined;
        if (Array.isArray(h)) for (let i = 0; i < h.length; i += 2) res.setHeader(h[i]!, h[i + 1]!);
        else if (h) for (const [k, v] of Object.entries(h)) if (v !== undefined) res.setHeader(k, v);
        return res;
      },
      write(chunk: unknown, encoding?: unknown, cb?: unknown) {
        take(chunk, encoding);
        const fn = typeof encoding === "function" ? encoding : cb;
        if (typeof fn === "function") queueMicrotask(fn as () => void);
        return true;
      },
      end(chunk?: unknown, encoding?: unknown, cb?: unknown) {
        take(chunk, encoding);
        // What http would set: headersSent, writableEnded, finished.
        (res as unknown as { _header: string })._header = "injected";
        (res as unknown as { finished: boolean }).finished = true;
        const fn = [chunk, encoding, cb].find((x) => typeof x === "function");
        finish();
        queueMicrotask(() => {
          res.emit("prefinish");
          res.emit("finish");
          res.emit("close");
          socket.destroy();
          if (typeof fn === "function") (fn as () => void)();
        });
        return res;
      },
      flushHeaders() {},
    });
    res.once("error", (err) => (done ? undefined : reject(err)));
    // A timed-out tool call (request.signal aborted) keeps waiting for the app's answer:
    // Express can't stop a handler that has started, so the work may still complete, and
    // a paid call settles only on that real outcome (see ToolRegistry.call's `pending`).
    try {
      handler(req, res);
    } catch (err) {
      reject(err);
    }
  });
}
