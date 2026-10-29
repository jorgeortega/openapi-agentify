import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { loadExampleConfig } from "../load-config.js";
import { createHonoApp } from "./app.js";

const config = await loadExampleConfig(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: createHonoApp(config).fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`Orders API (Hono) on http://127.0.0.1:${port} · agents: /agent, /llms.txt, /mcp`);
});
