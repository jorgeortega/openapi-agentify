import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExampleConfig } from "../load-config.js";
import { createExpressApp } from "./app.js";

const config = await loadExampleConfig(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT ?? 3000);
createExpressApp(config).listen(port, "127.0.0.1", () => {
  console.log(`Orders API (Express) on http://127.0.0.1:${port} · agents: /agent, /llms.txt, /mcp`);
});
