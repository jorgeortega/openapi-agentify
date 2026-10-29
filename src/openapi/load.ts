import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/** OpenAPI documents: finding, reading and a few facts other modules need. */

export type Json = Record<string, any>;

export const SPEC_FILE_NAMES = [
  "openapi.json",
  "openapi.yaml",
  "openapi.yml",
  "swagger.json",
  "openapi/openapi.json",
  "openapi/openapi.yaml",
  "docs/openapi.json",
  "docs/openapi.yaml",
  "api/openapi.json",
  "api/openapi.yaml",
  "spec/openapi.json",
  "spec/openapi.yaml",
  "public/openapi.json",
  "src/openapi.json",
  "src/openapi.yaml",
];

/** Where a running app usually serves its spec (fastify-swagger, NestJS, express-openapi…). */
export const SPEC_URL_PATHS = ["/openapi.json", "/docs/json", "/swagger.json", "/api-docs", "/openapi.yaml", "/v3/api-docs", "/api/openapi.json"];

export function parseSpecText(text: string, source: string): Json {
  let doc: unknown;
  try {
    doc = /^\s*[{[]/.test(text) ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON or YAML: ${(err as Error).message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${source} is not an OpenAPI document`);
  return doc as Json;
}

export function readSpecFile(path: string): Json {
  return parseSpecText(readFileSync(path, "utf8"), path);
}

export function findSpecFile(dir: string): string | null {
  for (const name of SPEC_FILE_NAMES) {
    const p = join(/*turbopackIgnore: true*/ dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export async function fetchSpec(url: string, fetchImpl: typeof fetch = fetch): Promise<Json> {
  const res = await fetchImpl(url, { headers: { accept: "application/json, application/yaml;q=0.9, */*;q=0.1", "user-agent": "agentify" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return parseSpecText(await res.text(), url);
}

/** Tries the usual spec paths on a running app; returns the first that parses as OpenAPI. */
export async function probeSpec(base: string, fetchImpl: typeof fetch = fetch): Promise<{ url: string; doc: Json } | null> {
  for (const path of SPEC_URL_PATHS) {
    const url = new URL(path, base).toString();
    try {
      const doc = await fetchSpec(url, fetchImpl);
      if (typeof doc.openapi === "string" || typeof doc.swagger === "string") return { url, doc };
    } catch {
      // try the next one
    }
  }
  return null;
}

export const resolveFrom = (root: string, p: string) => resolve(root, p);

export function isOpenApi3(doc: Json): boolean {
  return typeof doc.openapi === "string" && /^3\.[01]\./.test(doc.openapi);
}

/**
 * The credentials the spec says the API accepts: header names (for passthrough
 * forwarding and "has credentials" checks) and cookie names (browser sessions).
 */
export function credentialLocations(doc: Json | null): { headers: string[]; cookies: string[] } {
  const headers = new Set<string>(["authorization"]);
  const cookies = new Set<string>();
  const schemes = (doc?.components?.securitySchemes ?? {}) as Json;
  for (const s of Object.values(schemes)) {
    if (!s || typeof s !== "object") continue;
    if (s.type === "apiKey" && typeof s.name === "string") {
      if (s.in === "header") headers.add(s.name.toLowerCase());
      if (s.in === "cookie") cookies.add(s.name);
    }
  }
  return { headers: [...headers], cookies: [...cookies] };
}
