import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiKey, bearer, config, CUSTOMER_KEY, FRAMEWORKS, legacy, modern, ordersManifest, rpc, type Running, start } from "./helpers.js";

/**
 * In-process dispatch on all four frameworks, with the same Orders API:
 * a tool call reaches the app's own auth middleware and routes, path, query
 * and body map onto the request, errors come back as isError, and the app
 * never sees a socket.
 */

for (const fw of FRAMEWORKS) {
  describe(`${fw}: passthrough`, () => {
    let app: Running;
    beforeAll(async () => {
      app = await start(fw, config({ tools: ordersManifest({ writes: true }), auth: { mode: "passthrough" }, maxResponseBytes: 4096 }));
    });
    afterAll(() => app.close());

    it("serves the surfaces next to the app's own routes", async () => {
      const [agent, llms, card, openapi, health] = (await Promise.all(
        ["/agent", "/llms.txt", "/mcp/server-card", "/openapi.json", "/health"].map((p) => fetch(`${app.url}${p}`)),
      )) as [Response, Response, Response, Response, Response];
      expect(agent.status).toBe(200);
      expect((await agent.json()).mcp.url).toBe(`${app.url}/mcp`);
      expect(await llms.text()).toMatch(/^# Orders API\n\n> Look up, create and refund orders\./);
      expect(card.headers.get("content-type")).toContain("application/mcp-server-card+json");
      expect((await openapi.json())["x-agentify"].mcp).toBe(`${app.url}/mcp`);
      expect(health.status).toBe(200);
    });

    it("lists one tool per operation (both eras)", async () => {
      const m = await rpc(app.url, modern("tools/list"), apiKey(CUSTOMER_KEY));
      expect(m.json.result.tools.map((t: { name: string }) => t.name)).toEqual(["listOrders", "post_v1_orders", "get2", "refundOrder", "getSalesReport"]);
      const l = await rpc(app.url, legacy("tools/list"), apiKey(CUSTOMER_KEY));
      expect(l.json.result.tools).toHaveLength(5);
    });

    it("forwards the agent's credentials to the app's own auth middleware", async () => {
      const r = await rpc(app.url, modern("tools/call", { name: "get2", arguments: { id: "ord_1002" } }), apiKey(CUSTOMER_KEY));
      expect(r.json.result.isError).toBe(false);
      expect(r.json.result.structuredContent).toMatchObject({ id: "ord_1002", customer: "grace@example.com" });
      expect(app.orders.audit.at(-1)).toMatchObject({ caller: "customer", method: "GET", path: "/v1/orders/ord_1002", tool: "get2" });
    });

    it("gets the app's 401 when the agent sends no credentials (the API decides)", async () => {
      const r = await rpc(app.url, modern("tools/call", { name: "listOrders", arguments: {} }));
      expect(r.json.result.isError).toBe(true);
      expect(r.json.result.content[0].text).toMatch(/401/);
      expect(r.json.result.structuredContent).toMatchObject({ status: 401, error: { error: "unauthorized" } });
    });

    it("maps query parameters", async () => {
      const r = await rpc(app.url, modern("tools/call", { name: "listOrders", arguments: { status: "refunded", limit: 2 } }), apiKey(CUSTOMER_KEY));
      const body = r.json.result.structuredContent;
      expect(body.orders).toHaveLength(2);
      expect(body.orders.every((o: { status: string }) => o.status === "refunded")).toBe(true);
    });

    it("sends JSON bodies, and returns the app's 201", async () => {
      const r = await rpc(app.url, modern("tools/call", { name: "post_v1_orders", arguments: { body: { customer: "new@example.com", items: [{ sku: "mug-blue", qty: 2 }] } } }), apiKey(CUSTOMER_KEY));
      expect(r.json.result.isError).toBe(false);
      expect(r.json.result.structuredContent).toMatchObject({ customer: "new@example.com", totalCents: 3600, status: "open" });
    });

    it("checks arguments against the schema before the app sees them", async () => {
      const before = app.orders.audit.length;
      const bad = await rpc(app.url, modern("tools/call", { name: "post_v1_orders", arguments: { body: { customer: "x@example.com", items: [{ sku: "nope", qty: 1 }] } } }), apiKey(CUSTOMER_KEY));
      expect(bad.json.result.isError).toBe(true);
      expect(bad.json.result.content[0].text).toMatch(/Invalid arguments for post_v1_orders/);
      expect(app.orders.audit.length).toBe(before);
    });

    it("turns the app's 409 and 404 into isError with the status", async () => {
      const conflict = await rpc(app.url, modern("tools/call", { name: "refundOrder", arguments: { id: "ord_1001" } }), apiKey(CUSTOMER_KEY));
      expect(conflict.json.result).toMatchObject({ isError: true, structuredContent: { status: 409, error: { error: "conflict" } } });
      expect(conflict.json.result.content[0].text).toMatch(/^The API answered 409/);
      const missing = await rpc(app.url, modern("tools/call", { name: "get2", arguments: { id: "ord_9" } }), apiKey(CUSTOMER_KEY));
      expect(missing.json.result).toMatchObject({ isError: true, structuredContent: { status: 404 } });
    });

    it("percent-encodes path parameters so they stay one segment", async () => {
      const r = await rpc(app.url, modern("tools/call", { name: "get2", arguments: { id: "../reports/sales" } }), apiKey(CUSTOMER_KEY));
      expect(r.json.result.isError).toBe(true);
      expect(r.json.result.structuredContent?.status).toBe(404);
      expect(app.orders.audit.at(-1)!.path).not.toBe("/v1/reports/sales");
      const dot = await rpc(app.url, modern("tools/call", { name: "get2", arguments: { id: ".." } }), apiKey(CUSTOMER_KEY));
      expect(dot.json.result.content[0].text).toMatch(/Invalid value for path parameter id/);
    });

    it("caps what it reads from the app's response", async () => {
      const r = await rpc(app.url, modern("tools/call", { name: "listOrders", arguments: { limit: 100 } }), apiKey(CUSTOMER_KEY));
      // 12 orders is ~2.5 KB; the cap here is 4 KB, so it fits; a smaller cap truncates (see core.test.ts).
      expect(r.json.result.isError).toBe(false);
    });

    it("never lets an outside caller forge X-Agentify-* headers onto the app", async () => {
      await fetch(`${app.url}/v1/orders/ord_1001`, { headers: { ...apiKey(CUSTOMER_KEY), "x-agentify-tool": "forged", "x-agentify-agent": "forged" } });
      expect(app.orders.audit.at(-1)).toMatchObject({ path: "/v1/orders/ord_1001", tool: null, agent: null });
    });

    it("leaves people alone: no metering, no headers stripped but forged ones", async () => {
      const r = await fetch(`${app.url}/v1/orders`, { headers: { ...apiKey(CUSTOMER_KEY), "user-agent": "Mozilla/5.0" } });
      expect(r.status).toBe(200);
    });

    it("adds Link headers on the API root", async () => {
      const r = await fetch(`${app.url}/`);
      expect(r.headers.get("link")).toContain('</llms.txt>; rel="llms-txt"');
      expect(r.headers.get("link")).toContain("rel=\"mcp-server-card\"");
    });

    it("rejects bearer tokens it can't use in passthrough? no: forwards them untouched", async () => {
      const r = await rpc(app.url, modern("tools/call", { name: "get2", arguments: { id: "ord_1001" } }), bearer("some-token"));
      // The app only knows x-api-key: its 401 comes back as the tool result.
      expect(r.json.result.structuredContent).toMatchObject({ status: 401 });
    });
  });
}
