#!/usr/bin/env node
// Runs the built CLI (npm run build), or the TypeScript source through tsx.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = fileURLToPath(new URL("../dist/src/cli/main.js", import.meta.url));
if (existsSync(dist)) {
  const { main } = await import(pathToFileURL(dist).href);
  process.exitCode = await main(process.argv.slice(2));
} else {
  const src = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
  const r = spawnSync(process.execPath, ["--import", "tsx", src, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
