import { existsSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { acceptAll, improve } from "../check/improve.js";
import { formatReport, readiness } from "../check/rules.js";
import { draftSpec } from "../draft/draft.js";
import { importOpenApi } from "../openapi/convert.js";
import { fetchSpec, type Json, probeSpec, readSpecFile } from "../openapi/load.js";
import { mergeManifest, readManifest } from "../openapi/manifest.js";
import { findSpec, init } from "./init.js";
import { loadConfig } from "./load-config.js";
import { detectProject, type Framework } from "./project.js";

const HELP = `openapi-agentify: turn the API you already run into an MCP server.

  openapi-agentify init [dir]      detect the framework, find (or draft) the spec, score it,
                                   write agentify.config.ts + agentify.tools.json
      --spec <file|url>  --url <http://localhost:3000>  --framework express|hono|next|fastify
      --include-writes  --anonymous allow|deny  --include "/v1/*"  --write  --force  --yes
  openapi-agentify check [spec|url]  the agent-readiness report, 0–100
      --tools agentify.tools.json  --json  --fail-under 80
  openapi-agentify improve [dir]   suggest fixes into agentify.tools.json (your spec is untouched)
      --accept (accept them: /openapi.json, llms.txt and tools/list use them)
  openapi-agentify draft [dir]     a draft OpenAPI 3.1 from your routes (never runs your code)
      --out openapi.draft.json  --framework …
  openapi-agentify sync [dir]      re-read the spec, update agentify.tools.json, keep your edits

  --config <file> picks the config (default ./agentify.config.ts).`;

type Args = { _: string[]; flags: Record<string, string | true>; multi: Record<string, string[]> };

const BOOLEAN_FLAGS = new Set(["include-writes", "yes", "write", "force", "json", "accept"]);

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      const next = argv[i + 1];
      // On/off flags never take the next word (`init --write ./api` is the folder).
      const value = inline ?? (!BOOLEAN_FLAGS.has(k) && next !== undefined && !next.startsWith("--") ? (i++, next) : true);
      out.flags[k] = value;
      if (typeof value === "string") (out.multi[k] ??= []).push(value);
    } else out._.push(a);
  }
  return out;
}

const str = (a: Args, k: string) => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : undefined);

async function specFor(target: string | undefined, a: Args): Promise<{ doc: Json; source: string; dir: string }> {
  if (target && /^https?:\/\//.test(target)) {
    try {
      return { doc: await fetchSpec(target), source: target, dir: process.cwd() };
    } catch {
      const found = await probeSpec(target);
      if (!found) throw new Error(`No OpenAPI document at ${target} (tried /openapi.json, /docs/json, /swagger.json, /api-docs…)`);
      return { doc: found.doc, source: found.url, dir: process.cwd() };
    }
  }
  if (target && existsSync(target) && !existsSync(join(target, "package.json"))) return { doc: readSpecFile(resolve(target)), source: resolve(target), dir: process.cwd() };
  const dir = resolve(target ?? ".");
  const loaded = await loadConfig(str(a, "config"), dir).catch(() => null);
  const s = loaded?.config.spec;
  if (typeof s === "string" && !s.startsWith("app:")) {
    if (/^https?:\/\//.test(s)) return { doc: await fetchSpec(s), source: s, dir };
    const p = resolve(loaded!.config.root ?? dir, s);
    return { doc: readSpecFile(p), source: p, dir };
  }
  if (s && typeof s === "object") return { doc: s as Json, source: "config", dir };
  const found = await findSpec(dir, { spec: str(a, "spec"), url: str(a, "url") });
  if (!found) throw new Error("No spec found. Pass a file or URL, or run `npx openapi-agentify draft`.");
  return { doc: found.doc, source: found.source, dir };
}

export async function main(argv: string[], out: (l: string) => void = (l) => console.log(l)): Promise<number> {
  const a = parseArgs(argv);
  const [cmd, sub, arg] = a._;
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  try {
    switch (cmd) {
      case "init": {
        let rl: ReturnType<typeof createInterface> | undefined;
        const ask = async (q: string, fallback: string) => {
          rl ??= createInterface({ input: process.stdin, output: process.stdout });
          return (await rl.question(`? ${q} (${fallback}) `)).trim() || fallback;
        };
        const r = await init({
          dir: sub ?? ".",
          spec: str(a, "spec"),
          url: str(a, "url"),
          framework: str(a, "framework") as Framework | undefined,
          includeWrites: a.flags["include-writes"] === true,
          yes: a.flags.yes === true || !process.stdin.isTTY,
          write: a.flags.write === true,
          force: a.flags.force === true,
          anonymous: str(a, "anonymous") as "allow" | "deny" | undefined,
          include: a.multi.include,
          ask,
          out,
        });
        rl?.close();
        return r.code;
      }
      case "draft": {
        const dir = resolve(sub ?? ".");
        const project = detectProject(dir, str(a, "framework") as Framework | undefined);
        const r = draftSpec(dir, { framework: project.framework, appDir: project.appDir, title: project.packageJson.name, version: project.packageJson.version });
        const file = resolve(dir, str(a, "out") ?? "openapi.draft.json");
        writeFileSync(file, `${JSON.stringify(r.spec, null, 2)}\n`);
        out(`Drafted ${relative(process.cwd(), file) || file}: ${Object.keys(r.spec.paths).length} paths from ${r.files} files (${project.framework ?? "no framework found"}).`);
        if (r.guesses.length) {
          out("Guesses to check:");
          for (const g of r.guesses) out(`  - ${g}`);
        }
        out("Every operationId is a guess (x-agentify-guess), and schemas marked x-agentify-todo need filling in.");
        return Object.keys(r.spec.paths).length ? 0 : 1;
      }
      case "check": {
        const { doc, source, dir } = await specFor(sub, a);
        const toolsFile = str(a, "tools") ?? join(dir, "agentify.tools.json");
        const manifest = readManifest(toolsFile);
        const loaded = await loadConfig(str(a, "config"), dir).catch(() => null);
        const cfg = loaded?.config;
        const report = readiness(doc, { manifest, authMode: cfg?.auth?.mode ?? "passthrough", baseUrl: cfg?.baseUrl });
        const failUnder = str(a, "fail-under") ? Number(str(a, "fail-under")) : null;
        if (a.flags.json) out(JSON.stringify({ source, ...report }, null, 2));
        else {
          out(`Spec: ${source}${manifest ? ` · tools: ${relative(process.cwd(), toolsFile)}` : ""}`);
          out(formatReport(report, { color: Boolean(color) }));
        }
        if (failUnder !== null && report.score < failUnder) {
          if (!a.flags.json) out(`\nScore ${report.score} is under --fail-under ${failUnder}.`);
          return 1;
        }
        return 0;
      }
      case "improve": {
        const { doc, dir } = await specFor(sub, a);
        const toolsFile = str(a, "tools") ?? join(dir, "agentify.tools.json");
        let manifest = readManifest(toolsFile) ?? importOpenApi(doc).manifest;
        if (a.flags.accept && manifest.tools.some((t) => t.suggestions && !t.suggestions.accepted)) {
          manifest = acceptAll(manifest);
          writeFileSync(toolsFile, `${JSON.stringify(manifest, null, 2)}\n`);
          out(`✔ Accepted the suggestions in ${relative(process.cwd(), toolsFile)}.`);
        }
        const before = readiness(doc, { manifest }).score;
        const r = await improve(doc, manifest, { accept: a.flags.accept === true, idempotency: true });
        writeFileSync(toolsFile, `${JSON.stringify(r.manifest, null, 2)}\n`);
        const accepted = readiness(doc, { manifest: acceptAll(r.manifest) }).score;
        out(`Suggestions for ${r.changed.length} operations (from the rules), written to ${relative(process.cwd(), toolsFile)}:`);
        for (const c of r.changed) out(`  ${c.tool}: ${c.fields.join(", ")}`);
        out("");
        out(`Readiness: ${before} now → ${accepted} with these accepted.`);
        if (!a.flags.accept) out('Review them, then `npx openapi-agentify improve --accept` (or set "accepted": true per tool). Nothing is served until accepted.');
        else out("Accepted: /openapi.json, llms.txt and tools/list use them now (restart your app).");
        return 0;
      }
      case "sync": {
        const { doc, source, dir } = await specFor(sub, a);
        const toolsFile = str(a, "tools") ?? join(dir, "agentify.tools.json");
        const existing = readManifest(toolsFile);
        const fresh = importOpenApi(doc, { specSource: relative(dir, source) || source });
        const merged = mergeManifest(existing, fresh.manifest);
        writeFileSync(toolsFile, `${JSON.stringify(merged.manifest, null, 2)}\n`);
        out(`Synced ${relative(process.cwd(), toolsFile)} from ${source}: ${merged.kept.length} kept (with your edits), ${merged.added.length} added${merged.added.length ? ` (${merged.added.join(", ")}; writes start disabled)` : ""}, ${merged.removed.length} removed${merged.removed.length ? ` (${merged.removed.join(", ")})` : ""}.`);
        for (const w of fresh.warnings) out(`  ! ${w}`);
        return 0;
      }
      case undefined:
      case "help":
      case "--help":
        out(HELP);
        return cmd ? 0 : 1;
      default:
        out(`Unknown command ${cmd}.\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    out(`✖ ${(err as Error).message}`);
    return 1;
  }
}

// Run when executed directly (`tsx src/cli/main.ts`); bin/openapi-agentify.mjs imports main() instead.
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (/[\\/]cli[\\/]main\.[jt]s$/.test(invoked)) process.exitCode = await main(process.argv.slice(2));
