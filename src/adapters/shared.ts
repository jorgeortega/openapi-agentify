import type { AgentifyConfig } from "../config.js";
import { type Agentify, createAgentify, type FinishOutput } from "../core.js";

/** Adapters take a config or an already-created Agentify (to share one between adapters or with the CLI). */
export function toAgentify(input: AgentifyConfig | Agentify): Agentify {
  return typeof (input as Agentify).handle === "function" && typeof (input as Agentify).guard === "function" ? (input as Agentify) : createAgentify(input as AgentifyConfig);
}

/** Applies a guard's finish() output to a buffered Fetch response. */
export async function applyFinish(res: Response, body: Uint8Array, out: FinishOutput, extra: Record<string, string>): Promise<Response> {
  if (out.replace) {
    const headers = new Headers(out.replace.headers);
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return new Response(out.replace.body, { status: out.replace.status, headers });
  }
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...extra, ...(out.headers ?? {}) })) headers.set(k, v);
  headers.delete("content-length");
  return new Response(res.status === 204 || res.status === 304 ? null : (body as Uint8Array<ArrayBuffer>), { status: res.status, statusText: res.statusText, headers });
}

const MAX_PREREAD = 1024 * 1024;

/** The body of a Fetch request for idempotency hashing, from a clone, up to 1 MiB (else null). No body: empty. */
export async function readBodyCapped(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_PREREAD) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PREREAD) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function contentLength(headers: Headers): number {
  const n = Number(headers.get("content-length") ?? "0");
  return Number.isFinite(n) ? n : 0;
}

/** Fetch Headers → a plain object, keeping repeated Set-Cookie headers apart. */
export function headersToObject(headers: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  headers.forEach((v, k) => {
    if (k !== "set-cookie") out[k] = v;
  });
  const cookies = headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  return out;
}
