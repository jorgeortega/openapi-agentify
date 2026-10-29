import ts from "typescript";

/**
 * Zod schemas → JSON Schema, statically: the source text is read, never run.
 * Handles the common builders (object, string, number, boolean, enum, array,
 * literal, union, optional, nullable, default, describe, openapi(), coerce,
 * min/max/length, email/url/uuid/datetime) and constants declared in the same
 * file. Anything else becomes `{}` marked `x-agentify-todo`.
 */

export type Json = Record<string, any>;

export interface Resolver {
  /** The initializer of a `const` in the same file, or null. */
  constant(name: string): ts.Expression | null;
}

export const todo = (why: string): Json => ({ "x-agentify-todo": why });

/** A literal value (for defaults, enums, examples, Fastify schema objects). */
export function literal(node: ts.Expression, r: Resolver, depth = 0): unknown {
  if (depth > 20) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression, r, depth + 1);
  if (ts.isArrayLiteralExpression(node)) {
    const out: unknown[] = [];
    for (const e of node.elements) {
      const v = literal(e as ts.Expression, r, depth + 1);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const p of node.properties) {
      if (ts.isPropertyAssignment(p)) {
        const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : null;
        if (key === null) return undefined;
        const v = literal(p.initializer, r, depth + 1);
        if (v === undefined) return undefined;
        out[key] = v;
      } else if (ts.isShorthandPropertyAssignment(p)) {
        const c = r.constant(p.name.text);
        const v = c ? literal(c, r, depth + 1) : undefined;
        if (v === undefined) return undefined;
        out[p.name.text] = v;
      } else if (ts.isSpreadAssignment(p)) {
        const v = literal(p.expression, r, depth + 1);
        if (!v || typeof v !== "object") return undefined;
        Object.assign(out, v);
      } else return undefined;
    }
    return out;
  }
  if (ts.isIdentifier(node)) {
    const c = r.constant(node.text);
    return c ? literal(c, r, depth + 1) : undefined;
  }
  return undefined;
}

/** Walks `z.string().min(1).optional()` into [root call, ...method calls]. */
function chain(node: ts.Expression): { root: ts.CallExpression | ts.Identifier | null; calls: Array<{ name: string; args: readonly ts.Expression[] }> } {
  const calls: Array<{ name: string; args: readonly ts.Expression[] }> = [];
  let cur: ts.Expression = node;
  for (;;) {
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      const obj = cur.expression.expression;
      const name = cur.expression.name.text;
      // z.string() / z.coerce.number() is the root; x.optional() is a modifier.
      if (ts.isIdentifier(obj) && (obj.text === "z" || obj.text === "zod")) return { root: cur, calls: calls.reverse() };
      if (ts.isPropertyAccessExpression(obj) && ts.isIdentifier(obj.expression) && (obj.expression.text === "z" || obj.expression.text === "zod") && obj.name.text === "coerce") return { root: cur, calls: calls.reverse() };
      calls.push({ name, args: cur.arguments });
      cur = obj;
      continue;
    }
    if (ts.isIdentifier(cur)) return { root: cur, calls: calls.reverse() };
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    return { root: null, calls: calls.reverse() };
  }
}

export function zodToSchema(node: ts.Expression, r: Resolver, depth = 0): { schema: Json; optional: boolean } {
  if (depth > 16) return { schema: todo("schema nested too deeply to read"), optional: false };
  const { root, calls } = chain(node);
  let schema: Json;
  let optional = false;
  if (!root) return { schema: todo(`not a zod schema: ${node.getText().slice(0, 60)}`), optional: false };
  if (ts.isIdentifier(root)) {
    const c = r.constant(root.text);
    if (!c) return { schema: todo(`schema ${root.text} is defined in another file`), optional: false };
    const inner = zodToSchema(c, r, depth + 1);
    schema = { ...inner.schema };
    optional = inner.optional;
  } else {
    const kind = (root.expression as ts.PropertyAccessExpression).name.text;
    const args = root.arguments;
    switch (kind) {
      case "string":
        schema = { type: "string" };
        break;
      case "number":
        schema = { type: "number" };
        break;
      case "bigint":
        schema = { type: "integer" };
        break;
      case "boolean":
        schema = { type: "boolean" };
        break;
      case "date":
        schema = { type: "string", format: "date-time" };
        break;
      case "email":
        schema = { type: "string", format: "email" };
        break;
      case "uuid":
        schema = { type: "string", format: "uuid" };
        break;
      case "url":
        schema = { type: "string", format: "uri" };
        break;
      case "any":
      case "unknown":
        schema = {};
        break;
      case "null":
        schema = { type: "null" };
        break;
      case "literal": {
        const v = args[0] ? literal(args[0], r) : undefined;
        schema = v === undefined ? todo("z.literal of a non-literal") : { const: v };
        break;
      }
      case "enum": {
        const v = args[0] ? literal(args[0], r) : undefined;
        schema = Array.isArray(v) ? { type: "string", enum: v } : todo("z.enum of values defined elsewhere");
        break;
      }
      case "array": {
        schema = { type: "array", items: args[0] ? zodToSchema(args[0], r, depth + 1).schema : {} };
        break;
      }
      case "union": {
        const v = args[0] && ts.isArrayLiteralExpression(args[0]) ? args[0].elements.map((e) => zodToSchema(e as ts.Expression, r, depth + 1).schema) : null;
        schema = v ? { anyOf: v } : todo("z.union of schemas defined elsewhere");
        break;
      }
      case "record":
        schema = { type: "object", additionalProperties: args.length ? zodToSchema(args[args.length - 1]!, r, depth + 1).schema : {} };
        break;
      case "object":
      case "strictObject":
      case "looseObject": {
        const shape = args[0];
        if (!shape || !ts.isObjectLiteralExpression(shape)) {
          schema = todo("z.object with a shape defined elsewhere");
          break;
        }
        const properties: Json = {};
        const required: string[] = [];
        for (const p of shape.properties) {
          if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) continue;
          const inner = zodToSchema(p.initializer, r, depth + 1);
          properties[p.name.text] = inner.schema;
          if (!inner.optional) required.push(p.name.text);
        }
        schema = { type: "object", properties, ...(required.length ? { required } : {}), ...(kind === "strictObject" ? { additionalProperties: false } : {}) };
        break;
      }
      default:
        schema = todo(`z.${kind}() isn't read statically`);
    }
  }
  for (const c of calls) {
    const a0 = c.args[0] ? literal(c.args[0], r) : undefined;
    switch (c.name) {
      case "optional":
      case "nullish":
        optional = true;
        if (c.name === "nullish") schema = { anyOf: [schema, { type: "null" }] };
        break;
      case "nullable":
        schema = { anyOf: [schema, { type: "null" }] };
        break;
      case "default":
        optional = true;
        if (a0 !== undefined) schema.default = a0;
        break;
      case "describe":
        if (typeof a0 === "string") schema.description = a0;
        break;
      case "openapi": {
        const o = a0 as Json | undefined;
        if (o && typeof o === "object") {
          if (typeof o.description === "string") schema.description = o.description;
          if (o.example !== undefined) schema.examples = [o.example];
        }
        break;
      }
      case "min":
      case "gte":
        if (typeof a0 === "number") schema[schema.type === "string" ? "minLength" : schema.type === "array" ? "minItems" : "minimum"] = a0;
        break;
      case "max":
      case "lte":
        if (typeof a0 === "number") schema[schema.type === "string" ? "maxLength" : schema.type === "array" ? "maxItems" : "maximum"] = a0;
        break;
      case "length":
        if (typeof a0 === "number") Object.assign(schema, schema.type === "array" ? { minItems: a0, maxItems: a0 } : { minLength: a0, maxLength: a0 });
        break;
      case "int":
        schema.type = "integer";
        break;
      case "positive":
        schema.exclusiveMinimum = 0;
        break;
      case "nonnegative":
        schema.minimum = 0;
        break;
      case "email":
        schema.format = "email";
        break;
      case "url":
        schema.format = "uri";
        break;
      case "uuid":
        schema.format = "uuid";
        break;
      case "datetime":
        schema.format = "date-time";
        break;
      case "regex":
        if (c.args[0] && ts.isRegularExpressionLiteral(c.args[0])) schema.pattern = c.args[0].text.replace(/^\/|\/[a-z]*$/g, "");
        break;
      case "nonempty":
        schema[schema.type === "array" ? "minItems" : "minLength"] = 1;
        break;
      case "strict":
        schema.additionalProperties = false;
        break;
      default:
      // .trim(), .toLowerCase(), .refine()… don't change the shape
    }
  }
  return { schema, optional };
}
