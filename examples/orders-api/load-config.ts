import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentifyConfig } from "../../src/config.js";

/**
 * The example servers' config: AGENTIFY_CONFIG (point it at the
 * file `agentify init` wrote), else ./agentify.config.ts next to the server,
 * else the shared examples/orders-api/agentify.config.ts.
 */
export async function loadExampleConfig(dir: string): Promise<AgentifyConfig> {
  const candidates = [process.env.AGENTIFY_CONFIG, resolve(dir, "agentify.config.ts"), resolve(dir, "..", "agentify.config.ts")].filter(Boolean) as string[];
  const file = candidates.find((f) => existsSync(f));
  if (!file) throw new Error("No agentify.config.ts found");
  return ((await import(pathToFileURL(resolve(file)).href)) as { default: AgentifyConfig }).default;
}
