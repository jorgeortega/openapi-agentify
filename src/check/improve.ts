import { guessOperationId } from "../draft/draft.js";
import type { Manifest, ManifestTool, ToolSuggestions } from "../openapi/manifest.js";
import { exampleArguments, exampleValue } from "../surfaces/model.js";

/**
 * `agentify improve`: suggestions for what the readiness check found, written
 * into agentify.tools.json (never into your spec):
 *
 *   operationIds, summaries, descriptions, parameter descriptions (with the
 *   allowed values when the schema knows them), examples made from the
 *   schemas, and the Idempotency-Key header on writes. All from rules: no
 *   model is called, and the same spec always gets the same suggestions.
 *
 * Nothing is served until you accept it (`--accept`, or "accepted": true per tool).
 */

type Json = Record<string, any>;

const AMBIGUOUS = /^(get|post|put|patch|delete|head|handler|handle|default|op|operation|index|route|action|fn|func|api|endpoint)\d*$|^.{0,2}$|[a-z]\d+$/i;

function deref(doc: Json, v: any, depth = 0): any {
  if (depth > 10 || !v || typeof v !== "object" || typeof v.$ref !== "string" || !v.$ref.startsWith("#/")) return v;
  let cur: any = doc;
  for (const p of v.$ref.slice(2).split("/")) cur = cur?.[p.replace(/~1/g, "/").replace(/~0/g, "~")];
  return deref(doc, cur, depth + 1);
}

function specOp(doc: Json, t: ManifestTool): Json | null {
  const item = deref(doc, doc.paths?.[t.path]);
  return item?.[t.method.toLowerCase()] ?? null;
}

const words = (id: string) =>
  id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .toLowerCase()
    .trim();
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const singular = (w: string) => (w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** The resource an operation is about: "/v1/orders/{id}/refund" → { noun: "order", action: "refund" }. */
function resource(path: string): { noun: string; nouns: string; action: string | null; param: string | null } {
  const segs = path.split("/").filter(Boolean).filter((s) => !/^v\d+$/.test(s) && s !== "api");
  const lastParam = [...segs].reverse().find((s) => s.startsWith("{"));
  const statics = segs.filter((s) => !s.startsWith("{"));
  const endsWithParam = segs.at(-1)?.startsWith("{") ?? false;
  const action = !endsWithParam && segs.length >= 2 && segs.at(-2)!.startsWith("{") ? segs.at(-1)! : null;
  const collection = action ? statics.at(-2) : statics.at(-1);
  const nouns = (collection ?? "item").replace(/[-_]/g, " ");
  return { noun: singular(nouns), nouns, action, param: lastParam ? lastParam.slice(1, -1) : null };
}

/** Top-level property names of the 2xx JSON response, for "The response has …". */
function responseFields(doc: Json, op: Json): string[] {
  for (const [code, r] of Object.entries((op.responses ?? {}) as Json)) {
    if (!/^2/.test(code)) continue;
    const content = deref(doc, r)?.content ?? {};
    const type = Object.keys(content).find((t) => /json/.test(t));
    const s = type ? deref(doc, content[type].schema) : null;
    if (s?.properties) return Object.keys(s.properties).slice(0, 6);
  }
  return [];
}

/** Enum values for a parameter: its own, or a response property with the same name. */
function knownValues(doc: Json, name: string, schema: any, op: Json): unknown[] | null {
  const own = deref(doc, schema);
  if (Array.isArray(own?.enum) && own.enum.length) return own.enum;
  const seen = new Set<unknown[]>();
  const find = (s: any, depth: number): unknown[] | null => {
    const r = deref(doc, s);
    if (!r || typeof r !== "object" || depth > 5 || seen.has(r)) return null;
    seen.add(r);
    const p = r.properties?.[name] && deref(doc, r.properties[name]);
    if (Array.isArray(p?.enum) && p.enum.length) return p.enum;
    for (const v of Object.values((r.properties ?? {}) as Json)) {
      const hit = find(v, depth + 1);
      if (hit) return hit;
    }
    if (r.items) return find(r.items, depth + 1);
    return null;
  };
  for (const [code, res] of Object.entries((op.responses ?? {}) as Json)) {
    if (!/^2/.test(code)) continue;
    const content = deref(doc, res)?.content ?? {};
    for (const c of Object.values(content as Json)) {
      const hit = find((c as Json).schema, 0);
      if (hit) return hit;
    }
  }
  return null;
}

function paramDescription(doc: Json, name: string, schema: any, op: Json, where: string, noun: string): string {
  const s = deref(doc, schema) ?? {};
  const n = name.toLowerCase();
  const values = knownValues(doc, name, schema, op);
  const range = typeof s.minimum === "number" && typeof s.maximum === "number" ? ` (${s.minimum}–${s.maximum})` : "";
  if (where === "path" && (n === "id" || n === `${noun.replace(/\s/g, "")}id` || n === `${noun.replace(/\s/g, "_")}_id`)) return `The ${noun}'s id, as returned by the list and create operations.`;
  if (n === "limit" || n === "per_page" || n === "perpage" || n === "page_size" || n === "pagesize") return `How many results to return in one page${range}.`;
  if (n === "cursor" || n === "after" || n === "starting_after" || n === "page_token" || n === "pagetoken") return "Where to continue from: the cursor the previous page returned (nextCursor). Leave it out for the first page.";
  if (n === "page") return "Which page to return, starting at 1.";
  if (n === "offset") return "How many results to skip.";
  if (n === "q" || n === "query" || n === "search") return "Text to search for.";
  if (values) return `Only ${noun}s with this ${words(name)}. One of: ${values.map(String).join(", ")}.`;
  if (n.endsWith("id")) return `The id of the ${words(name.replace(/_?id$/i, "")) || noun}.`;
  if (s.format === "date-time" || s.format === "date") return `A ${s.format === "date" ? "date (YYYY-MM-DD)" : "date and time (ISO 8601)"}: the ${words(name)}.`;
  return `The ${words(name)}${s.type ? ` (${s.type})` : ""}.`;
}

function describeOp(t: ManifestTool, op: Json, doc: Json): { title: string; description: string } {
  const { noun, nouns, action, param } = resource(t.path);
  const fields = responseFields(doc, op);
  const returns = fields.length ? ` The response has ${fields.join(", ")}.` : "";
  const byParam = param ? ` by its ${words(param)}` : "";
  switch (true) {
    case t.method === "GET" && !param && !action: {
      const filters = t.params.filter((p) => p.in === "query").map((p) => p.name);
      return {
        title: sentence(`list ${nouns}`),
        description: `Lists ${nouns}${filters.length ? `, filtered and paged with ${filters.join(", ")}` : ""}. Use it to find ${nouns} before acting on one.${returns}`,
      };
    }
    case t.method === "GET" && Boolean(param) && !action:
      return { title: sentence(`get ${article(noun)}`), description: `Gets one ${noun}${byParam}, with all its fields. Answers 404 when there's no such ${noun}.${returns}` };
    case t.method === "POST" && Boolean(action):
      return {
        title: sentence(`${words(action!)} ${article(noun)}`),
        description: `${sentence(words(action!))}s the ${noun} with this ${words(param ?? "id")}. It changes data: check the ${noun} first, and don't repeat it on a timeout without an Idempotency-Key.${returns}`,
      };
    case t.method === "POST":
      return { title: sentence(`create ${article(noun)}`), description: `Creates ${article(noun)} from the fields in the body and returns it. It changes data: send an Idempotency-Key so a retry doesn't create two.${returns}` };
    case t.method === "PUT" || t.method === "PATCH":
      return { title: sentence(`update ${article(noun)}`), description: `Updates the ${noun}${byParam} with the fields in the body and returns it.${returns}` };
    case t.method === "DELETE":
      return { title: sentence(`delete ${article(noun)}`), description: `Deletes the ${noun}${byParam}. This can't be undone.` };
    default:
      return { title: sentence(`${t.method.toLowerCase()} ${nouns}${action ? ` ${words(action)}` : ""}`), description: `${sentence(t.method.toLowerCase())}s ${t.path}.${returns}` };
  }
}

/** Example arguments: required ones from the schema, a body, a page size for lists, ids that look like ids. */
function exampleFor(t: ManifestTool, noun: string): Record<string, unknown> {
  const props = (t.inputSchema.properties ?? {}) as Json;
  const args: Record<string, unknown> = { ...exampleArguments(t, t.inputSchema as Json) };
  if (t.body && props[t.body.arg] && args[t.body.arg] === undefined) args[t.body.arg] = exampleValue(props[t.body.arg], t.body.arg);
  for (const p of t.params) {
    if (p.in === "path" && typeof args[p.arg] === "string" && /_123$/.test(args[p.arg] as string)) args[p.arg] = `${noun.replace(/\s+/g, "_")}_123`;
    if (p.in === "query" && /^(limit|per_page|page_size)$/i.test(p.name) && args[p.arg] === undefined) args[p.arg] = 10;
  }
  return args;
}

const article = (noun: string) => (/^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`);

export interface ImproveOptions {
  /** Suggest Idempotency-Key on writes (Agentify honours it; default true). */
  idempotency?: boolean;
  /** Mark the new suggestions accepted. */
  accept?: boolean;
}

export interface ImproveResult {
  manifest: Manifest;
  changed: Array<{ tool: string; fields: string[]; source: "rules" }>;
}

export async function improve(doc: Json, manifest: Manifest, opts: ImproveOptions = {}): Promise<ImproveResult> {
  const changed: ImproveResult["changed"] = [];
  const tools: ManifestTool[] = [];
  const usedIds = new Set(manifest.tools.map((t) => t.operationId).filter(Boolean) as string[]);
  for (const t of manifest.tools) {
    const op = specOp(doc, t);
    if (!op) {
      tools.push(t);
      continue;
    }
    const s: Partial<ToolSuggestions> = {};
    const fields: string[] = [];
    if (typeof op.operationId !== "string" || AMBIGUOUS.test(op.operationId)) {
      let id = guessOperationId(t.method, t.path);
      for (let i = 2; usedIds.has(id); i++) id = `${guessOperationId(t.method, t.path)}${i}`;
      usedIds.add(id);
      s.operationId = id;
      fields.push("operationId");
    }
    const text = describeOp(t, op, doc);
    if (typeof op.summary !== "string" || op.summary.trim().length < 3) {
      s.title = text.title;
      fields.push("summary");
    }
    const current = `${op.description ?? ""}`.trim();
    if (current.length < 40) {
      s.description = text.description;
      fields.push("description");
    }
    const params: Record<string, string> = {};
    const { noun } = resource(t.path);
    for (const raw of [...(deref(doc, doc.paths?.[t.path])?.parameters ?? []), ...(op.parameters ?? [])]) {
      const p = deref(doc, raw);
      if (!p?.name || p.in === "cookie" || p.description || deref(doc, p.schema)?.description) continue;
      params[p.name] = paramDescription(doc, p.name, p.schema, op, p.in, noun);
    }
    if (Object.keys(params).length) {
      s.params = params;
      fields.push("parameters");
    }
    const hasExample = JSON.stringify(op).includes('"example');
    if (!hasExample && !t.examples?.length) {
      s.examples = [{ description: text.title, arguments: exampleFor(t, noun) }];
      fields.push("examples");
    }
    if ((opts.idempotency ?? true) && (t.method === "POST" || t.method === "PATCH") && !(op.parameters ?? []).some((p: any) => /^idempotency-key$/i.test(deref(doc, p)?.name ?? ""))) {
      s.idempotencyKey = true;
      fields.push("Idempotency-Key");
    }
    const source = "rules" as const;
    if (!fields.length) {
      tools.push(t);
      continue;
    }
    changed.push({ tool: t.name, fields, source });
    tools.push({ ...t, suggestions: { ...s, source, accepted: opts.accept ?? t.suggestions?.accepted ?? false } as ToolSuggestions });
  }
  const out = { ...manifest, tools };
  return { manifest: opts.accept ? acceptAll(out) : out, changed };
}

/**
 * Marks every tool's suggestions accepted. An accepted operationId also
 * renames the tool, when its name is still the one made from the old id (a
 * name you chose yourself is kept).
 */
export function acceptAll(manifest: Manifest, accepted = true): Manifest {
  const used = new Set(manifest.tools.map((t) => t.name));
  return {
    ...manifest,
    tools: manifest.tools.map((t) => {
      if (!t.suggestions) return t;
      const next = { ...t, suggestions: { ...t.suggestions, accepted } };
      const id = t.suggestions.operationId;
      const auto = t.operationId ?? `${t.method.toLowerCase()}_${t.path}`.replace(/[{}]/g, "").replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").replace(/_{2,}/g, "_");
      if (accepted && id && t.name === auto.slice(0, 64) && !used.has(id)) {
        used.delete(t.name);
        used.add(id);
        next.name = id;
      }
      return next;
    }),
  };
}
