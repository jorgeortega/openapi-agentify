import { _, Ajv2020, type ErrorObject, type KeywordCxt, str } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { z } from "zod";
import type { Principal } from "../principal.js";
import type { Logger } from "../util/log.js";

/**
 * One registry for every tool the MCP endpoint exposes:
 *
 *   - one per enabled operation in agentify.tools.json, validated with JSON
 *     Schema 2020-12 (Ajv), dispatched into your app in-process;
 *   - code tools written with `defineTool()` and a Zod schema, for tools that
 *     aren't routes.
 */

// ajv-formats is CommonJS; under NodeNext the default import is the plugin itself.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image" | "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string; description?: string };

export interface ToolOutput {
  content: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  /** Operation tools: the app's HTTP status. */
  status?: number;
  /** The app replayed a stored answer (Idempotency-Key): nothing new ran, so nothing is charged. */
  replayed?: boolean;
  /** Response bytes read from the app. */
  bytes?: number;
}

export interface ToolContext {
  principal: Principal;
  requestId: string;
  signal: AbortSignal;
  logger: Logger;
  /** Calls your app in-process, as this agent (credentials and X-Agentify-* headers added). */
  fetchApp: (path: string, init?: RequestInit) => Promise<Response>;
  /** Internal: what operation tools need to build their request. */
  call: { origin: string; headers: Record<string, string>; dispatch: (request: Request) => Promise<Response> };
}

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type Validation = { ok: true; value: unknown } | { ok: false; issues: Array<{ path: string; message: string }> };

/** The most values a tool call's arguments may hold (`maxArgumentValues`), unless the config says otherwise. */
export const DEFAULT_MAX_ARGUMENT_VALUES = 10_000;

/**
 * How many values `value` holds, itself included: every object, array, string,
 * number, boolean and null, at any depth (an object's keys aren't values).
 * Counting stops once it passes `most`: the answer is then some number above
 * `most`. Only an object's keys are listed in full (V8 can't count them
 * otherwise), which costs less than parsing them did.
 */
export function countValues(value: unknown, most = Number.POSITIVE_INFINITY): number {
  let count = 1;
  const todo = [value];
  while (todo.length) {
    const v = todo.pop();
    if (v === null || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      count += v.length;
      if (count > most) return count;
      for (const item of v) todo.push(item);
    } else {
      const keys = Object.keys(v);
      count += keys.length;
      if (count > most) return count;
      for (const key of keys) todo.push((v as Record<string, unknown>)[key]);
    }
  }
  return count;
}

/**
 * Arguments with more than `most` values, refused before their schema runs:
 * checking them takes time in proportion to their values, and Ajv keeps an
 * error for every value that fails.
 */
export function tooManyValues(most: number): Validation {
  return {
    ok: false,
    issues: [{ path: "", message: `must NOT have more than ${most} values, counting every object, array, string, number, boolean and null at any depth` }],
  };
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchemaObject;
  validate: (input: unknown) => Validation;
  handler: (input: any, ctx: ToolContext) => Promise<ToolOutput>;
  /** Scope required to call it, for callers with scopes (see Principal). Default api:read for reads, api:write otherwise. */
  scope?: string;
  /** Price per call in US dollars ("0.01"). Agentify charges nothing itself: a hook that takes payments reads it. */
  price?: string;
  timeoutMs?: number;
  annotations?: ToolAnnotations;
  /** A per-tool rate, for a rate-limiting hook. */
  rateLimit?: { capacity: number; refillPerSec: number };
  /** How heavy one call is, for a rate-limiting hook (default 1). */
  weight?: number;
  source: "openapi" | "code";
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
export const PRICE = /^(0|[1-9]\d{0,5})(\.\d{1,6})?$/;

// One Ajv instance for all imported schemas. Non-strict: OpenAPI documents are
// full of keywords JSON Schema doesn't know (example, x-*, discriminator).
const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true, validateFormats: true }));

// Tool arguments and path parameters are checked before any hook (a credential
// check, a payment), so validation must take linear time: one anonymous request
// reaches it.

/**
 * ajv-formats' `url`, with its user info `(?:\S+(?::\S*)?@)?` written
 * `(?:\S+@)?`: the same strings (`:` is in `\S`), but the original backtracks
 * quadratically, so `http://:@:@…` of 32 KB took half a second.
 */
export const URL_FORMAT =
  /^(?:https?|ftp):\/\/(?:\S+@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu;
ajv.addFormat("url", URL_FORMAT);

// Ajv's own uniqueItems compares objects and arrays pairwise: 32,000 of them
// took nine seconds. This one numbers the items' JSON values in one pass.
ajv.removeKeyword("uniqueItems");
ajv.addKeyword({
  keyword: "uniqueItems",
  type: "array",
  schemaType: "boolean",
  error: {
    message: ({ params }) => str`must NOT have duplicate items (items ## ${params.j} and ${params.i} are identical)`,
    params: ({ params }) => _`{i: ${params.i}, j: ${params.j}}`,
  },
  code(cxt: KeywordCxt) {
    if (!cxt.schema) return;
    const repeat = cxt.gen.const("repeat", _`${cxt.gen.scopeValue("func", { ref: repeatedItems })}(${cxt.data})`);
    cxt.setParams({ i: _`${repeat}[0]`, j: _`${repeat}[1]` });
    cxt.fail(repeat);
  },
});

/**
 * The last item equal to an earlier one and the nearest such earlier one (the
 * two Ajv named), or undefined. Equal means equal as JSON, as in Ajv: object
 * key order doesn't count, 1 and 1.0 are one number, true isn't 1.
 */
function repeatedItems(items: unknown[]): [number, number] | undefined {
  const idOf = jsonIds();
  const last = new Map<number, number>();
  let repeat: [number, number] | undefined;
  for (let i = 0; i < items.length; i++) {
    const id = idOf(items[i]);
    const j = last.get(id);
    if (j !== undefined) repeat = [i, j];
    last.set(id, i);
  }
  return repeat;
}

/** Marks where an array (no keys) or an object (its keys, sorted) ends, once its members have ids. */
class Close {
  constructor(
    readonly size: number,
    readonly keys?: string[],
  ) {}
}

/**
 * Numbers JSON values: equal values get the same id, and only they do. Without
 * recursion, so nesting costs no stack. Only JSON gets here (parsed arguments,
 * path parameters); anything else is equal only to itself.
 */
function jsonIds(): (value: unknown) => number {
  const ids = new Map<string, number>();
  const others = new Map<unknown, number>();
  const id = (key: string) => {
    let n = ids.get(key);
    if (n === undefined) ids.set(key, (n = ids.size));
    return n;
  };
  return (value) => {
    const todo: unknown[] = [value];
    const done: number[] = [];
    while (todo.length > 0) {
      const v = todo.pop();
      if (v instanceof Close) {
        const members = done.splice(done.length - v.size);
        const { keys } = v;
        done.push(id(keys ? `{${members.map((m, k) => `${JSON.stringify(keys[k])}:${m}`).join()}}` : `[${members.join()}]`));
      } else if (Array.isArray(v)) {
        todo.push(new Close(v.length));
        for (let k = v.length - 1; k >= 0; k--) todo.push(v[k]);
      } else if (isPlainObject(v)) {
        const keys = Object.keys(v).sort();
        todo.push(new Close(keys.length, keys));
        for (let k = keys.length - 1; k >= 0; k--) todo.push(v[keys[k]!]);
      } else if (typeof v === "string") {
        done.push(id(JSON.stringify(v)));
      } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
        done.push(id(String(v))); // -0 is "0", as -0 === 0
      } else {
        let n = others.get(v);
        if (n === undefined) others.set(v, (n = others.size));
        done.push(id(`#${n}`));
      }
    }
    return done[0]!;
  };
}

function ajvIssues(errors: ErrorObject[] | null | undefined) {
  return (errors ?? []).slice(0, 20).map((e) => ({
    path: e.instancePath.replace(/^\//, "").replace(/\//g, ".") || (e.params as { missingProperty?: string }).missingProperty || "",
    message: e.message ?? "is invalid",
  }));
}

export function jsonSchemaValidator(name: string, schema: JsonSchemaObject): (input: unknown) => Validation {
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    throw new Error(`Tool ${name}: inputSchema is not valid JSON Schema: ${(err as Error).message}`);
  }
  return (input) => (validate(input) ? { ok: true, value: input } : { ok: false, issues: ajvIssues(validate.errors) });
}

export function zodToJsonSchema(schema: z.ZodType): JsonSchemaObject {
  const js = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete js.$schema;
  if (js.type !== "object") throw new Error("Tool input schemas must be z.object(...)");
  return js as JsonSchemaObject;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export function isToolOutput(v: unknown): v is ToolOutput {
  return isPlainObject(v) && Array.isArray(v.content);
}

/** Turns whatever a handler returned into MCP content (+ structuredContent for objects). */
export function toToolOutput(value: unknown): ToolOutput {
  if (isToolOutput(value)) return value;
  if (value === undefined || value === null) return { content: [{ type: "text", text: "ok" }] };
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isPlainObject(value) ? { structuredContent: value } : {}),
  };
}

export function textError(text: string, structured?: unknown): ToolOutput {
  return { content: [{ type: "text", text }], isError: true, ...(structured === undefined ? {} : { structuredContent: structured }) };
}

export interface CodeToolDefinition<I extends z.ZodObject> extends Omit<ToolDefinition, "inputSchema" | "validate" | "handler" | "source"> {
  input: I;
  /** Return a string, any JSON value, or a ToolOutput. Throw ToolError for errors the model should see. */
  handler: (input: z.infer<I>, ctx: ToolContext) => Promise<unknown>;
}

/** A hand-written tool with a Zod input schema, for work that isn't one of your routes. */
export function defineTool<I extends z.ZodObject>(def: CodeToolDefinition<I>): ToolDefinition {
  const { input, handler, ...rest } = def;
  return {
    ...rest,
    source: "code",
    inputSchema: zodToJsonSchema(input),
    validate: (raw) => {
      const parsed = input.safeParse(raw);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
    },
    handler: async (value, ctx) => toToolOutput(await handler(value as z.infer<I>, ctx)),
  };
}

export type CallStatus = "ok" | "error" | "invalid_input";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(...defs: ToolDefinition[]): this {
    for (const d of defs) {
      if (!TOOL_NAME.test(d.name)) throw new Error(`Invalid tool name "${d.name}": use 1–128 of A-Z a-z 0-9 _ - .`);
      if (this.tools.has(d.name)) throw new Error(`Duplicate tool: ${d.name}`);
      if (d.price !== undefined && !PRICE.test(d.price)) throw new Error(`Tool ${d.name}: price must be US dollars like "0.01"`);
      this.tools.set(d.name, d);
    }
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** In registration order, so the list (and clients' prompt caches) are stable. */
  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * Runs one (already validated) tool. Never throws for tool-level problems:
   * timeouts and handler errors come back as `isError` results the model can
   * read (MCP "tool execution errors").
   *
   * A call cut short (timeout, or the client went away) comes back with
   * `pending`: the handler's own promise. The handler got an aborted signal, but
   * your app may still finish the work, so the outcome is unknown until then
   * (a paid call settles on that outcome, never on the timeout).
   */
  async call(tool: ToolDefinition, value: unknown, ctx: ToolContext): Promise<{ output: ToolOutput; status: CallStatus; error?: string; pending?: Promise<ToolOutput> }> {
    const timeoutMs = tool.timeoutMs ?? 30_000;
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
    const run = Promise.resolve().then(() => tool.handler(value, { ...ctx, signal }));
    let cut = false;
    try {
      const output = await Promise.race([
        run,
        // Enforce the timeout even for handlers that ignore the signal.
        new Promise<never>((_, reject) => {
          const stop = () => {
            cut = true;
            reject(new ToolError(ctx.signal.aborted ? `${tool.name} was cancelled` : `${tool.name} timed out after ${timeoutMs} ms`));
          };
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });
        }),
      ]);
      return { output, status: output.isError ? "error" : "ok", error: output.isError ? firstText(output) : undefined };
    } catch (err) {
      const pending = cut ? run : undefined;
      pending?.catch(() => {}); // whoever takes it handles the outcome
      if (err instanceof ToolError) {
        return { output: textError(err.message, err.details === undefined ? undefined : { error: err.message, details: err.details }), status: "error", error: err.message, ...(pending ? { pending } : {}) };
      }
      // Unexpected failures are logged in full but not shown to the model.
      ctx.logger.error("tool_failed", { tool: tool.name, err });
      return { output: textError(`${tool.name} failed unexpectedly (request ${ctx.requestId})`), status: "error", error: (err as Error)?.message ?? String(err) };
    }
  }
}

/**
 * Checks one path parameter (a string from the URL) against its schema, when
 * the schema constrains it (pattern, enum, format, a numeric type…). Null when
 * it doesn't: any value matches, which is why `agentify check` flags it.
 */
export function pathParamValidator(schema: unknown): ((raw: string) => boolean) | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const s = schema as Record<string, unknown>;
  const types = (Array.isArray(s.type) ? s.type : [s.type]).filter((t): t is string => typeof t === "string");
  const typed = types.length > 0 && !types.includes("string");
  const keywords = ["pattern", "enum", "const", "format", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"];
  if (!typed && !keywords.some((k) => k in s)) return null;
  let validate: (v: unknown) => boolean;
  try {
    validate = ajv.compile(s) as unknown as (v: unknown) => boolean;
  } catch {
    return null;
  }
  return (raw) => {
    let v: unknown = raw;
    if (typed && (types.includes("integer") || types.includes("number"))) {
      if (!/^-?\d+(\.\d+)?$/.test(raw)) return false;
      v = Number(raw);
    } else if (typed && types.includes("boolean")) {
      if (raw !== "true" && raw !== "false") return false;
      v = raw === "true";
    }
    return Boolean(validate(v));
  };
}

export function firstText(output: ToolOutput): string | undefined {
  const t = output.content.find((b) => b.type === "text");
  return t && t.type === "text" ? t.text.slice(0, 500) : undefined;
}
