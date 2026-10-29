import { defineConfig } from "openapi-agentify";

// The same settings as ../agentify.config.ts, inside the Next.js project
// (Next resolves files relative to the project; paths are from process.cwd()).
export default defineConfig({
  name: "Orders API",
  description: "Look up, create and refund orders.",
  baseUrl: process.env.PUBLIC_URL,
  root: process.env.AGENTIFY_ROOT ?? process.cwd(),
  spec: process.env.AGENTIFY_SPEC ?? "../openapi.json",
  tools: "./agentify.tools.json",
  auth: { mode: "passthrough" },
  detect: { include: ["/v1/*", "/"] },
});
