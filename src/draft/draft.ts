import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import ts from "typescript";
import type { Framework } from "../cli/project.js";
import { type Json, literal, type Resolver, todo, zodToSchema } from "./zod.js";

/**
 * `agentify draft`: a draft OpenAPI 3.1 document from your routes, by reading
 * the source (TypeScript's parser; your code is never run).
 *
 *   Express   app.get("/x/:id", …), express.Router(), app.use("/prefix", router),
 *             app.route("/x").get(…).post(…), routers imported from other files
 *   Hono      app.get(…), app.route("/prefix", sub), new Hono().basePath("/v1"),
 *             zValidator("json" | "query" | "param", zodSchema),
 *             @hono/zod-openapi createRoute({ method, path, request, responses })
 *   Fastify   fastify.get(path, { schema }, h), fastify.route({ method, url, schema }),
 *             app.register(plugin, { prefix }) — route `schema` blocks are JSON Schema already
 *   Next.js   app/**\/route.{ts,js}: [id] → {id}, (groups) dropped, exported GET/POST/…
 *
 * Zod schemas it can resolve in the same file become JSON Schema; anything else
 * is `{}` marked `x-agentify-todo`. Every guess is listed.
 */

export interface DraftRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  params?: Json;
  query?: Json;
  body?: Json;
  responses?: Json;
  summary?: string;
  description?: string;
  operationId?: string;
}

export interface DraftResult {
  spec: Json;
  routes: DraftRoute[];
  guesses: string[];
  files: number;
}

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".git", "coverage", "test", "tests", "__tests__", ".turbo", ".vercel", "out"]);
const EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts", ".jsx"]);

export function sourceFiles(dir: string, limit = 3000): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (out.length >= limit) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (EXT.has(extname(e.name)) && !/\.(test|spec|d)\.[cm]?[jt]sx?$/.test(e.name) && !/\.config\.[cm]?[jt]s$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** "/orders/:id" → "/orders/{id}"; "(.*)" and regex routes are left for review. */
export function toOpenApiPath(path: string): { path: string; params: string[]; guess: string | null } {
  const params: string[] = [];
  let guess: string | null = null;
  const out = path
    .split("/")
    .map((seg) => {
      const m = /^:([A-Za-z_][\w]*)(\?)?(\(.*\))?$/.exec(seg);
      if (m) {
        params.push(m[1]!);
        if (m[2]) guess = `optional parameter :${m[1]}? treated as required`;
        if (m[3]) guess = `parameter :${m[1]} has a pattern ${m[3]}`;
        return `{${m[1]}}`;
      }
      if (seg === "*" || seg.includes("*")) guess = "wildcard path segment";
      const brace = /^\{([A-Za-z_]\w*)\}$/.exec(seg);
      if (brace) params.push(brace[1]!);
      return seg;
    })
    .join("/");
  return { path: out.replace(/\/+/g, "/").replace(/(.)\/$/, "$1") || "/", params, guess };
}

function joinPath(prefix: string, path: string): string {
  const p = `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return p === "" ? "/" : p.replace(/(.)\/$/, "$1");
}

// ── Express / Hono / Fastify ───────────────────────────────────────────────

interface FileInfo {
  file: string;
  sf: ts.SourceFile;
  consts: Map<string, ts.Expression>;
  /** local name → { module file, imported name ("default" or a name) } */
  imports: Map<string, { from: string; name: string }>;
  /** exported name → local name */
  exports: Map<string, string>;
}

type NodeKey = string; // `${file}#${local}`

interface Mount {
  parent: NodeKey;
  child: NodeKey;
  prefix: string;
}

interface RawRoute extends Omit<DraftRoute, "path"> {
  node: NodeKey;
  path: string;
}

const isPathLiteral = (e: ts.Expression | undefined): e is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  Boolean(e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && (e.text.startsWith("/") || e.text === "" || e.text === "*"));

function resolveModule(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const tries = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), base.replace(/\.mjs$/, ".mts"), ...[".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts"].map((e) => base + e), ...[".ts", ".js", ".mjs"].map((e) => join(base, `index${e}`))];
  return tries.find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
}

function readFile(file: string): FileInfo {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const consts = new Map<string, ts.Expression>();
  const imports = new Map<string, { from: string; name: string }>();
  const exports = new Map<string, string>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) consts.set(n.name.text, n.initializer);
    if (ts.isFunctionDeclaration(n) && n.name) consts.set(n.name.text, n as unknown as ts.Expression);
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause) {
      const from = resolveModule(file, n.moduleSpecifier.text);
      if (from) {
        if (n.importClause.name) imports.set(n.importClause.name.text, { from, name: "default" });
        const nb = n.importClause.namedBindings;
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) imports.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
      }
    }
    // const x = require("./routes") · const { a, b: c } = require("./routes")
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression) && n.initializer.expression.text === "require") {
      const a = n.initializer.arguments[0];
      const from = a && ts.isStringLiteral(a) ? resolveModule(file, a.text) : null;
      if (from && ts.isIdentifier(n.name)) imports.set(n.name.text, { from, name: "default" });
      if (from && ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) if (ts.isIdentifier(el.name)) imports.set(el.name.text, { from, name: el.propertyName ? el.propertyName.getText() : el.name.text });
      }
    }
    // module.exports = { a, b } · exports.a = a
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)) {
      const left = n.left.getText();
      if (left === "module.exports" && ts.isObjectLiteralExpression(n.right)) {
        for (const p of n.right.properties) {
          if (ts.isShorthandPropertyAssignment(p)) exports.set(p.name.text, p.name.text);
          else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer)) exports.set(p.name.getText(), p.initializer.text);
        }
      }
      const m = /^(?:module\.)?exports\.(\w+)$/.exec(left);
      if (m && ts.isIdentifier(n.right)) exports.set(m[1]!, n.right.text);
    }
    if (ts.isExportAssignment(n) && ts.isIdentifier(n.expression)) exports.set("default", n.expression.text);
    if ((ts.isVariableStatement(n) || ts.isFunctionDeclaration(n)) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      const isDefault = n.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) exports.set(d.name.text, d.name.text);
      if (ts.isFunctionDeclaration(n) && n.name) exports.set(isDefault ? "default" : n.name.text, n.name.text);
    }
    if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause) && !n.moduleSpecifier) for (const el of n.exportClause.elements) exports.set(el.name.text, (el.propertyName ?? el.name).text);
    // module.exports = router
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.getText() === "module.exports" && ts.isIdentifier(n.right)) exports.set("default", n.right.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { file, sf, consts, imports, exports };
}

/** The identifier at the root of `a.b().c().get` (for chains like app.route("/x").get(…)). */
function rootIdentifier(e: ts.Expression): ts.Identifier | null {
  let cur: ts.Expression = e;
  for (;;) {
    if (ts.isIdentifier(cur)) return cur;
    if (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
    else if (ts.isCallExpression(cur)) cur = cur.expression;
    else if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else return null;
  }
}

/** For chains `app.route("/x").get(h)`: the prefix set by .route("/x") in the chain below `call`. */
function chainPrefix(expr: ts.Expression): string {
  let prefix = "";
  let cur: ts.Expression = expr;
  while (ts.isCallExpression(cur) || ts.isPropertyAccessExpression(cur)) {
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression) && cur.expression.name.text === "route" && cur.arguments.length === 1 && isPathLiteral(cur.arguments[0])) {
      prefix = joinPath(cur.arguments[0].text, prefix);
    }
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression) && cur.expression.name.text === "basePath" && isPathLiteral(cur.arguments[0])) {
      prefix = joinPath(cur.arguments[0].text, prefix);
    }
    cur = ts.isCallExpression(cur) ? cur.expression : cur.expression;
  }
  return prefix;
}

function lineOf(sf: ts.SourceFile, n: ts.Node) {
  return sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
}

const propOf = (o: ts.ObjectLiteralExpression, name: string) =>
  o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name)?.initializer;

/** Fastify `{ schema: { params, querystring, body, response } }` → parts, as literal JSON Schema. */
function fastifySchema(opts: ts.ObjectLiteralExpression | undefined, r: Resolver): Partial<DraftRoute> {
  const expr = opts ? propOf(opts, "schema") : undefined;
  const s = expr ? (literal(expr, r) as Json | undefined) : undefined;
  if (!s || typeof s !== "object") return {};
  return {
    ...(s.params ? { params: s.params } : {}),
    ...(s.querystring ?? s.query ? { query: s.querystring ?? s.query } : {}),
    ...(s.body ? { body: s.body } : {}),
    ...(s.response ? { responses: s.response } : {}),
    ...(typeof s.summary === "string" ? { summary: s.summary } : {}),
    ...(typeof s.description === "string" ? { description: s.description } : {}),
    ...(typeof s.operationId === "string" ? { operationId: s.operationId } : {}),
  };
}

/** Hono: zValidator("json" | "query" | "param", schema) among a route's handlers. */
function honoValidators(args: readonly ts.Expression[], r: Resolver): Partial<DraftRoute> {
  const out: Partial<DraftRoute> = {};
  for (const a of args) {
    if (!ts.isCallExpression(a) || !ts.isIdentifier(a.expression) || !/^(zValidator|validator)$/.test(a.expression.text)) continue;
    const target = a.arguments[0] && ts.isStringLiteral(a.arguments[0]) ? a.arguments[0].text : null;
    if (!target || !a.arguments[1] || a.expression.text !== "zValidator") continue;
    const s = zodToSchema(a.arguments[1], r).schema;
    if (target === "json") out.body = s;
    if (target === "query") out.query = s;
    if (target === "param") out.params = s;
  }
  return out;
}

/** @hono/zod-openapi createRoute({ method, path, request, responses }). */
function zodOpenApiRoute(e: ts.Expression, r: Resolver): Partial<DraftRoute> & { method?: string; path?: string } {
  const call = ts.isIdentifier(e) ? r.constant(e.text) : e;
  if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "createRoute") return {};
  const obj = call.arguments[0];
  if (!obj || !ts.isObjectLiteralExpression(obj)) return {};
  const prop = (o: ts.ObjectLiteralExpression, name: string) => o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name)?.initializer;
  const out: Partial<DraftRoute> & { method?: string; path?: string } = {};
  const m = prop(obj, "method");
  const p = prop(obj, "path");
  if (m && ts.isStringLiteral(m)) out.method = m.text;
  if (p && ts.isStringLiteral(p)) out.path = p.text;
  for (const k of ["summary", "description", "operationId"] as const) {
    const v = prop(obj, k);
    if (v && ts.isStringLiteral(v)) out[k] = v.text;
  }
  const req = prop(obj, "request");
  if (req && ts.isObjectLiteralExpression(req)) {
    const params = prop(req, "params");
    const query = prop(req, "query");
    if (params) out.params = zodToSchema(params, r).schema;
    if (query) out.query = zodToSchema(query, r).schema;
    const body = prop(req, "body");
    if (body && ts.isObjectLiteralExpression(body)) {
      const content = prop(body, "content");
      const json = content && ts.isObjectLiteralExpression(content) ? prop(content, "application/json") : undefined;
      const schema = json && ts.isObjectLiteralExpression(json) ? prop(json, "schema") : undefined;
      if (schema) out.body = zodToSchema(schema, r).schema;
    }
  }
  const responses = prop(obj, "responses");
  if (responses && ts.isObjectLiteralExpression(responses)) {
    const res: Json = {};
    for (const rp of responses.properties) {
      if (!ts.isPropertyAssignment(rp) || !ts.isObjectLiteralExpression(rp.initializer)) continue;
      const code = rp.name.getText().replace(/['"]/g, "");
      const desc = prop(rp.initializer, "description");
      const content = prop(rp.initializer, "content");
      const json = content && ts.isObjectLiteralExpression(content) ? prop(content, "application/json") : undefined;
      const schema = json && ts.isObjectLiteralExpression(json) ? prop(json, "schema") : undefined;
      res[code] = { description: desc && ts.isStringLiteral(desc) ? desc.text : "", ...(schema ? { content: { "application/json": { schema: zodToSchema(schema, r).schema } } } : {}) };
    }
    out.responses = res;
  }
  return out;
}

const APP_FACTORY = /^(express|Router|Hono|OpenAPIHono|Fastify|fastify)$/;

function isAppFactory(e: ts.Expression | undefined): boolean {
  if (!e) return false;
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression)) return APP_FACTORY.test(e.expression.text);
  if (ts.isCallExpression(e)) {
    if (ts.isIdentifier(e.expression)) return APP_FACTORY.test(e.expression.text);
    if (ts.isPropertyAccessExpression(e.expression)) {
      if (e.expression.name.text === "Router") return true;
      if (e.expression.name.text === "basePath") return isAppFactory(e.expression.expression);
    }
  }
  return false;
}

function scanServerFiles(files: string[], guesses: string[]): DraftRoute[] {
  const infos = new Map<string, FileInfo>();
  for (const f of files) {
    try {
      infos.set(f, readFile(f));
    } catch (err) {
      guesses.push(`${f}: couldn't parse (${(err as Error).message})`);
    }
  }
  const routes: RawRoute[] = [];
  const mounts: Mount[] = [];
  const known = new Set<NodeKey>();
  const basePrefix = new Map<NodeKey, string>();

  /** A node for an identifier used in `file`: its import target, or itself. */
  const nodeFor = (info: FileInfo, name: string, depth = 0): NodeKey => {
    const imp = info.imports.get(name);
    if (imp && depth < 8) {
      const target = infos.get(imp.from);
      if (target) {
        const local = target.exports.get(imp.name) ?? (imp.name === "default" ? null : imp.name);
        if (local) return nodeFor(target, local, depth + 1);
      }
    }
    return `${info.file}#${name}`;
  };

  for (const info of infos.values()) {
    const r: Resolver = { constant: (n) => info.consts.get(n) ?? null };
    // Routers and apps created in this file.
    for (const [name, init] of info.consts) {
      if (isAppFactory(init)) {
        known.add(`${info.file}#${name}`);
        const p = chainPrefix(init);
        if (p) basePrefix.set(`${info.file}#${name}`, p);
      }
    }
    // Fastify plugins: `async function routes(fastify) { fastify.get(…) }` — routes on a
    // function's first parameter belong to that function (mounted by register()).
    const pluginParam = new Map<ts.Node, string>();
    const visit = (n: ts.Node) => {
      if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parameters[0] && ts.isIdentifier(n.parameters[0].name)) {
        const fnName = ts.isFunctionDeclaration(n) && n.name ? n.name.text : ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : null;
        const key = fnName ? `${info.file}#${fnName}` : `${info.file}#@${n.pos}`;
        pluginParam.set(n, key);
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        const root = rootIdentifier(n.expression.expression);
        if (root) {
          // Which router is this? A plugin parameter maps to its function's node.
          let node: NodeKey = nodeFor(info, root.text);
          for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
            const key = pluginParam.get(p);
            if (key && (p as ts.FunctionLikeDeclaration).parameters[0]?.name.getText() === root.text) {
              node = key;
              break;
            }
          }
          const args = n.arguments;
          const prefix = chainPrefix(n.expression.expression);
          if (METHODS.has(method) && isPathLiteral(args[0])) {
            const opts = args[1] && ts.isObjectLiteralExpression(args[1]) ? args[1] : undefined;
            routes.push({ node, method: method.toUpperCase(), path: joinPath(prefix, args[0].text), file: info.file, line: lineOf(info.sf, n), ...fastifySchema(opts, r), ...honoValidators(args, r) });
            known.add(node);
          } else if (METHODS.has(method) && args.length >= 1 && prefix && !isPathLiteral(args[0])) {
            // app.route("/x").get(handler)
            routes.push({ node, method: method.toUpperCase(), path: prefix, file: info.file, line: lineOf(info.sf, n) });
            known.add(node);
          } else if (method === "route" && args.length === 1 && args[0] && ts.isObjectLiteralExpression(args[0])) {
            // fastify.route({ method, url, schema })
            const url = (() => {
              for (const p of args[0].properties) if (ts.isPropertyAssignment(p) && p.name.getText() === "url" && isPathLiteral(p.initializer)) return p.initializer.text;
              return null;
            })();
            const methods = (() => {
              for (const p of args[0].properties) {
                if (!ts.isPropertyAssignment(p) || p.name.getText() !== "method") continue;
                const v = literal(p.initializer, r);
                return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
              }
              return [];
            })();
            const s = fastifySchema(args[0], r);
            if (url) for (const m of methods) routes.push({ node, method: m.toUpperCase(), path: url, file: info.file, line: lineOf(info.sf, n), ...s });
            if (url) known.add(node);
          } else if (method === "openapi" && args[0]) {
            // @hono/zod-openapi: app.openapi(route, handler)
            const z = zodOpenApiRoute(args[0], r);
            if (z.method && z.path) {
              const { method: m, path: p, ...rest } = z;
              routes.push({ node, method: m.toUpperCase(), path: p.replace(/\{(\w+)\}/g, ":$1"), file: info.file, line: lineOf(info.sf, n), ...rest });
              known.add(node);
            }
          } else if ((method === "use" || method === "route") && args.length >= 2 && isPathLiteral(args[0])) {
            // Express app.use("/v1", router) · Hono app.route("/v1", sub)
            for (const a of args.slice(1)) if (ts.isIdentifier(a)) mounts.push({ parent: node, child: nodeFor(info, a.text), prefix: args[0].text });
          } else if (method === "use" && args.length === 1 && args[0] && ts.isIdentifier(args[0])) {
            mounts.push({ parent: node, child: nodeFor(info, args[0].text), prefix: "" });
          } else if (method === "register" && args[0]) {
            // Fastify app.register(plugin, { prefix: "/v1" })
            const opts = args[1] ? (literal(args[1], r) as Json | undefined) : undefined;
            const prefix2 = typeof opts?.prefix === "string" ? opts.prefix : "";
            if (ts.isIdentifier(args[0])) mounts.push({ parent: node, child: nodeFor(info, args[0].text), prefix: prefix2 });
            else if (ts.isArrowFunction(args[0]) || ts.isFunctionExpression(args[0])) mounts.push({ parent: node, child: `${info.file}#@${args[0].pos}`, prefix: prefix2 });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(info.sf);
  }

  // Full paths: walk down from the roots (routers nobody mounts).
  const children = new Map<NodeKey, Mount[]>();
  const mounted = new Set<NodeKey>();
  for (const m of mounts) {
    children.set(m.parent, [...(children.get(m.parent) ?? []), m]);
    mounted.add(m.child);
  }
  const prefixes = new Map<NodeKey, string[]>();
  const walk = (node: NodeKey, prefix: string, seen: Set<NodeKey>) => {
    if (seen.has(node)) return;
    const full = joinPath(prefix, basePrefix.get(node) ?? "");
    prefixes.set(node, [...(prefixes.get(node) ?? []), full]);
    for (const m of children.get(node) ?? []) walk(m.child, joinPath(full, m.prefix), new Set([...seen, node]));
  };
  const nodes = new Set([...known, ...mounts.map((m) => m.parent), ...routes.map((r) => r.node)]);
  for (const n of nodes) if (!mounted.has(n)) walk(n, "", new Set());

  const out: DraftRoute[] = [];
  for (const r of routes) {
    const ps = prefixes.get(r.node);
    if (!ps) guesses.push(`${relative(process.cwd(), r.file)}:${r.line}: ${r.method} ${r.path} is on a router we couldn't see mounted; listed without a prefix`);
    for (const p of ps ?? [""]) {
      const { node: _n, ...rest } = r;
      out.push({ ...rest, path: joinPath(p, r.path) });
    }
  }
  return out;
}

// ── Next.js App Router ─────────────────────────────────────────────────────

const HTTP_EXPORTS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export function scanNext(root: string, appDir: string, guesses: string[]): DraftRoute[] {
  const out: DraftRoute[] = [];
  const base = join(root, appDir);
  const walk = (dir: string, segments: string[]) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith("_") || e.name.startsWith("@") || e.name === "node_modules") continue; // private and parallel routes
        walk(p, [...segments, e.name]);
      } else if (/^route\.(ts|js|mjs|tsx|jsx)$/.test(e.name)) {
        if (segments.some((s) => /^\[\.\.\.agentify\]$/.test(s))) continue; // Agentify's own catch-all
        const parts: string[] = [];
        let note: string | null = null;
        for (const s of segments) {
          if (/^\(.*\)$/.test(s)) continue; // route groups
          let m = /^\[\[\.\.\.(\w+)\]\]$/.exec(s) ?? /^\[\.\.\.(\w+)\]$/.exec(s);
          if (m) {
            parts.push(`{${m[1]}}`);
            note = `catch-all segment ${s} documented as one parameter`;
            continue;
          }
          m = /^\[(\w+)\]$/.exec(s);
          parts.push(m ? `{${m[1]}}` : s);
        }
        const path = `/${parts.join("/")}`;
        const info = readFile(p);
        const exported = new Set<string>();
        for (const st of info.sf.statements) {
          if (ts.isFunctionDeclaration(st) && st.name && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) exported.add(st.name.text);
          if (ts.isVariableStatement(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
            for (const d of st.declarationList.declarations) {
              if (ts.isIdentifier(d.name)) exported.add(d.name.text);
              if (ts.isObjectBindingPattern(d.name)) for (const el of d.name.elements) exported.add(el.name.getText());
            }
          }
          if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) exported.add(el.name.text);
        }
        const rel = relative(root, p);
        for (const m of HTTP_EXPORTS.filter((x) => exported.has(x))) {
          if (m === "HEAD" || m === "OPTIONS") continue;
          out.push({ method: m, path: path === "/" ? "/" : path, file: p, line: 1 });
        }
        if (note) guesses.push(`${rel}: ${note}`);
      }
    }
  };
  if (existsSync(base)) walk(base, []);
  return out;
}

// ── The document ───────────────────────────────────────────────────────────

const singular = (w: string) => (w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.endsWith("sses") ? w.slice(0, -2) : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const camel = (words: string[]) => words.map((w, i) => (i === 0 ? w.toLowerCase() : cap(w.toLowerCase()))).join("");

/** A guessed operationId: GET /orders → listOrders, GET /orders/{id} → getOrder, POST /orders → createOrder. */
export function guessOperationId(method: string, path: string): string {
  const segs = path.split("/").filter(Boolean).filter((s) => !/^v\d+$/.test(s) && s !== "api");
  const words = segs.filter((s) => !s.startsWith("{")).flatMap((s) => s.split(/[-_.]/)).filter(Boolean);
  const endsWithParam = segs.length > 0 && segs.at(-1)!.startsWith("{");
  const noun = words.at(-1) ?? "root";
  const parents = words.slice(0, -1).map(singular);
  const m = method.toUpperCase();
  if (m === "GET") return endsWithParam ? camel(["get", ...parents, singular(noun)]) : camel(["list", ...parents, noun]);
  if (m === "POST") return endsWithParam || words.length === 0 ? camel(["post", ...words]) : segs.length >= 2 && segs.at(-2)!.startsWith("{") ? camel([noun, ...parents]) : camel(["create", ...parents, singular(noun)]);
  if (m === "PUT" || m === "PATCH") return camel(["update", ...parents, singular(noun)]);
  if (m === "DELETE") return camel(["delete", ...parents, singular(noun)]);
  return camel([m.toLowerCase(), ...words]);
}

export function draftSpec(dir: string, opts: { framework: Framework | null; appDir?: string | null; title?: string; version?: string }): DraftResult {
  const guesses: string[] = [];
  const root = resolve(dir);
  let routes: DraftRoute[];
  let files = 0;
  if (opts.framework === "next") {
    const appDir = opts.appDir ?? (["app", "src/app"].find((d) => existsSync(join(root, d))) ?? "app");
    routes = scanNext(root, appDir, guesses);
    files = routes.length;
  } else {
    const list = sourceFiles(root);
    files = list.length;
    routes = scanServerFiles(list, guesses);
  }

  const paths: Json = {};
  const ids = new Set<string>();
  for (const r of routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
    const conv = toOpenApiPath(r.path);
    const methods = r.method === "ALL" ? ["GET", "POST", "PUT", "PATCH", "DELETE"] : [r.method];
    if (r.method === "ALL") guesses.push(`${relative(root, r.file)}:${r.line}: .all("${r.path}") listed under every method`);
    if (conv.guess) guesses.push(`${relative(root, r.file)}:${r.line}: ${conv.guess}`);
    for (const method of methods) {
      const key = method.toLowerCase();
      if (key === "options") continue;
      paths[conv.path] ??= {};
      if (paths[conv.path][key]) continue;
      let operationId = r.operationId ?? guessOperationId(method, conv.path);
      for (let i = 2; ids.has(operationId); i++) operationId = `${operationId}${i}`;
      ids.add(operationId);
      const marks: string[] = [];
      if (!r.operationId) marks.push("operationId");
      const parameters: Json[] = [];
      const pathSchema = (r.params?.properties ?? {}) as Json;
      for (const name of conv.params) parameters.push({ name, in: "path", required: true, schema: pathSchema[name] ?? { type: "string" } });
      const q = r.query?.properties as Json | undefined;
      if (q) {
        const req = new Set((r.query!.required as string[] | undefined) ?? []);
        for (const [name, s] of Object.entries(q)) parameters.push({ name, in: "query", required: req.has(name), schema: s });
      }
      const op: Json = {
        operationId,
        ...(r.summary ? { summary: r.summary } : {}),
        ...(r.description ? { description: r.description } : {}),
        ...(parameters.length ? { parameters } : {}),
      };
      if (r.body) op.requestBody = { required: true, content: { "application/json": { schema: r.body } } };
      else if (["POST", "PUT", "PATCH"].includes(method)) {
        op.requestBody = { content: { "application/json": { schema: todo("request body shape unknown: add a schema") } } };
        marks.push("requestBody");
      }
      if (r.responses && Object.keys(r.responses).length) {
        op.responses = Object.fromEntries(
          Object.entries(r.responses).map(([code, v]) => {
            const val = v as Json;
            return [code, val && typeof val === "object" && ("description" in val || "content" in val) ? { description: val.description || "Response", ...(val.content ? { content: val.content } : {}) } : { description: "Response", content: { "application/json": { schema: val } } }];
          }),
        );
      } else {
        op.responses = { [method === "POST" ? "201" : "200"]: { description: "TODO: describe the response", content: { "application/json": { schema: todo("response shape unknown") } } } };
        marks.push("responses");
      }
      op["x-agentify-guess"] = marks;
      op["x-agentify-source"] = `${relative(root, r.file)}:${r.line}`;
      paths[conv.path][key] = op;
    }
  }
  if (routes.length === 0) guesses.push("No routes found. Is this the folder with your app's source? (agentify draft <dir> --framework …)");
  return {
    spec: {
      openapi: "3.1.0",
      info: {
        title: opts.title ?? "API",
        version: opts.version ?? "0.1.0",
        description: "Drafted by `agentify draft` from the source. Operations marked x-agentify-guess and schemas marked x-agentify-todo need a person to check them.",
      },
      paths,
    },
    routes,
    guesses,
    files,
  };
}
