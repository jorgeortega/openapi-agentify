/**
 * Talks to the running example's /mcp the way an MCP client would, with
 * nothing but fetch: initialize, list the tools, then call one. Start the
 * server first (`npm start`), then run `npm run try` in a second terminal.
 *
 * The tool call forwards the demo customer's API key (x-api-key), and the
 * Orders API's own auth middleware checks it: Agentify never replaces it.
 */

const endpoint = process.env.MCP_URL ?? `http://localhost:${process.env.PORT ?? 3000}/mcp`;
const apiKey = "demo-customer-key-0001"; // DEMO_CUSTOMER_KEY in shared/orders.ts

let protocolVersion: string | undefined;
let id = 0;

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": apiKey,
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const reply = await res.json();
  if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
  return reply.result;
}

const init = await rpc("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "orders-api-try", version: "0.0.0" },
});
protocolVersion = init.protocolVersion;
console.log(`Connected to ${init.serverInfo.name} at ${endpoint} (MCP ${protocolVersion})\n`);

const { tools } = await rpc("tools/list");
console.log(`${tools.length} tools:`);
for (const tool of tools) console.log(`  ${tool.name}: ${tool.description?.split("\n")[0] ?? ""}`);

const call = await rpc("tools/call", { name: "listOrders", arguments: { limit: 2 } });
console.log("\ntools/call listOrders { limit: 2 }, through the Express route and its auth:");
console.log(call.content?.[0]?.text ?? JSON.stringify(call, null, 2));
