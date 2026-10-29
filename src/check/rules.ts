import { importOpenApi, pointerSegment } from "../openapi/convert.js";
import type { Manifest } from "../openapi/manifest.js";
import { mergeSuggestions } from "../surfaces/openapi.js";

/**
 * The agent-readiness check: what a model will get wrong about your API,
 * scored 0–100. Each rule has a weight; a rule's score is the share of the
 * operations (or parameters) it applies to that pass, so one bad operation in
 * fifty costs little and a spec with no descriptions at all costs a lot.
 *
 *   score = Σ weight × passing share / Σ weight × 100
 *
 * Accepted `agentify improve` suggestions count (they're what /openapi.json
 * serves), so `check` after `improve --accept` shows what agents now see.
 */

type Json = Record<string, any>;

export interface Finding {
  rule: string;
  /** "METHOD /path", a parameter, or "spec". */
  where: string;
  message: string;
}

export interface RuleResult {
  id: string;
  title: string;
  weight: number;
  applicable: number;
  passing: number;
  /** passing / applicable (1 when nothing applies). */
  share: number;
  fix: string;
  findings: Finding[];
}

export interface ReadinessReport {
  score: number;
  operations: number;
  rules: RuleResult[];
  warnings: string[];
}

interface Op {
  method: string;
  path: string;
  where: string;
  op: Json;
  params: Json[];
}

const METHODS = ["get", "put", "post", "delete", "patch", "head"];
const AMBIGUOUS = /^(get|post|put|patch|delete|head|handler|handle|default|op|operation|index|route|action|fn|func|api|endpoint)\d*$|^.{0,2}$|[a-z]\d+$/i;
const ENUM_NAMES = /^(status|state|type|kind|sort|sort_by|sortBy|order|order_by|orderBy|direction|dir|format|currency|mode|category)$/;
const PAGE_PARAMS = /^(limit|per_page|perPage|page_size|pageSize|first|last|cursor|after|before|page|offset|starting_after|ending_before|next|page_token|pageToken)$/i;

function deref(doc: Json, v: any, depth = 0): any {
  if (depth > 10 || !v || typeof v !== "object" || typeof v.$ref !== "string" || !v.$ref.startsWith("#/")) return v;
  let cur: any = doc;
  for (const p of v.$ref.slice(2).split("/")) cur = cur?.[pointerSegment(p)];
  return deref(doc, cur, depth + 1);
}

function operations(doc: Json): Op[] {
  const out: Op[] = [];
  for (const [path, rawItem] of Object.entries((doc.paths ?? {}) as Json)) {
    const item = deref(doc, rawItem);
    if (!item || typeof item !== "object") continue;
    for (const m of METHODS) {
      const op = item[m];
      if (!op || typeof op !== "object") continue;
      const byKey = new Map<string, Json>();
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        const param = deref(doc, p);
        if (param?.name && param.in) byKey.set(`${param.in}:${param.name}`, param);
      }
      out.push({ method: m.toUpperCase(), path, where: `${m.toUpperCase()} ${path}`, op, params: [...byKey.values()] });
    }
  }
  return out;
}

function jsonContent(doc: Json, content: Json | undefined): Json | null {
  if (!content || typeof content !== "object") return null;
  const type = Object.keys(content).find((t) => /\bjson\b/i.test(t));
  return type ? (deref(doc, content[type]) as Json) : null;
}

const hasExample = (doc: Json, x: any, depth = 0): boolean => {
  if (!x || typeof x !== "object" || depth > 6) return false;
  const s = deref(doc, x);
  // A $ref that leads nowhere has no example.
  if (!s || typeof s !== "object") return false;
  if (s.example !== undefined || (Array.isArray(s.examples) ? s.examples.length > 0 : s.examples && Object.keys(s.examples).length > 0)) return true;
  if (s.schema && hasExample(doc, s.schema, depth + 1)) return true;
  for (const p of Object.values((s.properties ?? {}) as Json)) if (hasExample(doc, p, depth + 1)) return true;
  return false;
};

function schemaIsEmpty(doc: Json, s: any): boolean {
  const r = deref(doc, s);
  if (!r || typeof r !== "object") return true;
  if (r["x-agentify-todo"]) return true;
  return Object.keys(r).filter((k) => !k.startsWith("x-") && k !== "description").length === 0;
}

function returnsList(doc: Json, op: Json): boolean {
  for (const [code, res] of Object.entries((op.responses ?? {}) as Json)) {
    if (!/^2/.test(code)) continue;
    const c = jsonContent(doc, deref(doc, res)?.content);
    const s = deref(doc, c?.schema);
    if (!s) continue;
    if (s.type === "array") return true;
    for (const p of Object.values((s.properties ?? {}) as Json)) if (deref(doc, p)?.type === "array") return true;
  }
  return false;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Enabled operations whose path parameters take any value. Where a hook hands out a
 * service credential (your own agent keys, paying callers), it goes to any request matching the
 * template: GET /v1/orders/{id} also matches a GET /v1/orders/export route that isn't in
 * the spec. A pattern (or enum, format, integer type) on the parameter narrows the match.
 */
export function unpatternedTemplates(manifest: Manifest | null): string[] {
  const out: string[] = [];
  for (const t of manifest?.tools ?? []) {
    if (!t.enabled) continue;
    const props = (t.inputSchema.properties ?? {}) as Record<string, Json>;
    const loose = t.params
      .filter((p) => p.in === "path")
      .filter((p) => {
        const s = props[p.arg] ?? {};
        const types = (Array.isArray(s.type) ? s.type : [s.type]).filter(Boolean);
        return !["pattern", "enum", "const", "format", "maxLength"].some((k) => k in s) && (types.length === 0 || types.includes("string"));
      })
      .map((p) => p.name);
    if (loose.length) {
      out.push(`${t.method} ${t.path}: {${loose.join("}, {")}} takes any value, so the service credential reaches any route of yours that matches this template (a static ${t.path.replace(/\{[^}]+\}[^/]*$/, "export")} too). Add a pattern to the parameter in your spec, or check X-Agentify-Operation in that route.`);
    }
  }
  return out;
}

export function readiness(specIn: Json, opts: { manifest?: Manifest | null; authMode?: string; baseUrl?: string; serviceCredential?: boolean } = {}): ReadinessReport {
  const manifest = opts.manifest ?? (() => {
    try {
      return importOpenApi(specIn).manifest;
    } catch {
      return null;
    }
  })();
  const doc = manifest ? mergeSuggestions(specIn, manifest.tools) : specIn;
  const ops = operations(doc);
  const rules: RuleResult[] = [];
  const warnings: string[] = [];
  const rule = (id: string, title: string, weight: number, fix: string, items: Array<{ where: string; ok: boolean; message?: string }>) => {
    const failing = items.filter((i) => !i.ok);
    rules.push({
      id,
      title,
      weight,
      applicable: items.length,
      passing: items.length - failing.length,
      share: items.length ? (items.length - failing.length) / items.length : 1,
      fix,
      findings: failing.map((f) => ({ rule: id, where: f.where, message: f.message ?? title })),
    });
  };

  rule(
    "operation-ids",
    "Every operation has a clear operationId",
    10,
    "Give each operation an operationId that says what it does (listOrders, refundOrder). It becomes the tool name.",
    ops.map((o) => ({
      where: o.where,
      ok: typeof o.op.operationId === "string" && !AMBIGUOUS.test(o.op.operationId),
      message: typeof o.op.operationId === "string" ? `operationId "${o.op.operationId}" is ambiguous` : "no operationId",
    })),
  );
  rule(
    "summaries",
    "Every operation has a summary",
    8,
    "Add a short summary (under 80 characters): clients show it as the tool's title.",
    ops.map((o) => ({ where: o.where, ok: typeof o.op.summary === "string" && o.op.summary.trim().length >= 3, message: "no summary" })),
  );
  const descs = ops.map((o) => `${o.op.description ?? ""}`.trim());
  const counts = new Map<string, number>();
  for (const d of descs) if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  rule(
    "descriptions",
    "Descriptions say what the operation does, when to use it, and what it returns",
    10,
    "Write a description of at least 40 characters per operation, different from the others: models pick tools by it.",
    ops.map((o, i) => {
      const d = descs[i]!;
      const ok = d.length >= 40 && (counts.get(d) ?? 0) < 2;
      return { where: o.where, ok, message: !d ? "no description" : d.length < 40 ? `description is too short (${d.length} characters)` : "description is the same as another operation's" };
    }),
  );
  const params = ops.flatMap((o) => o.params.filter((p) => p.in !== "cookie" && !(p.in === "header" && /^(authorization|x-api-key|api-key)$/i.test(p.name))).map((p) => ({ o, p })));
  rule(
    "parameter-descriptions",
    "Parameters are described",
    8,
    "Describe each parameter: its meaning, format and allowed values.",
    params.map(({ o, p }) => ({ where: `${o.where} ${p.in}:${p.name}`, ok: Boolean(p.description || deref(doc, p.schema)?.description), message: `parameter ${p.name} has no description` })),
  );
  rule(
    "enums",
    "Parameters with a fixed set of values list them",
    4,
    "Give status/sort/type-like parameters an enum (or list the values in the description).",
    params
      .filter(({ p }) => ENUM_NAMES.test(p.name) && (deref(doc, p.schema)?.type ?? "string") === "string")
      .map(({ o, p }) => ({
        where: `${o.where} ${p.in}:${p.name}`,
        ok: (Array.isArray(deref(doc, p.schema)?.enum) && deref(doc, p.schema).enum.length > 0) || /\bone of\b/i.test(p.description ?? ""),
        message: `parameter ${p.name} takes a fixed set of values but doesn't list them`,
      })),
  );
  rule(
    "examples",
    "Operations have an example",
    6,
    "Add an example for each operation (a parameter, request or response example): models copy examples.",
    ops.map((o) => {
      const body = jsonContent(doc, deref(doc, o.op.requestBody)?.content);
      const responses = Object.values((o.op.responses ?? {}) as Json).map((r) => jsonContent(doc, deref(doc, r)?.content));
      const ok =
        (Array.isArray(o.op["x-agentify-examples"]) && o.op["x-agentify-examples"].length > 0) ||
        o.params.some((p) => hasExample(doc, p)) ||
        (body !== null && hasExample(doc, body)) ||
        responses.some((r) => r !== null && hasExample(doc, r));
      return { where: o.where, ok, message: "no example" };
    }),
  );
  rule(
    "json-bodies",
    "Request bodies are JSON",
    5,
    "Accept application/json for request bodies agents send (form and multipart bodies can't be tool calls).",
    ops
      .filter((o) => o.op.requestBody)
      .map((o) => {
        const content = deref(doc, o.op.requestBody)?.content ?? {};
        return { where: o.where, ok: Object.keys(content).some((t) => /\bjson\b/i.test(t)), message: `request body is ${Object.keys(content).join(", ") || "undeclared"}` };
      }),
  );
  rule(
    "response-schemas",
    "Success responses have a JSON schema",
    8,
    "Describe what a 2xx response contains with a JSON schema, so agents know what they'll get back.",
    ops
      .filter((o) => o.method !== "HEAD")
      .map((o) => {
        const ok = Object.entries((o.op.responses ?? {}) as Json).some(([code, r]) => {
          if (!/^2/.test(code)) return false;
          if (code === "204") return true;
          const c = jsonContent(doc, deref(doc, r)?.content);
          return c !== null && !schemaIsEmpty(doc, c.schema);
        });
        return { where: o.where, ok, message: "no JSON schema for the success response" };
      }),
  );
  rule(
    "error-responses",
    "Errors are described",
    6,
    "Document the errors an operation returns (400, 404, 409…) so agents can recover instead of retrying blindly.",
    ops.map((o) => ({ where: o.where, ok: Object.keys(o.op.responses ?? {}).some((c) => /^[45]/.test(c) || c === "default"), message: "no error responses documented" })),
  );
  rule(
    "pagination",
    "List endpoints are paginated",
    6,
    "Give list operations a limit and a cursor (or page) parameter: an agent can't read ten thousand rows.",
    ops
      .filter((o) => o.method === "GET" && !/\}$/.test(o.path) && returnsList(doc, o.op))
      .map((o) => ({ where: o.where, ok: o.params.some((p) => p.in === "query" && PAGE_PARAMS.test(p.name)), message: "returns a list but has no limit/cursor/page parameter" })),
  );
  const schemes = Object.keys(doc.components?.securitySchemes ?? {});
  // `security: []` means "no auth": only a non-empty requirement counts.
  const secured = (Array.isArray(doc.security) && doc.security.length > 0) || ops.some((o) => Array.isArray(o.op.security) && o.op.security.length > 0);
  rule("security", "How to authenticate is described", 8, "Describe your auth in components.securitySchemes and apply it with security.", [
    { where: "spec", ok: schemes.length > 0 && secured, message: schemes.length ? "security schemes are defined but not applied" : "no security scheme" },
  ]);
  rule(
    "idempotency",
    "Writes have an idempotency story",
    5,
    "Accept an Idempotency-Key header on POST/PATCH (Agentify honours it for agents), so a retry doesn't do the work twice.",
    ops
      .filter((o) => o.method === "POST" || o.method === "PATCH")
      .map((o) => ({ where: o.where, ok: o.params.some((p) => p.in === "header" && /^idempotency-key$/i.test(p.name)) || o.op["x-idempotent"] === true, message: "no Idempotency-Key" })),
  );
  const enabled = manifest?.tools.filter((t) => t.enabled) ?? [];
  const collisions = (manifest?.tools ?? []).filter((t) => /_\d+$/.test(t.name) && t.operationId && t.name !== t.operationId);
  rule(
    "tool-count",
    "A manageable number of tools, with distinct names",
    4,
    "Keep enabled tools to about 40 per server (models choose worse from long lists), and give operations distinct operationIds.",
    [
      { where: "spec", ok: enabled.length <= 40, message: `${plural(enabled.length, "tool")} enabled (more than 40)` },
      ...collisions.map((t) => ({ where: t.operation, ok: false, message: `tool name collided and became ${t.name}` })),
    ],
  );

  if (opts.authMode === "passthrough" && opts.baseUrl && Array.isArray(specIn.servers)) {
    for (const s of specIn.servers) {
      try {
        if (typeof s?.url === "string" && /^https?:\/\//.test(s.url) && new URL(s.url).origin !== new URL(opts.baseUrl).origin) {
          warnings.push(`passthrough: the spec's server ${s.url} is not baseUrl (${opts.baseUrl}). Forwarding agents' credentials is only safe to the same API; use agent-keys or oauth if these differ in production.`);
        }
      } catch {
        // an unparseable server URL isn't our concern here
      }
    }
  }
  if (opts.serviceCredential) warnings.push(...unpatternedTemplates(opts.manifest ?? null));
  if (ops.length === 0) warnings.push("The spec has no operations.");

  const total = rules.reduce((s, r) => s + r.weight, 0);
  const score = Math.round((rules.reduce((s, r) => s + r.weight * r.share, 0) / total) * 100);
  return { score, operations: ops.length, rules, warnings };
}

/** The report as text for the terminal. */
export function formatReport(r: ReadinessReport, opts: { color?: boolean; max?: number } = {}): string {
  const c = (code: string, s: string) => (opts.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const lines = [`Agent readiness: ${c(r.score >= 80 ? "32" : r.score >= 60 ? "33" : "31", `${r.score}/100`)} (${plural(r.operations, "operation")})`, ""];
  for (const rule of r.rules) {
    const mark = rule.share === 1 ? c("32", "✔") : c("31", "✖");
    lines.push(`${mark} ${rule.title} ${c("2", `${rule.passing}/${rule.applicable} · weight ${rule.weight}`)}`);
    if (rule.share < 1) {
      lines.push(`    ${c("36", "fix:")} ${rule.fix}`);
      for (const f of rule.findings.slice(0, opts.max ?? 5)) lines.push(`    - ${f.where}: ${f.message}`);
      if (rule.findings.length > (opts.max ?? 5)) lines.push(`    - … and ${rule.findings.length - (opts.max ?? 5)} more`);
    }
  }
  for (const w of r.warnings) lines.push("", `${c("33", "!")} ${w}`);
  return lines.join("\n");
}
