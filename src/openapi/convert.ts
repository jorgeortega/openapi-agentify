import type { JsonSchemaObject } from "../mcp/tools.js";
import type { Manifest, ManifestParam, ManifestTool } from "./manifest.js";

/**
 * OpenAPI 3.0 / 3.1 → MCP tools. Each
 * operation becomes one tool whose input is its path, query and header
 * parameters plus a `body`, as one JSON Schema 2020-12 object. Pure: document
 * in, manifest out.
 *
 * Safety defaults:
 *   - read-only: GET/HEAD are enabled, writes are imported disabled unless
 *     `includeWrites` (you turn them on per tool in agentify.tools.json);
 *   - no credential-like header parameters (the auth mode decides auth, never
 *     the model), and none of Agentify's own headers;
 *   - local `$ref`s only: a spec can't make us fetch other URLs.
 */

export interface ImportOptions {
  includeWrites?: boolean;
  /** Scopes are `<prefix>:read` for GET/HEAD and `<prefix>:write` otherwise. */
  scopePrefix?: string;
  /** Only operations whose name, operationId or a tag is listed. */
  include?: string[];
  exclude?: string[];
  includeDeprecated?: boolean;
  /** Where the spec came from, for the manifest and to resolve relative server URLs. */
  specSource?: string;
  now?: Date;
}

export interface ImportResult {
  manifest: Manifest;
  warnings: string[];
}

type Json = Record<string, any>;

const METHODS = ["get", "head", "post", "put", "patch", "delete"] as const;
const READ = new Set(["GET", "HEAD"]);
/** Headers a model must never set: auth, cookies and transport-level fields. */
const BLOCKED_HEADERS = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie", "host", "content-length", "content-type",
  "accept", "accept-encoding", "connection", "transfer-encoding", "x-api-key", "api-key", "x-forwarded-for", "forwarded",
  "x-request-id", "traceparent", "tracestate", "user-agent", "x-real-ip", "x-payment",
]);

/** True for a header the model may never set: credentials, transport, and Agentify's own. */
export function isBlockedHeader(name: string): boolean {
  const n = name.toLowerCase();
  return BLOCKED_HEADERS.has(n) || n.startsWith("x-agentify-") || n.startsWith("mcp-") || n.startsWith("payment-");
}
const MAX_DEPTH = 24;

function decodePointer(ref: string, doc: Json): unknown {
  if (!ref.startsWith("#")) throw new Error(`External $ref not supported: ${ref} (bundle the spec first, e.g. with redocly bundle)`);
  const parts = ref.slice(1).split("/").slice(1).map((p) => decodeURIComponent(p).replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object" || !(p in (cur as Json))) throw new Error(`Unresolvable $ref: ${ref}`);
    cur = (cur as Json)[p];
  }
  return cur;
}

/** Resolves a (chain of) `$ref` on a non-schema object: parameters, request bodies, path items. */
function deref<T = Json>(value: unknown, doc: Json, seen = new Set<string>()): T {
  let cur = value as Json;
  while (cur && typeof cur === "object" && typeof cur.$ref === "string") {
    if (seen.has(cur.$ref)) throw new Error(`Circular $ref: ${cur.$ref}`);
    seen.add(cur.$ref);
    cur = decodePointer(cur.$ref, doc) as Json;
  }
  return cur as T;
}

interface SchemaCtx {
  doc: Json;
  is30: boolean;
  /** Request bodies drop readOnly properties (the server sets those). */
  mode: "request" | "param";
  stack: string[];
  depth: number;
}

const SUBSCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const SUBSCHEMA_ARRAYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const SUBSCHEMA_SINGLE = ["additionalProperties", "items", "not", "if", "then", "else", "contains", "propertyNames", "unevaluatedProperties", "unevaluatedItems"] as const;
const DROP = new Set(["discriminator", "xml", "externalDocs", "example", "nullable", "$schema", "$id"]);

/** One OpenAPI schema → JSON Schema 2020-12, with local refs inlined and cycles cut. */
export function toJsonSchema(schema: unknown, ctx: SchemaCtx): Json {
  if (schema === true || schema === false) return schema as unknown as Json;
  if (!schema || typeof schema !== "object") return {};
  let s = schema as Json;
  if (typeof s.$ref === "string") {
    const ref = s.$ref;
    // A cycle (a tree node that contains nodes) or a very deep schema: stop
    // inlining and accept any value there. Validation stays correct above it.
    if (ctx.stack.includes(ref) || ctx.depth > MAX_DEPTH) {
      return { description: `Recursive: see ${ref.split("/").pop()}` };
    }
    const target = decodePointer(ref, ctx.doc);
    const { $ref: _ignored, ...siblings } = s;
    const resolved = toJsonSchema(target, { ...ctx, stack: [...ctx.stack, ref], depth: ctx.depth + 1 });
    // 3.1 allows keywords next to $ref (e.g. a description override).
    s = Object.keys(siblings).length ? { ...resolved, ...toJsonSchema(siblings, ctx) } : resolved;
    return s;
  }

  const out: Json = {};
  for (const [k, v] of Object.entries(s)) {
    if (DROP.has(k) || k.startsWith("x-")) continue;
    out[k] = v;
  }
  const next = { ...ctx, depth: ctx.depth + 1 };
  for (const key of SUBSCHEMA_MAPS) {
    if (out[key] && typeof out[key] === "object") {
      out[key] = Object.fromEntries(Object.entries(out[key] as Json).map(([name, sub]) => [name, toJsonSchema(sub, next)]));
    }
  }
  for (const key of SUBSCHEMA_ARRAYS) if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map((sub) => toJsonSchema(sub, next));
  for (const key of SUBSCHEMA_SINGLE) {
    const v = out[key];
    if (v && typeof v === "object" && !Array.isArray(v)) out[key] = toJsonSchema(v, next);
    // 3.0 `items` is never an array; 3.1 tuple form is prefixItems.
  }

  if (s.example !== undefined && out.examples === undefined) out.examples = [s.example];
  if (ctx.is30) {
    // 3.0 boolean exclusive bounds → 2020-12 numeric ones.
    if (s.exclusiveMinimum === true && typeof s.minimum === "number") {
      out.exclusiveMinimum = s.minimum;
      delete out.minimum;
    } else if (typeof s.exclusiveMinimum === "boolean") delete out.exclusiveMinimum;
    if (s.exclusiveMaximum === true && typeof s.maximum === "number") {
      out.exclusiveMaximum = s.maximum;
      delete out.maximum;
    } else if (typeof s.exclusiveMaximum === "boolean") delete out.exclusiveMaximum;
    if (s.nullable === true) {
      if (typeof out.type === "string") out.type = [out.type, "null"];
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
      if (out.type === undefined && out.enum === undefined) {
        // `nullable` without a type (e.g. on allOf): allow null alongside.
        const { description, ...rest } = out;
        return { ...(description ? { description } : {}), anyOf: [rest, { type: "null" }] };
      }
    }
  }
  if (ctx.mode === "request" && out.properties && typeof out.properties === "object") {
    const props = out.properties as Json;
    const readOnly = Object.keys(props).filter((k) => props[k] && typeof props[k] === "object" && (props[k] as Json).readOnly === true);
    for (const k of readOnly) delete props[k];
    if (Array.isArray(out.required)) {
      out.required = (out.required as string[]).filter((k) => !readOnly.includes(k));
      if ((out.required as string[]).length === 0) delete out.required;
    }
  }
  return out;
}

function toolName(op: Json, method: string, path: string): string {
  const raw = typeof op.operationId === "string" && op.operationId ? op.operationId : `${method.toLowerCase()}_${path}`;
  const cleaned = raw
    .replace(/[{}]/g, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
  return (cleaned || method.toLowerCase()).slice(0, 64);
}

function describe(op: Json, method: string, path: string): { title?: string; description: string } {
  const summary = typeof op.summary === "string" ? op.summary.trim() : "";
  const long = typeof op.description === "string" ? op.description.trim() : "";
  const parts = [summary, long && long !== summary ? long : ""].filter(Boolean);
  let description = parts.join("\n\n") || `${method} ${path}`;
  if (description.length > 1_200) description = `${description.slice(0, 1_197)}…`;
  return { ...(summary && summary.length <= 80 ? { title: summary } : {}), description };
}

function matches(filter: string[] | undefined, name: string, op: Json): boolean {
  if (!filter?.length) return true;
  const keys = [name, op.operationId, ...(Array.isArray(op.tags) ? op.tags : [])].filter((k): k is string => typeof k === "string");
  return keys.some((k) => filter.includes(k));
}

/** First `servers` entry with its variables filled in; relative URLs resolve against the spec URL. */
export function serverUrl(doc: Json, specSource?: string): string | undefined {
  const server = Array.isArray(doc.servers) ? doc.servers[0] : undefined;
  if (!server || typeof server.url !== "string") return undefined;
  let url = server.url.replace(/\{([^}]+)\}/g, (_: string, name: string) => String(server.variables?.[name]?.default ?? ""));
  if (!/^https?:\/\//.test(url) && specSource && /^https?:\/\//.test(specSource)) url = new URL(url, specSource).toString();
  return url.replace(/\/+$/, "") || undefined;
}

export function importOpenApi(doc: unknown, opts: ImportOptions = {}): ImportResult {
  if (!doc || typeof doc !== "object") throw new Error("The spec is not a JSON/YAML object");
  const d = doc as Json;
  if (typeof d.swagger === "string") throw new Error("Swagger 2.0 isn't supported: convert it to OpenAPI 3 first (e.g. https://converter.swagger.io)");
  if (typeof d.openapi !== "string" || !/^3\.[01]\./.test(d.openapi)) throw new Error(`Unsupported OpenAPI version: ${String(d.openapi)} (3.0.x and 3.1.x are supported)`);
  const is30 = d.openapi.startsWith("3.0");
  const prefix = opts.scopePrefix ?? "api";
  const warnings: string[] = [];
  const tools: ManifestTool[] = [];
  const names = new Set<string>();

  for (const [path, rawItem] of Object.entries((d.paths ?? {}) as Json)) {
    const item = deref<Json>(rawItem, d);
    if (!item || typeof item !== "object") continue;
    for (const m of METHODS) {
      const op = item[m] as Json | undefined;
      if (!op || typeof op !== "object") continue;
      const method = m.toUpperCase() as ManifestTool["method"];
      const operation = `${method} ${path}`;
      // `x-agentify` on an operation (or `x-mcp`): name, enabled, price, scope…
      const xmcp = { ...((op["x-mcp"] ?? {}) as Json), ...((op["x-agentify"] ?? {}) as Json) } as Json;
      let name = typeof xmcp.name === "string" ? xmcp.name : toolName(op, method, path);
      if (!matches(opts.include, name, op) || (opts.exclude?.length && matches(opts.exclude, name, op))) continue;
      if (op.deprecated === true && !opts.includeDeprecated) {
        warnings.push(`${operation}: deprecated, skipped (--include-deprecated to keep)`);
        continue;
      }
      if (xmcp.exclude === true) continue;

      try {
        // Parameters: path-level, overridden by operation-level with the same (in, name).
        const merged = new Map<string, Json>();
        for (const p of [...((item.parameters as unknown[]) ?? []), ...((op.parameters as unknown[]) ?? [])]) {
          const param = deref<Json>(p, d);
          if (param && typeof param.name === "string" && typeof param.in === "string") merged.set(`${param.in}:${param.name}`, param);
        }

        const properties: Json = {};
        const required: string[] = [];
        const params: ManifestParam[] = [];
        let skip = false;
        const takeArg = (want: string, where: string) => {
          let arg = want;
          if (arg === "body" || arg in properties) arg = `${where}_${want}`;
          for (let i = 2; arg in properties; i++) arg = `${where}_${want}_${i}`;
          return arg;
        };

        for (const param of merged.values()) {
          const where = param.in as string;
          if (where === "cookie") {
            warnings.push(`${operation}: cookie parameter "${param.name}" skipped`);
            continue;
          }
          if (where === "header" && isBlockedHeader(String(param.name))) {
            warnings.push(`${operation}: header "${param.name}" is set by Agentify or your auth mode, not the model`);
            continue;
          }
          if (where !== "path" && where !== "query" && where !== "header") continue;
          const rawSchema = param.schema ?? param.content?.["application/json"]?.schema ?? { type: "string" };
          const schema = toJsonSchema(rawSchema, { doc: d, is30, mode: "param", stack: [], depth: 0 });
          if (typeof param.description === "string" && !schema.description) schema.description = param.description;
          const arg = takeArg(param.name, where);
          properties[arg] = schema;
          const isRequired = where === "path" || param.required === true;
          if (isRequired) required.push(arg);
          params.push({
            name: param.name,
            in: where,
            arg,
            required: isRequired,
            ...(param.style === "deepObject" ? { style: "deepObject" as const } : {}),
            ...(param.explode === false ? { explode: false } : {}),
          });
        }
        for (const [, placeholder] of path.matchAll(/\{([^}]+)\}/g)) {
          if (!params.some((p) => p.in === "path" && p.name === placeholder)) {
            warnings.push(`${operation}: path parameter {${placeholder}} is not declared, skipped operation`);
            skip = true;
          }
        }

        let body: ManifestTool["body"] = null;
        if (op.requestBody && !skip) {
          const rb = deref<Json>(op.requestBody, d);
          const content = (rb.content ?? {}) as Json;
          const type = Object.keys(content).find((t) => t === "application/json" || /^application\/[\w.+-]*\+json$/.test(t) || t.startsWith("application/json;"));
          if (!type) {
            const types = Object.keys(content).join(", ") || "none";
            if (rb.required) {
              warnings.push(`${operation}: request body is ${types}; only JSON bodies are supported, skipped operation`);
              skip = true;
            } else warnings.push(`${operation}: optional ${types} request body dropped (only JSON is supported)`);
          } else {
            const schema = toJsonSchema(content[type].schema ?? {}, { doc: d, is30, mode: "request", stack: [], depth: 0 });
            if (typeof rb.description === "string" && !schema.description) schema.description = rb.description;
            properties.body = schema;
            if (rb.required) required.push("body");
            body = { arg: "body", required: rb.required === true, contentType: type.split(";")[0]! };
          }
        }
        if (skip) continue;

        for (let i = 2; names.has(name); i++) name = `${name.slice(0, 60)}_${i}`;
        names.add(name);
        const isRead = READ.has(method);
        const inputSchema: JsonSchemaObject = { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
        const text = describe(op, method, path);
        tools.push({
          name,
          enabled: typeof xmcp.enabled === "boolean" ? xmcp.enabled : isRead || opts.includeWrites === true,
          operation,
          ...(typeof op.operationId === "string" ? { operationId: op.operationId } : {}),
          ...(typeof xmcp.title === "string" ? { title: xmcp.title } : text.title ? { title: text.title } : {}),
          description: typeof xmcp.description === "string" ? xmcp.description : text.description,
          method,
          path,
          params,
          body,
          inputSchema,
          scope: typeof xmcp.scope === "string" ? xmcp.scope : `${prefix}:${isRead ? "read" : "write"}`,
          ...(typeof xmcp.price === "string" ? { price: xmcp.price.replace(/^\$/, "") } : {}),
          annotations: {
            readOnlyHint: isRead,
            destructiveHint: method === "DELETE" || method === "PUT",
            idempotentHint: method !== "POST" && method !== "PATCH",
            openWorldHint: false,
          },
        });
      } catch (err) {
        warnings.push(`${operation}: ${(err as Error).message}, skipped operation`);
      }
    }
  }

  if (tools.length === 0) warnings.push("No operations were imported.");
  const info = (d.info ?? {}) as Json;
  return {
    manifest: {
      source: {
        spec: opts.specSource ?? "openapi",
        ...(typeof info.title === "string" ? { title: info.title } : {}),
        ...(typeof info.version === "string" ? { version: info.version } : {}),
        importedAt: (opts.now ?? new Date()).toISOString(),
      },
      baseUrl: serverUrl(d, opts.specSource),
      tools,
    },
    warnings,
  };
}
