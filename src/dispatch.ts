import { randomBytes } from "node:crypto";
import { isBlockedHeader } from "./openapi/convert.js";
import type { ManifestTool } from "./openapi/manifest.js";
import { ToolError, type ToolOutput } from "./mcp/tools.js";

/**
 * In-process dispatch: a tool call becomes the HTTP request its operation
 * describes, handed straight to your app (Hono/Next.js: the fetch handler or
 * route function; Fastify: inject(); Express: light-my-request). No socket,
 * your middleware, your auth, your validation.
 *
 * The model controls only the declared parameters:
 *   - path parameters percent-encoded, and "", "." and ".." refused;
 *   - only declared query and header parameters, no CR/LF/NUL in values,
 *     never a credential or an Agentify header;
 *   - a JSON body when the operation takes one.
 * Everything else (credentials, X-Agentify-*, X-Request-Id, traceparent) is
 * set by Agentify.
 */

/** Hands a Request to your app and returns its Response. */
export type Dispatcher = (request: Request, info: { remoteAddress: string | null }) => Promise<Response>;

/** Marks Agentify's own in-process calls. Its value is a per-process secret, so it can't be forged from outside. */
export const INTERNAL_HEADER = "x-agentify-internal";
export const newInternalSecret = () => randomBytes(24).toString("base64url");

export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TEXT = 100_000;

function scalar(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export interface BuildOptions {
  /** Origin the request is addressed to (baseUrl, or the MCP request's origin). */
  origin: string;
  /** Set by Agentify: credentials, X-Agentify-*, X-Request-Id, traceparent… */
  headers: Record<string, string>;
  /** Aborted when the tool call times out or the client goes away: handlers can watch request.signal. */
  signal?: AbortSignal;
}

/** Builds the Request for one operation call. Exported for tests. */
export function buildOperationRequest(tool: ManifestTool, input: Record<string, unknown>, opts: BuildOptions): Request {
  let path = tool.path;
  for (const p of tool.params.filter((x) => x.in === "path")) {
    const value = input[p.arg];
    const s = value === undefined || value === null ? "" : scalar(value);
    if (s === "" || s === "." || s === "..") throw new ToolError(`Invalid value for path parameter ${p.arg}`);
    path = path.split(`{${p.name}}`).join(encodeURIComponent(s));
  }
  const base = new URL(opts.origin);
  const url = new URL(path, base.origin);
  if (url.origin !== base.origin) throw new ToolError("Resolved URL leaves this API");

  for (const p of tool.params.filter((x) => x.in === "query")) {
    const value = input[p.arg];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (p.explode === false) url.searchParams.append(p.name, value.map(scalar).join(","));
      else for (const v of value) url.searchParams.append(p.name, scalar(v));
    } else if (typeof value === "object" && p.style === "deepObject") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) url.searchParams.append(`${p.name}[${k}]`, scalar(v));
    } else url.searchParams.append(p.name, scalar(value));
  }

  const headers = new Headers({ accept: "application/json" });
  for (const p of tool.params.filter((x) => x.in === "header")) {
    const value = input[p.arg];
    if (value === undefined || value === null) continue;
    // The converter already drops these; a hand-edited manifest can't bring them back.
    if (isBlockedHeader(p.name) || p.name.toLowerCase() in lower(opts.headers)) throw new ToolError(`Header ${p.name} can't be set by a tool call`);
    const s = scalar(value);
    if (/[\r\n\0]/.test(s)) throw new ToolError(`Invalid characters in header parameter ${p.arg}`);
    headers.set(p.name, s);
  }
  for (const [k, v] of Object.entries(opts.headers)) headers.set(k, v);

  let body: string | undefined;
  if (tool.body && input[tool.body.arg] !== undefined) {
    body = JSON.stringify(input[tool.body.arg]);
    headers.set("content-type", tool.body.contentType);
  }
  return new Request(url, { method: tool.method, headers, body, redirect: "manual", ...(opts.signal ? { signal: opts.signal } : {}) });
}

const lower = (h: Record<string, string>) => Object.fromEntries(Object.keys(h).map((k) => [k.toLowerCase(), true]));

export async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean; size: number }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false, size: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { bytes: Buffer.concat(chunks), truncated, size };
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text;
}

/** Your app's response → MCP content: JSON → structuredContent; non-2xx → isError with the status and an excerpt. */
export async function toToolResult(res: Response, maxBytes: number): Promise<ToolOutput> {
  const { bytes, truncated, size } = await readCapped(res, maxBytes);
  const text = Buffer.from(bytes).toString("utf8");
  const type = res.headers.get("content-type") ?? "";
  let json: unknown;
  if (/\bjson\b/i.test(type) && text && !truncated) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  if (res.status >= 300) {
    const excerpt = clip(text, 2_000);
    const why = res.status < 400 ? `redirected to ${res.headers.get("location") ?? "?"} (not followed)` : `answered ${status}`;
    return {
      content: [{ type: "text", text: `The API ${why}${excerpt ? `: ${excerpt}` : ""}` }],
      isError: true,
      status: res.status,
      bytes: size,
      ...(json !== undefined ? { structuredContent: { status: res.status, error: json } } : {}),
    };
  }
  if (!text) return { content: [{ type: "text", text: status }], status: res.status, bytes: size };
  if (json !== undefined) {
    return { content: [{ type: "text", text: clip(JSON.stringify(json), MAX_TEXT) }], structuredContent: json, status: res.status, bytes: size };
  }
  const note = truncated ? `\n[response truncated at ${maxBytes} bytes]` : "";
  return { content: [{ type: "text", text: clip(text, MAX_TEXT) + note }], status: res.status, bytes: size };
}

/** `--dispatch http`: a loopback request to a separate process. Redirects are not followed. */
export function httpDispatcher(target: string, fetchImpl: typeof fetch = fetch, timeoutMs = 30_000, sameApp?: boolean): Dispatcher {
  const base = new URL(target);
  const h = base.hostname;
  // The in-process marker only means something to this process: keep it for a loopback to
  // this same app (so its guard knows the call), never send it to another host.
  const keepMarker = sameApp ?? (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1");
  return async (request) => {
    const u = new URL(request.url);
    const url = new URL(`${u.pathname}${u.search}`, base.origin);
    const headers = new Headers(request.headers);
    if (!keepMarker) headers.delete(INTERNAL_HEADER);
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
    };
    if (request.body) {
      init.body = request.body;
      init.duplex = "half";
    }
    return fetchImpl(url, init);
  };
}

/** A W3C traceparent: a child of the caller's when one came in, else a new trace. */
export function childTraceparent(parent: string | null | undefined): string {
  const m = parent ? /^00-([0-9a-f]{32})-[0-9a-f]{16}-([0-9a-f]{2})$/.exec(parent.trim()) : null;
  const traceId = m && m[1] !== "0".repeat(32) ? m[1]! : randomBytes(16).toString("hex");
  return `00-${traceId}-${randomBytes(8).toString("hex")}-${m ? m[2] : "01"}`;
}
