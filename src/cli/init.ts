import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { formatReport, readiness } from "../check/rules.js";
import { draftSpec, scanNext } from "../draft/draft.js";
import { importOpenApi } from "../openapi/convert.js";
import { fetchSpec, findSpecFile, type Json, probeSpec, readSpecFile } from "../openapi/load.js";
import { type Manifest, mergeManifest, readManifest } from "../openapi/manifest.js";
import { VERSION } from "../version.js";
import { detectProject, type Framework, FRAMEWORK_NAMES } from "./project.js";

/**
 * `openapi-agentify init [dir]`: makes an existing API agent-ready.
 *
 *   1. detects the framework and the entry file from package.json;
 *   2. finds the spec (--spec, the usual file names here or up to two folders
 *      up, or --url on the running app), or drafts one from the code;
 *   3. scores agent readiness;
 *   4. picks the operations agents may call (reads on, writes off unless
 *      --include-writes);
 *   5. writes agentify.tools.json, agentify.config.ts, a .env.example line,
 *      and adds "openapi-agentify" to package.json's dependencies;
 *   6. prints the two lines for your entry file, or adds them with --write.
 *
 * It never overwrites a file you have (--force for the config), never runs
 * your code and runs no commands: `npm install` is yours to run.
 */

export interface InitOptions {
  dir: string;
  spec?: string;
  url?: string;
  framework?: Framework;
  includeWrites?: boolean;
  yes?: boolean;
  write?: boolean;
  force?: boolean;
  anonymous?: "allow" | "deny";
  include?: string[];
  fetchImpl?: typeof fetch;
  ask?: (question: string, fallback: string) => Promise<string>;
  out: (line: string) => void;
}

export interface InitResult {
  code: number;
  score?: number;
  specFile?: string;
  written: string[];
}

const rel = (from: string, to: string) => {
  const r = relative(from, to);
  return r.startsWith(".") ? r : `./${r}`;
};

export const PACKAGE = "openapi-agentify";

/** Adds openapi-agentify to package.json's dependencies. Returns whether package.json changed. */
function addDependency(pkg: Record<string, any>, out: (l: string) => void): boolean {
  const current: unknown = pkg.dependencies?.[PACKAGE] ?? pkg.devDependencies?.[PACKAGE];
  if (typeof current === "string") {
    out(`✔ package.json already depends on ${PACKAGE} (${current})`);
    return false;
  }
  pkg.dependencies ??= {};
  pkg.dependencies[PACKAGE] = `^${VERSION}`;
  out(`✔ Added ${PACKAGE}@^${VERSION} to package.json's dependencies`);
  return true;
}

/** A path from package.json (an entry file) that stays inside the project. */
export function insideProject(projectDir: string, file: string): boolean {
  const r = relative(resolve(projectDir), resolve(projectDir, file));
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
}

/** The spec: an explicit file or URL, a file here or up to two folders up, or the running app. */
export async function findSpec(dir: string, opts: Pick<InitOptions, "spec" | "url" | "fetchImpl">): Promise<{ doc: Json; source: string; file: string | null } | null> {
  if (opts.spec) {
    if (/^https?:\/\//.test(opts.spec)) return { doc: await fetchSpec(opts.spec, opts.fetchImpl), source: opts.spec, file: null };
    const file = resolve(dir, opts.spec);
    return { doc: readSpecFile(file), source: file, file };
  }
  let d = resolve(dir);
  for (let up = 0; up <= 2; up++) {
    const f = findSpecFile(d);
    if (f) return { doc: readSpecFile(f), source: f, file: f };
    if (existsSync(join(d, ".git"))) break;
    d = dirname(d);
  }
  if (opts.url) {
    const found = await probeSpec(opts.url, opts.fetchImpl);
    if (found) return { doc: found.doc, source: found.url, file: null };
  }
  return null;
}

function configFile(o: { name: string; description: string; specPath: string; anonymous?: string; include?: string[] }): string {
  const lines = [
    `  name: ${JSON.stringify(o.name)},`,
    `  description: ${JSON.stringify(o.description)},`,
    "  // The canonical origin of this API, for discovery documents (https://api.example.com).",
    "  baseUrl: process.env.PUBLIC_URL,",
    "  root: import.meta.dirname,",
    `  spec: ${JSON.stringify(o.specPath)},`,
    '  tools: "./agentify.tools.json",',
    "  // Agents send the credentials your API already accepts; tool calls forward them, and your auth decides.",
    '  auth: { mode: "passthrough" },',
  ];
  if (o.anonymous) lines.push(`  anonymous: ${JSON.stringify(o.anonymous)},`);
  if (o.include?.length) lines.push(`  detect: { include: ${JSON.stringify(o.include)} },`);
  return `// Written by \`openapi-agentify init\`. Yours to edit: every option is typed in openapi-agentify's config.ts.
import { defineConfig } from "openapi-agentify";

export default defineConfig({
${lines.join("\n")}
});
`;
}

const ENV_MARKER = "# openapi-agentify";

function envLines(): string {
  return ["", `${ENV_MARKER}: agent-facing surfaces for this API.`, "PUBLIC_URL=http://localhost:3000", ""].join("\n");
}

/** The lines to add to an Express/Hono/Fastify entry file, and where. */
export function wiring(framework: Exclude<Framework, "next">, entryText: string, configImport: string, cjs: boolean): { imports: string[]; after: RegExp; use: (app: string) => string } {
  const pkg = `${PACKAGE}/${framework}`;
  if (framework === "express") {
    return {
      imports: cjs ? [`const { agentify } = require("${pkg}");`, `const agentifyConfig = require("${configImport}").default;`] : [`import { agentify } from "${pkg}";`, `import agentifyConfig from "${configImport}";`],
      after: /^(\s*)(?:const|let|var)\s+(\w+)\s*=\s*express\s*\(\s*\)\s*;?\s*$/m,
      use: (app) => `${app}.use(agentify(agentifyConfig));`,
    };
  }
  if (framework === "hono") {
    return {
      imports: [`import { agentify } from "${pkg}";`, `import agentifyConfig from "${configImport}";`],
      after: /^(\s*)(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:Hono|OpenAPIHono)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*;?\s*$/m,
      use: (app) => `${app}.use(agentify(agentifyConfig, { app: ${app} }));`,
    };
  }
  void entryText;
  return {
    imports: [`import { agentifyFastify } from "${pkg}";`, `import agentifyConfig from "${configImport}";`],
    after: /^(\s*)(?:const|let|var)\s+(\w+)\s*=\s*(?:Fastify|fastify)\s*\([^)]*\)\s*;?\s*$/m,
    use: (app) => `await ${app}.register(agentifyFastify, agentifyConfig);`,
  };
}

/** Adds the two lines to an entry file; returns the new text and a small diff, or null if it can't find where. */
export function wireEntry(framework: Exclude<Framework, "next">, text: string, configImport: string): { text: string; diff: string[] } | null {
  if (/openapi-agentify|adapters\/(express|hono|fastify)(\.js)?["']/.test(text)) return { text, diff: [] };
  const cjs = !/^\s*import\s/m.test(text) && /\brequire\(/.test(text);
  const w = wiring(framework, text, configImport, cjs);
  const m = w.after.exec(text);
  if (!m) return null;
  const indent = m[1] ?? "";
  const app = m[2]!;
  const lines = text.split("\n");
  const at = text.slice(0, m.index + m[0].length).split("\n").length - 1;
  const lastImport = lines.reduce((acc, l, i) => (/^\s*import\s.*from\s|^\s*import\s+["']|^(const|let|var)\s+.*=\s*require\(/.test(l) ? i : acc), -1);
  const use = `${indent}${w.use(app)}`;
  const out = [...lines];
  out.splice(at + 1, 0, use);
  out.splice(lastImport + 1, 0, ...w.imports);
  const diff = [...w.imports.map((l) => `+ ${l}`), `  ${lines[at]!.trim()}`, `+ ${use.trim()}`];
  return { text: out.join("\n"), diff };
}

/** Next.js: the catch-all for the surfaces, lib/agentify.ts, and the route map from app/**\/route.ts. */
export function nextFiles(projectDir: string, appDir: string, configImportFromLib: string): Array<{ path: string; text: string }> {
  const src = appDir.startsWith("src/") ? "src/" : "";
  const routes = scanNext(projectDir, appDir, []);
  const byPath = new Map<string, string>();
  for (const r of routes) byPath.set(r.path, relative(projectDir, r.file).replace(/\.(ts|js|mjs|tsx|jsx)$/, ""));
  const toPattern = (file: string) => {
    const segs = file.replace(/^(src\/)?app\//, "").split("/").slice(0, -1);
    return `/${segs.filter((s) => !/^\(.*\)$/.test(s)).join("/")}`;
  };
  const entries = [...new Set([...byPath.values()])].map((f) => `  ${JSON.stringify(toPattern(f) === "/" ? "/" : toPattern(f))}: () => import("./${f}"),`);
  return [
    {
      path: `${appDir}/[...agentify]/route.ts`,
      text: `// Agentify's surfaces: /mcp, /llms.txt, /openapi.json, /agent, /.well-known/… (written by openapi-agentify init).
// Your own routes match first; anything else under this catch-all is a 404.
import { surfaces } from "${rel(join(projectDir, appDir, "[...agentify]"), join(projectDir, `${src}lib/agentify`))}";

export const GET = surfaces;
export const HEAD = surfaces;
export const POST = surfaces;
export const OPTIONS = surfaces;
export const DELETE = surfaces;
`,
    },
    {
      path: `${src}lib/agentify.ts`,
      text: `// Written by openapi-agentify init.
import { agentifyNext } from "openapi-agentify/next";
import config from "${configImportFromLib}";
import { routes } from "${rel(join(projectDir, `${src}lib`), join(projectDir, "agentify.routes"))}";

export const ag = agentifyNext(config, { routes });

/** Wrap a route handler: export const GET = wrap(async (req, ctx) => …) */
export const wrap = ag.wrap;

/** For app/[...agentify]/route.ts. */
export const surfaces = ag.routes.GET;
`,
    },
    {
      path: "agentify.routes.ts",
      text: `// Where tool calls go: each App Router route, loaded when first called.
// Written by openapi-agentify init from app/**/route.ts; add routes you create.
export const routes = {
${entries.join("\n")}
};
`,
    },
  ];
}

export async function init(o: InitOptions): Promise<InitResult> {
  const out = o.out;
  const written: string[] = [];
  const ask = async (q: string, fallback: string) => (o.yes || !o.ask ? fallback : await o.ask(q, fallback));
  let project = detectProject(o.dir, o.framework);

  // 1. Framework
  if (!project.framework) {
    if (project.workspaces.length === 1) {
      out(`Monorepo: using ${project.workspaces[0]!.dir} (${FRAMEWORK_NAMES[project.workspaces[0]!.framework]}).`);
      project = detectProject(join(project.dir, project.workspaces[0]!.dir), o.framework);
    } else if (project.workspaces.length > 1) {
      out("This is a monorepo with several APIs. Run init in one of them:");
      for (const w of project.workspaces) out(`  npx openapi-agentify init ${w.dir}    # ${w.name}, ${FRAMEWORK_NAMES[w.framework]}`);
      return { code: 1, written };
    } else {
      out(`No Express, Hono, Next.js or Fastify in ${join(project.dir, "package.json")}. Pass --framework if it's there under another name.`);
      return { code: 1, written };
    }
  }
  const fw = project.framework!;
  const version = project.frameworkMajor ? ` ${project.frameworkMajor}` : "";
  out(`✔ ${FRAMEWORK_NAMES[fw]}${version}${project.entry ? `, app created in ${project.entry}` : project.appDir ? `, routes in ${project.appDir}/` : ""}${project.alsoFound.length ? ` (also found: ${project.alsoFound.join(", ")}; --framework to choose)` : ""}`);
  if (fw === "express" && project.frameworkMajor && project.frameworkMajor < 4) out("! Express 4 or 5 is needed.");
  if (fw === "fastify" && project.frameworkMajor && project.frameworkMajor < 5) out("! Fastify 5 is needed.");

  // 2. Spec
  let spec = await findSpec(project.dir, o).catch((err) => {
    out(`✖ ${(err as Error).message}`);
    return null;
  });
  let specFile: string;
  if (spec) {
    specFile = spec.file ?? join(project.dir, "openapi.json");
    if (!spec.file) {
      writeFileSync(specFile, `${JSON.stringify(spec.doc, null, 2)}\n`);
      written.push(specFile);
      out(`✔ Spec fetched from ${spec.source}, saved as ${relative(project.dir, specFile)}`);
    } else out(`✔ Spec: ${relative(project.dir, specFile) || specFile}`);
  } else {
    const drafted = draftSpec(project.dir, { framework: fw, appDir: project.appDir, title: project.packageJson.name, version: project.packageJson.version });
    specFile = join(project.dir, "openapi.draft.json");
    if (existsSync(specFile) && !o.force) out(`✔ Keeping your ${relative(project.dir, specFile)}`);
    else {
      writeFileSync(specFile, `${JSON.stringify(drafted.spec, null, 2)}\n`);
      written.push(specFile);
    }
    spec = { doc: readSpecFile(specFile), source: specFile, file: specFile };
    out(`✔ No spec found: drafted ${relative(project.dir, specFile)} from ${drafted.files} files (${Object.keys(drafted.spec.paths).length} paths). Guesses to check:`);
    for (const g of drafted.guesses.slice(0, 8)) out(`    - ${g}`);
    out("    - every operationId, and any schema marked x-agentify-todo");
  }

  // 3. Readiness
  let fresh: Manifest;
  try {
    fresh = importOpenApi(spec.doc, { includeWrites: o.includeWrites, specSource: relative(project.dir, specFile) }).manifest;
  } catch (err) {
    out(`✖ ${(err as Error).message}`);
    return { code: 1, written };
  }
  const report = readiness(spec.doc, { manifest: fresh });
  out("");
  out(formatReport(report, { max: 3 }).split("\n").map((l) => `  ${l}`).join("\n"));
  out("  Run `npx openapi-agentify improve` for suggested fixes (written to agentify.tools.json, never to your spec).");
  out("");

  // 4. Operations
  const writes = fresh.tools.filter((t) => !t.annotations?.readOnlyHint);
  if (writes.length && !o.includeWrites && !o.yes) {
    const answer = await ask(`Agents may call ${fresh.tools.length - writes.length} read operations. Enable writes too? Comma-separated names, "all" or "none" [${writes.map((t) => t.name).join(", ")}]`, "none");
    const pick = answer.trim() === "all" ? writes.map((t) => t.name) : answer.split(",").map((s) => s.trim()).filter(Boolean);
    for (const t of fresh.tools) if (pick.includes(t.name)) t.enabled = true;
  }

  // 5. Files
  const toolsPath = join(project.dir, "agentify.tools.json");
  const merged = mergeManifest(readManifest(toolsPath), fresh);
  writeFileSync(toolsPath, `${JSON.stringify({ $schema: "agentify.tools.json", ...merged.manifest }, null, 2)}\n`);
  written.push(toolsPath);
  const enabled = merged.manifest.tools.filter((t) => t.enabled);
  out(`✔ Wrote agentify.tools.json: ${enabled.length} of ${merged.manifest.tools.length} operations enabled (${enabled.map((t) => t.name).join(", ")})`);

  // A JavaScript entry (server.js) can't import a .ts file under plain node: the config is
  // then agentify.config.mjs (the same content is valid JavaScript).
  const jsEntry = fw !== "next" && Boolean(project.entry) && /\.(c|m)?js$/.test(project.entry!);
  const existingConfig = ["agentify.config.ts", "agentify.config.mts", "agentify.config.mjs", "agentify.config.js"].find((f) => existsSync(join(project.dir, f)));
  const configName = existingConfig && !o.force ? existingConfig : jsEntry ? "agentify.config.mjs" : "agentify.config.ts";
  const configPath = join(project.dir, configName);
  if (existingConfig && !o.force) out(`✔ Keeping your ${existingConfig}`);
  else {
    const info = (spec.doc.info ?? {}) as Json;
    writeFileSync(
      configPath,
      configFile({
        name: String(info.title ?? project.name),
        description: String(info.description ?? `${info.title ?? project.name}, for agents.`),
        specPath: rel(project.dir, specFile),
        anonymous: o.anonymous,
        include: o.include,
      }),
    );
    written.push(configPath);
    out(`✔ Wrote ${configName} (auth: passthrough)`);
  }

  const envPath = join(project.dir, ".env.example");
  const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (env.includes(ENV_MARKER)) out("✔ .env.example already has Agentify settings");
  else {
    appendFileSync(envPath, envLines());
    written.push(envPath);
    out("✔ Added Agentify settings to .env.example");
  }

  const pkgPath = join(project.dir, "package.json");
  const pkg = project.packageJson;
  if (addDependency(pkg, out)) {
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    written.push(pkgPath);
  }

  // 6. Wiring
  out("");
  if (fw === "next") {
    const appDir = project.appDir ?? "app";
    const src = appDir.startsWith("src/") ? "src/" : "";
    const files = nextFiles(project.dir, appDir, rel(join(project.dir, `${src}lib`), join(project.dir, "agentify.config")));
    if (o.write) {
      for (const f of files) {
        const p = join(project.dir, f.path);
        if (existsSync(p)) {
          out(`✔ ${f.path} exists; left as is`);
          continue;
        }
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, f.text);
        written.push(p);
        out(`+ ${f.path}`);
      }
    } else {
      out("Next: add these files (or run again with --write):");
      for (const f of files) out(`  ${f.path}`);
    }
    out("Then wrap each route handler agents may reach (strips forged X-Agentify-* headers, honours Idempotency-Key, runs your guardRoute hook):");
    out('  import { wrap } from "@/lib/agentify";   export const GET = wrap(async (req, ctx) => { … });');
    const proxy = ["middleware.ts", "middleware.js", "proxy.ts", "proxy.js", "src/middleware.ts", "src/middleware.js", "src/proxy.ts", "src/proxy.js"].find((f) => existsSync(join(project.dir, f)));
    if (proxy) {
      out("");
      out(`! ${proxy}: tool calls go straight to your route handlers and don't pass through it.`);
      out("  If your auth (or anything agents must not skip) lives there, move it into the handlers or a");
      out('  wrapper they call, or set dispatch: { mode: "http" } so tool calls make a real request.');
    }
  } else if (project.entry && !insideProject(project.dir, project.entry)) {
    out(`! The entry file ${project.entry} is outside this project: not touching it. Add Agentify where your app is created (see README → Quick start).`);
  } else if (project.entry) {
    const entryPath = join(project.dir, project.entry);
    const configImport = rel(dirname(entryPath), configPath).replace(/\.ts$/, ".js");
    const text = readFileSync(entryPath, "utf8");
    const wired = wireEntry(fw, text, configImport);
    if (!wired) {
      out(`Add these to ${project.entry}, before your routes:`);
      const w = wiring(fw, text, configImport, false);
      for (const l of w.imports) out(`  ${l}`);
      out(`  ${w.use("app")}`);
    } else if (wired.diff.length === 0) out(`✔ ${project.entry} already imports Agentify`);
    else if (o.write) {
      writeFileSync(entryPath, wired.text);
      written.push(entryPath);
      out(`Wired ${project.entry}:`);
      for (const l of wired.diff) out(`  ${l}`);
    } else {
      out(`Add two lines to ${project.entry} (or run again with --write):`);
      for (const l of wired.diff) out(`  ${l}`);
    }
  } else {
    out("Add Agentify where your app is created, before your routes (see README → Quick start).");
  }
  out("");
  out("Next:");
  out("  npm install");
  out("  Start your app and point an MCP client at http://localhost:3000/mcp (npx openapi-agentify check scores the spec again).");
  return { code: 0, score: report.score, specFile, written };
}
