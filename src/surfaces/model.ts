import { createHash } from "node:crypto";
import type { ManifestTool } from "../openapi/manifest.js";
import type { ToolDefinition } from "../mcp/tools.js";

/**
 * What every discovery surface is generated from: the spec, the tools
 * manifest and the config, resolved for one origin. Generated once per origin
 * and cached, so the documents can't drift from each other or from /mcp.
 */
export interface SurfaceModel {
  name: string;
  description: string;
  version: string;
  origin: string;
  mcpUrl: string;
  auth: {
    /** "passthrough" built in; a `describe` hook may name its own ("api-keys", "oauth"…). */
    mode: string;
    /** Headers agents send (passthrough: the credentials your API accepts). */
    headers: string[];
    /** Where agents get tokens, if anywhere. */
    issuer: string | null;
    scopes: string[];
    /** RFC 9728 protected-resource metadata, if served (also used in /mcp's 401 challenges). */
    resourceMetadataUrl: string | null;
    anonymous: string;
    /** Replaces the built-in "how to authenticate" text (llms.txt, /agent). */
    instructions?: string[];
    /** Replaces the headers the server card lists under `remotes[].headers`. */
    cardHeaders?: Array<{ name: string; description: string; isRequired: boolean; isSecret: boolean }>;
  };
  /** Enabled tools, in order: operation tools carry their manifest entry. */
  tools: Array<{ def: ToolDefinition; op: ManifestTool | null }>;
  spec: Record<string, any> | null;
  /** Paragraphs after the auth text in llms.txt (how payment works, terms…). */
  notes: string[];
  /** Show each tool's `price` in llms.txt and /agent (a hook that charges for them turns this on). */
  showPrices: boolean;
  links: {
    openapi: string | null;
    openapiYaml: string | null;
    llmsTxt: string | null;
    llmsFullTxt: string | null;
    serverCard: string | null;
    aiCatalog: string | null;
    agentIndex: string | null;
  };
  /** More discovery URLs: listed in llms.txt and in /agent's `discovery` under `key`. */
  extraLinks: Array<{ key: string; url: string; title: string; notes?: string; section?: "mcp" | "optional" }>;
  /** Extra fields: merged into /agent's JSON, the spec's top-level `x-agentify` and the server card's `_meta`. */
  extensions: Record<string, unknown>;
}

/** A cacheable JSON or text document with an ETag. */
export interface Doc {
  body: string;
  type: string;
  etag: string;
  maxAge: number;
  cors: boolean;
  /** The request headers that picked this document over another at the same URL. */
  vary?: string;
}

export function doc(body: string, type: string, maxAge = 300, cors = true): Doc {
  return { body, type, etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`, maxAge, cors };
}

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "Content-Type, If-None-Match",
  "access-control-expose-headers": "ETag",
};

/**
 * `shared: false` when the documents were built from the request's own Host
 * (no baseUrl): then no CDN may cache them for other visitors.
 */
export function serve(d: Doc, request: Request, shared = true): Response {
  const headers: Record<string, string> = {
    "content-type": d.type,
    "cache-control": shared ? `public, max-age=${d.maxAge}` : "private, max-age=60",
    etag: d.etag,
    ...(d.vary ? { vary: d.vary } : {}),
    ...(d.cors ? CORS_HEADERS : {}),
  };
  const inm = request.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim() === d.etag || t.trim() === "*")) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : d.body, { status: 200, headers });
}

/** "Acme Orders API" → "acme-orders-api". */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "api";

/** api.acme.com → com.acme.api (reverse DNS, as the server card's name wants). */
export function reverseDns(host: string): string {
  const h = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(h) || h.includes(":")) return "local";
  return h.split(".").filter(Boolean).reverse().join(".").replace(/[^a-zA-Z0-9.-]/g, "-") || "local";
}

/** Example arguments for a tool: its first manifest example, else values made from the schema. */
export function exampleArguments(op: ManifestTool | null, schema: Record<string, any>): Record<string, unknown> {
  const accepted = op?.suggestions?.accepted ? op.suggestions.examples : undefined;
  const ex = op?.examples?.[0]?.arguments ?? accepted?.[0]?.arguments;
  if (ex) return ex;
  const out: Record<string, unknown> = {};
  for (const name of (schema.required as string[] | undefined) ?? []) out[name] = exampleValue(schema.properties?.[name], name);
  return out;
}

export function exampleValue(s: any, name = "", depth = 0): unknown {
  if (!s || typeof s !== "object" || depth > 4) return name.toLowerCase().endsWith("id") ? `${name.replace(/_?id$/i, "") || "item"}_123` : "string";
  if (s.examples?.length) return s.examples[0];
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (s.const !== undefined) return s.const;
  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== "null") : s.type;
  if (s.oneOf?.[0] || s.anyOf?.[0]) return exampleValue(s.oneOf?.[0] ?? s.anyOf?.[0], name, depth + 1);
  switch (type) {
    case "integer":
      return typeof s.minimum === "number" ? s.minimum : 1;
    case "number":
      return typeof s.minimum === "number" ? s.minimum : 1.5;
    case "boolean":
      return true;
    case "array":
      return [exampleValue(s.items, name, depth + 1)];
    case "object": {
      const o: Record<string, unknown> = {};
      for (const k of (s.required as string[] | undefined) ?? Object.keys(s.properties ?? {}).slice(0, 3)) o[k] = exampleValue(s.properties?.[k], k, depth + 1);
      return o;
    }
    default:
      if (s.format === "date-time") return "2026-09-29T12:00:00Z";
      if (s.format === "date") return "2026-09-29";
      if (s.format === "email") return "ada@example.com";
      if (s.format === "uri") return "https://example.com";
      if (s.format === "uuid") return "3fa85f64-5717-4562-b3fc-2c963f66afa6";
      return name.toLowerCase().endsWith("id") ? `${name.replace(/_?id$/i, "") || "item"}_123` : "string";
  }
}
