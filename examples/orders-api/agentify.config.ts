import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "../../src/index.js";

/**
 * Agentify for the example Orders API (used by the Express, Hono and Fastify
 * versions; the Next.js version has its own copy). In your app this file
 * imports from "openapi-agentify" and `openapi-agentify init` writes it.
 */
export default defineConfig({
  name: "Orders API",
  description: "Look up, create and refund orders.",
  baseUrl: process.env.PUBLIC_URL,
  root: dirname(fileURLToPath(import.meta.url)),
  spec: "./openapi.json",
  tools: "./agentify.tools.json",
  // Agents send the API key the Orders API already accepts (x-api-key);
  // tool calls forward it, and the API's own auth middleware decides.
  auth: { mode: "passthrough" },
  detect: { include: ["/v1/*", "/"] },
});
