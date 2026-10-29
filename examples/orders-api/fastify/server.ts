import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExampleConfig } from "../load-config.js";
import { createFastifyApp } from "./app.js";

const config = await loadExampleConfig(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT ?? 3000);
const app = await createFastifyApp(config);
await app.listen({ port, host: "127.0.0.1" });
console.log(`Orders API (Fastify) on http://127.0.0.1:${port} · agents: /agent, /llms.txt, /mcp`);
