import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config, CUSTOMER_KEY, FRAMEWORKS, ordersManifest, type Running, start } from "./helpers.js";

/**
 * The real thing: the official MCP TypeScript SDK client (v2), once as a
 * 2025-era client (`initialize`) and once pinned to 2026-07-28
 * (`server/discover`, per-request `_meta`, mirrored headers), against each
 * framework's Orders API over HTTP. Every call runs in-process through the
 * app's own auth middleware.
 */

const MODES = ["legacy", { pin: "2026-07-28" }] as const;

for (const fw of FRAMEWORKS) {
  describe(`official MCP client → ${fw}`, () => {
    let app: Running;
    beforeAll(async () => {
      app = await start(fw, config({ tools: ordersManifest() }));
    });
    afterAll(() => app.close());

    for (const mode of MODES) {
      it(`${typeof mode === "string" ? "2025-11-25 (initialize)" : "2026-07-28 (pinned)"}: lists tools, calls one in-process, gets errors as errors`, async () => {
        const client = new Client({ name: "interop-test", version: "1.0.0" }, { versionNegotiation: { mode } });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), { requestInit: { headers: { "x-api-key": CUSTOMER_KEY } } }));
        try {
          const { tools } = await client.listTools();
          expect(tools.map((t) => t.name)).toEqual(["listOrders", "get2", "getSalesReport"]);
          const order = await client.callTool({ name: "get2", arguments: { id: "ord_1005" } });
          expect(order.isError).toBe(false);
          expect(order.structuredContent).toMatchObject({ id: "ord_1005" });
          expect(app.orders.audit.at(-1)).toMatchObject({ caller: "customer", tool: "get2", agent: null, path: "/v1/orders/ord_1005" });
          const missing = await client.callTool({ name: "get2", arguments: { id: "ord_0" } });
          expect(missing.isError).toBe(true);
          // A write tool is off until you enable it in agentify.tools.json.
          await expect(client.callTool({ name: "refundOrder", arguments: { id: "ord_1005" } })).rejects.toThrow(/Unknown tool/);
        } finally {
          await client.close();
        }
      });
    }
  });
}
