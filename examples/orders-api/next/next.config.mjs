import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");

/**
 * In your app, "openapi-agentify" is a dependency (`openapi-agentify init`
 * adds it). In this repository, the example points at the build: run
 * `npm run build` at the repository root first. (tsconfig.json's paths point
 * at src/ instead, for the type checker and for `npm run demo:next`.)
 *
 * @type {import('next').NextConfig}
 */
export default {
  turbopack: {
    root: repo,
    resolveAlias: {
      "openapi-agentify/next": "../../../dist/src/adapters/next.js",
      "openapi-agentify": "../../../dist/src/index.js",
    },
  },
  outputFileTracingRoot: repo,
  // Server-only packages Agentify loads when a feature needs them.
  serverExternalPackages: ["typescript"],
};
