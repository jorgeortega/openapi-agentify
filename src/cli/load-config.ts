import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentifyConfig } from "../config.js";

/**
 * Loads agentify.config.ts (or .js/.mjs) for the CLI. TypeScript goes through
 * tsx when it's installed, and otherwise
 * through Node's type stripping (Node 22.18+).
 */
export async function loadConfig(file = "agentify.config.ts", cwd = process.cwd()): Promise<{ config: AgentifyConfig; file: string } | null> {
  const candidates = file === "agentify.config.ts" ? ["agentify.config.ts", "agentify.config.mts", "agentify.config.js", "agentify.config.mjs"] : [file];
  const found = candidates.map((c) => resolve(cwd, c)).find((p) => existsSync(p));
  if (!found) return null;
  const url = pathToFileURL(found).href;
  let mod: { default?: AgentifyConfig } | undefined;
  if (/\.m?ts$/.test(found)) {
    try {
      const { tsImport } = (await import("tsx/esm/api")) as { tsImport: (s: string, parent: string) => Promise<unknown> };
      mod = (await tsImport(url, import.meta.url)) as { default?: AgentifyConfig };
    } catch (err) {
      if ((err as { code?: string }).code !== "ERR_MODULE_NOT_FOUND" || !String((err as Error).message).includes("tsx")) throw err;
    }
  }
  mod ??= (await import(url)) as { default?: AgentifyConfig };
  const config = (mod.default ?? (mod as unknown as { config?: AgentifyConfig }).config) as AgentifyConfig | undefined;
  if (!config?.name) throw new Error(`${found} doesn't export a config (export default defineConfig({ … }))`);
  // Relative paths in the config are relative to the config file, unless it says otherwise.
  return { config: { root: resolve(found, ".."), ...config }, file: found };
}
