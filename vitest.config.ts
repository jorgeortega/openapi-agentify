import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig({
  // The Express and Next.js examples import the package by name (as your app would); in tests that's this package's src/.
  resolve: {
    alias: [
      { find: /^openapi-agentify\/next$/, replacement: src("adapters/next.ts") },
      { find: /^openapi-agentify\/express$/, replacement: src("adapters/express.ts") },
      { find: /^openapi-agentify$/, replacement: src("index.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
