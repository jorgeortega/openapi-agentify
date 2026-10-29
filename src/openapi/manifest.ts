import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { PRICE } from "../mcp/tools.js";

/**
 * `agentify.tools.json`: the reviewable list of tools made from your OpenAPI
 * spec. `openapi-agentify init` writes it; you edit it (descriptions, which
 * tools are enabled, scopes); the middleware loads it at startup.
 * `openapi-agentify sync` updates schemas from the spec and keeps your edits.
 *
 * Per tool, `examples`, `weight` and `suggestions` (what `openapi-agentify
 * improve` proposes; applied only once `accepted`) are optional. `price`,
 * `costUsd`, `rateLimit` and `weight` are data for hooks (payments, rate
 * limits): Agentify itself keeps them and acts on none of them.
 */

const Param = z.object({
  name: z.string().min(1),
  in: z.enum(["path", "query", "header"]),
  /** The property name in the tool's input (usually `name`). */
  arg: z.string().min(1),
  required: z.boolean(),
  style: z.enum(["form", "deepObject", "simple"]).optional(),
  explode: z.boolean().optional(),
});

const Example = z.object({ description: z.string().optional(), arguments: z.record(z.string(), z.unknown()) });

const Suggestions = z.object({
  /** "rules" (from the readiness rules); "claude" marks text a model drafted elsewhere (review it). */
  source: z.enum(["rules", "claude"]),
  accepted: z.boolean().default(false),
  operationId: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  /** Parameter (or body property) name → description. */
  params: z.record(z.string(), z.string()).optional(),
  examples: z.array(Example).optional(),
  /** Document an Idempotency-Key header (Agentify honours it for agent writes). */
  idempotencyKey: z.boolean().optional(),
});

/** US dollars like "0.01"; "$0.01" is accepted and stored without the sign. */
const Price = z
  .string()
  .transform((v) => v.trim().replace(/^\$/, ""))
  .pipe(z.string().regex(PRICE, 'US dollars like "0.01"'));

export const ManifestToolSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/, "1–128 of A-Z a-z 0-9 _ - ."),
  enabled: z.boolean(),
  /** "METHOD /path" in the spec; how re-imports match your edits back up. */
  operation: z.string(),
  operationId: z.string().optional(),
  title: z.string().optional(),
  description: z.string().min(1),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/"),
  params: z.array(Param),
  body: z.object({ arg: z.string(), required: z.boolean(), contentType: z.string() }).nullable(),
  inputSchema: z.looseObject({ type: z.literal("object") }),
  scope: z.string().optional(),
  price: Price.optional(),
  costUsd: z.number().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
  rateLimit: z.object({ capacity: z.number().int().positive(), refillPerSec: z.number().positive() }).optional(),
  /** How heavy one call is, for a rate-limiting hook (default 1). */
  weight: z.number().int().positive().max(1000).optional(),
  annotations: z
    .object({
      title: z.string().optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
  examples: z.array(Example).optional(),
  suggestions: Suggestions.optional(),
});

export const ManifestSchema = z.object({
  $schema: z.string().optional(),
  source: z.object({ spec: z.string(), title: z.string().optional(), version: z.string().optional(), importedAt: z.string() }).optional(),
  /** The API's base URL from the spec's `servers` (informational here: dispatch is in-process). */
  baseUrl: z.string().optional(),
  tools: z.array(ManifestToolSchema),
});

export type ManifestParam = z.infer<typeof Param>;
export type ManifestTool = z.infer<typeof ManifestToolSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type ToolSuggestions = z.infer<typeof Suggestions>;

export function parseManifest(json: unknown, source = "agentify.tools.json"): Manifest {
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.slice(0, 20).map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`${source} is invalid:\n${lines.join("\n")}`);
  }
  const names = new Set<string>();
  for (const t of parsed.data.tools) {
    if (names.has(t.name)) throw new Error(`${source}: duplicate tool name "${t.name}"`);
    names.add(t.name);
  }
  return parsed.data;
}

export function readManifest(file: string): Manifest | null {
  if (!existsSync(file)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  return parseManifest(json, file);
}

/** Fields that are yours once imported: a re-import never overwrites them. */
const EDITABLE = ["name", "enabled", "title", "description", "scope", "price", "costUsd", "timeoutMs", "rateLimit", "weight", "annotations", "examples", "suggestions"] as const;

/**
 * Merges a fresh import into an existing manifest: operations still in the
 * spec keep your edits and get the spec's current schema and parameters;
 * new operations are added; removed ones are dropped.
 */
export function mergeManifest(existing: Manifest | null, fresh: Manifest): { manifest: Manifest; added: string[]; removed: string[]; kept: string[] } {
  if (!existing) return { manifest: fresh, added: fresh.tools.map((t) => t.name), removed: [], kept: [] };
  const before = new Map(existing.tools.map((t) => [t.operation, t]));
  const added: string[] = [];
  const kept: string[] = [];
  const tools = fresh.tools.map((t) => {
    const old = before.get(t.operation);
    if (!old) {
      added.push(t.name);
      return t;
    }
    kept.push(old.name);
    const merged: ManifestTool = { ...t };
    // Your value wins; where you have none, the spec's (e.g. a price added in x-agentify) comes in.
    for (const k of EDITABLE) if (old[k] !== undefined) (merged as Record<string, unknown>)[k] = old[k];
    return merged;
  });
  const seen = new Set(fresh.tools.map((t) => t.operation));
  const removed = existing.tools.filter((t) => !seen.has(t.operation)).map((t) => t.name);
  // A newly added operation may now collide with a name you chose.
  const used = new Set<string>();
  for (const t of tools) {
    let name = t.name;
    for (let i = 2; used.has(name); i++) name = `${t.name.slice(0, 120)}_${i}`;
    t.name = name;
    used.add(name);
  }
  return { manifest: { ...fresh, baseUrl: fresh.baseUrl ?? existing.baseUrl, tools }, added, removed, kept };
}

/** The description an agent sees: an accepted suggestion wins over the spec's text. */
export function effectiveText(t: ManifestTool): { title?: string; description: string } {
  const s = t.suggestions?.accepted ? t.suggestions : undefined;
  return { title: s?.title ?? t.title, description: s?.description ?? t.description };
}
