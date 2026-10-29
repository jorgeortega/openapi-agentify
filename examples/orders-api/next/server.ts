import { serve } from "@hono/node-server";
import { nextFetch } from "./harness";
import { useAgentify } from "./lib/agentify";

// `npm run demo:next`: the route handlers behind a small router (see harness.ts).
// For the real Next.js server: cd examples/orders-api/next && npx next dev
if (process.env.AGENTIFY_CONFIG) {
  const { pathToFileURL } = await import("node:url");
  useAgentify((await import(pathToFileURL(process.env.AGENTIFY_CONFIG).href)).default);
}
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: nextFetch(), port, hostname: "127.0.0.1" }, () => {
  console.log(`Orders API (Next.js route handlers) on http://127.0.0.1:${port} · agents: /agent, /llms.txt, /mcp`);
});
