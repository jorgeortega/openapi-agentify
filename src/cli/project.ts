import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * What kind of project is this? Reads package.json (never runs anything):
 * the framework (Express 4/5, Hono, Next.js App Router, Fastify 5), the entry
 * file, and, in a monorepo, which workspace packages hold an API.
 */

export type Framework = "express" | "hono" | "next" | "fastify";
export const FRAMEWORK_NAMES: Record<Framework, string> = { express: "Express", hono: "Hono", next: "Next.js (App Router)", fastify: "Fastify" };

export interface Project {
  dir: string;
  name: string;
  framework: Framework | null;
  /** Major version from the dependency range, when readable. */
  frameworkMajor: number | null;
  /** The file that creates the app (Express/Hono/Fastify), relative to dir. */
  entry: string | null;
  /** Next.js: the app/ folder (app or src/app), relative to dir. */
  appDir: string | null;
  /** Other frameworks also present (the first wins; pass --framework to choose). */
  alsoFound: Framework[];
  /** Monorepo: workspace packages that have a framework. */
  workspaces: Array<{ dir: string; name: string; framework: Framework }>;
  packageJson: Record<string, any>;
}

const ORDER: Framework[] = ["next", "fastify", "hono", "express"];
const DEP: Record<Framework, string> = { next: "next", fastify: "fastify", hono: "hono", express: "express" };

export function readPackageJson(dir: string): Record<string, any> | null {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function majorOf(range: string | undefined): number | null {
  const m = range ? /(\d+)/.exec(range) : null;
  return m ? Number(m[1]) : null;
}

export function frameworksIn(pkg: Record<string, any>): Framework[] {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  return ORDER.filter((f) => DEP[f] in deps);
}

const ENTRY_NAMES = [
  "src/app.ts", "src/server.ts", "src/index.ts", "src/main.ts", "app.ts", "server.ts", "index.ts", "main.ts",
  "src/app.js", "src/server.js", "src/index.js", "app.js", "server.js", "index.js",
  "src/app.mjs", "src/server.mjs", "app.mjs", "server.mjs", "index.mjs",
];

const CREATE: Record<Exclude<Framework, "next">, RegExp> = {
  express: /\bexpress\s*\(\s*\)/,
  hono: /\bnew\s+(Hono|OpenAPIHono)\s*\(/,
  fastify: /\b(Fastify|fastify)\s*\(/,
};

/** The file that creates the app: package.json main/scripts first, then the usual names, checked for the constructor call. */
export function findEntry(dir: string, framework: Framework, pkg: Record<string, any>): string | null {
  if (framework === "next") return null;
  const fromPkg: string[] = [];
  for (const v of [pkg.main, pkg.module, ...Object.values(pkg.scripts ?? {})]) {
    if (typeof v !== "string") continue;
    for (const m of v.matchAll(/([\w./-]+\.(?:[cm]?[jt]s))\b/g)) fromPkg.push(m[1]!.replace(/^\.\//, ""));
  }
  const candidates = [...new Set([...fromPkg.map((f) => f.replace(/^dist\//, "src/").replace(/\.js$/, ".ts")), ...fromPkg, ...ENTRY_NAMES])];
  // Only files inside the project: `init --write` edits the entry, never a "../" path.
  const inside = (f: string) => {
    const r = relative(resolve(dir), resolve(dir, f));
    return r !== "" && !r.startsWith("..") && !isAbsolute(r);
  };
  const existing = candidates.filter((f) => inside(f) && existsSync(join(dir, f)) && statSync(join(dir, f)).isFile());
  return existing.find((f) => CREATE[framework].test(readFileSync(join(dir, f), "utf8"))) ?? existing[0] ?? null;
}

function workspaceDirs(dir: string, pkg: Record<string, any>): string[] {
  let patterns: string[] = [];
  if (Array.isArray(pkg.workspaces)) patterns = pkg.workspaces;
  else if (Array.isArray(pkg.workspaces?.packages)) patterns = pkg.workspaces.packages;
  const pnpm = join(dir, "pnpm-workspace.yaml");
  if (existsSync(pnpm)) {
    try {
      patterns.push(...(((parseYaml(readFileSync(pnpm, "utf8")) as { packages?: string[] })?.packages ?? []) as string[]));
    } catch {
      // ignore a broken pnpm-workspace.yaml
    }
  }
  const out: string[] = [];
  for (const pat of patterns.filter((p) => !p.startsWith("!"))) {
    if (pat.endsWith("/*") || pat.endsWith("/**")) {
      const base = join(dir, pat.replace(/\/\*\*?$/, ""));
      if (!existsSync(base)) continue;
      for (const e of readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) out.push(join(base, e.name));
    } else if (existsSync(join(dir, pat))) out.push(join(dir, pat));
  }
  return out;
}

export function detectProject(dirIn: string, force?: Framework): Project {
  const dir = resolve(dirIn);
  const pkg = readPackageJson(dir) ?? {};
  const found = frameworksIn(pkg);
  const framework = force ?? found[0] ?? null;
  const workspaces: Project["workspaces"] = [];
  if (!framework) {
    for (const w of workspaceDirs(dir, pkg)) {
      const wp = readPackageJson(w);
      const f = wp ? frameworksIn(wp)[0] : undefined;
      if (wp && f) workspaces.push({ dir: relative(dir, w), name: String(wp.name ?? relative(dir, w)), framework: f });
    }
  }
  const appDir = framework === "next" ? (["app", "src/app"].find((d) => existsSync(join(dir, d))) ?? null) : null;
  return {
    dir,
    name: String(pkg.name ?? dir.split("/").pop()),
    framework,
    frameworkMajor: framework ? majorOf((pkg.dependencies ?? {})[DEP[framework]] ?? (pkg.devDependencies ?? {})[DEP[framework]]) : null,
    entry: framework ? findEntry(dir, framework, pkg) : null,
    appDir,
    alsoFound: found.filter((f) => f !== framework),
    workspaces,
    packageJson: pkg,
  };
}
