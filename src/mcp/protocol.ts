/**
 * Wire-level constants and helpers for MCP, both eras:
 *
 *   modern  2026-07-28   stateless; every request carries its protocol version
 *                        and client capabilities in `_meta`; Streamable HTTP
 *                        mirrors method/name into headers that must match.
 *   legacy  2025-11-25,  `initialize` handshake; we serve it in Streamable
 *           2025-06-18,  HTTP's stateless mode (no Mcp-Session-Id).
 *           2025-03-26
 */

export const MODERN_VERSIONS = ["2026-07-28"] as const;
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const SUPPORTED_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const LATEST_LEGACY_VERSION = LEGACY_VERSIONS[0];

export const isModernVersion = (v: unknown): v is string => typeof v === "string" && (MODERN_VERSIONS as readonly string[]).includes(v);
export const isLegacyVersion = (v: unknown): v is string => typeof v === "string" && (LEGACY_VERSIONS as readonly string[]).includes(v);

export const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  serverInfo: "io.modelcontextprotocol/serverInfo",
} as const;

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // Reserved by MCP 2026-07-28 (-32020…-32099).
  HeaderMismatch: -32020,
  MissingRequiredClientCapability: -32021,
  UnsupportedProtocolVersion: -32022,
} as const;

export type Id = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: Id | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse = { jsonrpc: "2.0"; id: Id | null; result: Record<string, unknown> } | { jsonrpc: "2.0"; id: Id | null; error: JsonRpcError };

export const rpcError = (id: Id | null, code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

export const rpcResult = (id: Id | null, result: Record<string, unknown>): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

export function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  return m.jsonrpc === "2.0" && typeof m.method === "string" && (m.params === undefined || (typeof m.params === "object" && m.params !== null && !Array.isArray(m.params)));
}

const SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/;

/**
 * Decodes an `Mcp-Name` / `Mcp-Param-*` header value: plain ASCII as is, or
 * the `=?base64?…?=` sentinel form. Returns null for values that are neither.
 */
export function decodeHeaderValue(value: string): string | null {
  const m = SENTINEL.exec(value);
  if (m) {
    const decoded = Buffer.from(m[1]!, "base64");
    // Reject malformed base64 rather than comparing garbage.
    if (decoded.toString("base64").replace(/=+$/, "") !== m[1]!.replace(/=+$/, "")) return null;
    return decoded.toString("utf8");
  }
  // Visible ASCII plus space and tab (RFC 9110 field values).
  return /^[\x20-\x7E\t]*$/.test(value) ? value : null;
}

/** How a client must encode a value for Mcp-Name (used by our own tests and tooling). */
export function encodeHeaderValue(value: string): string {
  const plain = /^[\x21-\x7E]([\x20-\x7E\t]*[\x21-\x7E])?$/.test(value) && !SENTINEL.test(value);
  return plain ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export type Era = { kind: "modern"; version: string } | { kind: "legacy"; version: string };

/** A request-level protocol failure: the JSON-RPC error and the HTTP status that carries it. */
export class ProtocolError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const unsupported = (requested: unknown) =>
  new ProtocolError(400, ErrorCode.UnsupportedProtocolVersion, "Unsupported protocol version", {
    supported: SUPPORTED_VERSIONS,
    requested: typeof requested === "string" ? requested : null,
  });

export interface HeaderSource {
  (name: string): string | undefined;
}

/**
 * Picks the protocol era for one request and enforces that era's rules.
 * `headers` is null on stdio, where there are no HTTP headers to check.
 *
 *   - `initialize` → legacy handshake (negotiated separately).
 *   - `_meta` protocol version or a modern MCP-Protocol-Version header →
 *     modern: `_meta` fields required, headers required and must match.
 *   - otherwise legacy; a missing header means 2025-03-26 (spec: MAY).
 */
export function detectEra(msg: JsonRpcRequest, headers: HeaderSource | null): Era {
  const meta = (msg.params?._meta ?? undefined) as Record<string, unknown> | undefined;
  const metaVersion = meta?.[META.protocolVersion];
  const headerVersion = headers?.("mcp-protocol-version");

  if (msg.method === "initialize") return { kind: "legacy", version: LATEST_LEGACY_VERSION };

  if (metaVersion !== undefined || isModernVersion(headerVersion)) {
    if (headers) {
      if (headerVersion === undefined) throw new ProtocolError(400, ErrorCode.HeaderMismatch, "Header mismatch: MCP-Protocol-Version header is required");
      if (metaVersion !== undefined && headerVersion !== metaVersion) {
        throw new ProtocolError(
          400,
          ErrorCode.HeaderMismatch,
          `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match body value '${String(metaVersion)}'`,
        );
      }
    }
    if (metaVersion === undefined) throw new ProtocolError(400, ErrorCode.InvalidParams, `Missing required _meta field: ${META.protocolVersion}`);
    if (!isModernVersion(metaVersion)) {
      // A legacy version in _meta is not a thing; anything else is unknown.
      throw unsupported(metaVersion);
    }
    if (typeof meta?.[META.clientCapabilities] !== "object" || meta[META.clientCapabilities] === null) {
      throw new ProtocolError(400, ErrorCode.InvalidParams, `Missing required _meta field: ${META.clientCapabilities}`);
    }
    if (headers) validateMirroredHeaders(msg, headers);
    return { kind: "modern", version: metaVersion };
  }

  if (headerVersion === undefined) return { kind: "legacy", version: "2025-03-26" };
  if (isLegacyVersion(headerVersion)) return { kind: "legacy", version: headerVersion };
  throw unsupported(headerVersion);
}

function validateMirroredHeaders(msg: JsonRpcRequest, headers: HeaderSource) {
  const method = headers("mcp-method");
  if (method === undefined) throw new ProtocolError(400, ErrorCode.HeaderMismatch, "Header mismatch: Mcp-Method header is required");
  if (method !== msg.method) {
    throw new ProtocolError(400, ErrorCode.HeaderMismatch, `Header mismatch: Mcp-Method header value '${method}' does not match body value '${msg.method}'`);
  }
  const needsName = msg.method === "tools/call" || msg.method === "prompts/get" || msg.method === "resources/read";
  if (!needsName) return;
  const bodyName = msg.method === "resources/read" ? msg.params?.uri : msg.params?.name;
  const raw = headers("mcp-name");
  if (raw === undefined) throw new ProtocolError(400, ErrorCode.HeaderMismatch, "Header mismatch: Mcp-Name header is required");
  const decoded = decodeHeaderValue(raw);
  if (decoded === null) throw new ProtocolError(400, ErrorCode.HeaderMismatch, "Header mismatch: Mcp-Name header contains invalid characters");
  if (decoded !== bodyName) {
    throw new ProtocolError(400, ErrorCode.HeaderMismatch, `Header mismatch: Mcp-Name header value '${decoded}' does not match body value '${String(bodyName)}'`);
  }
}
