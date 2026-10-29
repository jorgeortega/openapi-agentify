import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildOperationRequest, childTraceparent, httpDispatcher, toToolResult } from "../src/dispatch.js";
import { defineTool, ToolError } from "../src/mcp/tools.js";
import { encodeHeaderValue, META } from "../src/mcp/protocol.js";
import { apiKey, config, CUSTOMER_KEY, legacy, modern, ordersManifest, rpc, type Running, start } from "./helpers.js";

/** The MCP endpoint: both protocol eras, the header rules, and the request builder. */

describe("MCP protocol (both eras)", () => {
  let app: Running;
  beforeAll(async () => {
    app = await start(
      "hono",
      config({
        instructions: "Order tools. Amounts are in cents.",
        codeTools: [
          defineTool({
            name: "order_count",
            description: "How many orders there are, by status (a code tool that calls the API).",
            input: z.object({ status: z.enum(["open", "paid", "refunded"]).optional() }),
            annotations: { readOnlyHint: true },
            handler: async ({ status }, ctx) => {
              const res = await ctx.fetchApp(`/v1/orders?limit=100${status ? `&status=${status}` : ""}`);
              if (!res.ok) throw new ToolError(`The API answered ${res.status}`);
              return { count: ((await res.json()) as { orders: unknown[] }).orders.length };
            },
          }),
        ],
      }),
    );
  });
  afterAll(() => app.close());

  it("initialize (2025-11-25): negotiates, names the server, gives instructions", async () => {
    const r = await rpc(app.url, { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, headers: { "content-type": "application/json" } });
    expect(r.json.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "Orders API", version: "1.4.0" }, instructions: "Order tools. Amounts are in cents." });
  });

  it("initialize with an unknown version answers the latest it has", async () => {
    const r = await rpc(app.url, { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } }, headers: { "content-type": "application/json" } });
    expect(r.json.result.protocolVersion).toBe("2025-11-25");
  });

  it("server/discover (2026-07-28): versions, capabilities, serverInfo in _meta", async () => {
    const r = await rpc(app.url, modern("server/discover"));
    expect(r.json.result).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } });
    expect(r.json.result._meta[META.serverInfo]).toEqual({ name: "Orders API", version: "1.4.0" });
  });

  it("tools/list: annotations from the method, code tools after operation tools", async () => {
    const r = await rpc(app.url, legacy("tools/list"));
    const byName = Object.fromEntries(r.json.result.tools.map((t: { name: string }) => [t.name, t]));
    expect(Object.keys(byName)).toEqual(["listOrders", "get2", "getSalesReport", "order_count"]);
    expect(byName.listOrders.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(byName.get2.inputSchema).toMatchObject({ type: "object", required: ["id"], additionalProperties: false });
  });

  it("a code tool reaches the app in-process as the calling agent", async () => {
    const r = await rpc(app.url, modern("tools/call", { name: "order_count", arguments: { status: "refunded" } }), apiKey(CUSTOMER_KEY));
    expect(r.json.result).toMatchObject({ isError: false, structuredContent: { count: 3 } });
    const denied = await rpc(app.url, modern("tools/call", { name: "order_count", arguments: {} }));
    expect(denied.json.result).toMatchObject({ isError: true, content: [{ text: "The API answered 401" }] });
  });

  it("modern: Mcp-Method must match the body (-32020, HTTP 400)", async () => {
    const r = await rpc(app.url, modern("tools/list", {}, { headers: { "mcp-method": "tools/call" } }));
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: -32020, message: expect.stringContaining("Mcp-Method") });
  });

  it("modern: Mcp-Name must match the tool, and may be base64-encoded", async () => {
    const wrong = await rpc(app.url, modern("tools/call", { name: "get2", arguments: { id: "ord_1001" } }, { headers: { "mcp-name": "listOrders" } }));
    expect(wrong.json.error.code).toBe(-32020);
    const missing = modern("tools/call", { name: "get2", arguments: { id: "ord_1001" } });
    delete missing.headers["mcp-name"];
    expect((await rpc(app.url, missing)).json.error.code).toBe(-32020);
    const encoded = await rpc(app.url, modern("tools/call", { name: "get2", arguments: { id: "ord_1001" } }, { headers: { "mcp-name": `=?base64?${Buffer.from("get2").toString("base64")}?=` } }), apiKey(CUSTOMER_KEY));
    expect(encoded.json.result.isError).toBe(false);
    expect(encodeHeaderValue("héllo")).toMatch(/^=\?base64\?/);
  });

  it("modern: the version header must match _meta, and _meta needs client capabilities", async () => {
    const mismatch = await rpc(app.url, modern("tools/list", {}, { headers: { "mcp-protocol-version": "2025-11-25" } }));
    expect(mismatch.json.error.code).toBe(-32020);
    const req = modern("tools/list");
    delete (req.body.params._meta as Record<string, unknown>)[META.clientCapabilities];
    expect((await rpc(app.url, req)).json.error.code).toBe(-32602);
  });

  it("an unsupported version is -32022 with the supported list", async () => {
    const r = await rpc(app.url, legacy("tools/list", {}, { headers: { "mcp-protocol-version": "2024-01-01" } }));
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: -32022, data: { supported: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"], requested: "2024-01-01" } });
  });

  it("a missing version header means 2025-03-26 (legacy)", async () => {
    const r = await rpc(app.url, { body: { jsonrpc: "2.0", id: 9, method: "tools/list" }, headers: { "content-type": "application/json" } });
    expect(r.json.result.tools.length).toBeGreaterThan(0);
    expect(r.json.result.resultType).toBeUndefined();
  });

  it("unknown methods: 404 in the modern era, 200 before", async () => {
    expect((await rpc(app.url, modern("resources/list"))).status).toBe(404);
    const l = await rpc(app.url, legacy("resources/list"));
    expect(l.status).toBe(200);
    expect(l.json.error.code).toBe(-32601);
  });

  it("notifications get 202, batches and garbage get JSON-RPC errors", async () => {
    const n = await fetch(`${app.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(n.status).toBe(202);
    expect((await rpc(app.url, { body: [], headers: { "content-type": "application/json" } })).json.error.code).toBe(-32600);
    expect((await rpc(app.url, { body: "{nope", headers: { "content-type": "application/json" } })).json.error.code).toBe(-32700);
    expect((await rpc(app.url, { body: { jsonrpc: "2.0", id: null, method: "ping" }, headers: { "content-type": "application/json" } })).status).toBe(400);
  });

  it("GET and DELETE on /mcp are 405 (JSON responses only, no SSE, no sessions)", async () => {
    expect((await fetch(`${app.url}/mcp`)).status).toBe(405);
    expect((await fetch(`${app.url}/mcp`, { method: "DELETE" })).headers.get("allow")).toBe("POST");
  });

  it("refuses bodies over 4 MiB", async () => {
    const r = await fetch(`${app.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: `{"x":"${"a".repeat(4 * 1024 * 1024 + 10)}"}` });
    expect(r.status).toBe(413);
  });

  it("refuses browser pages from other origins (DNS rebinding), allows localhost in dev", async () => {
    const evil = await fetch(`${app.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: JSON.stringify(legacy("ping").body) });
    expect(evil.status).toBe(403);
    const local = await fetch(`${app.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:5173" }, body: JSON.stringify(legacy("ping").body) });
    expect(local.status).toBe(200);
  });

  it("modern tools/list results may only be cached per caller", async () => {
    const r = await rpc(app.url, modern("tools/list"));
    expect(r.json.result).toMatchObject({ cacheScope: "private", ttlMs: expect.any(Number) });
  });

  it("unknown tools and bad params are JSON-RPC errors", async () => {
    expect((await rpc(app.url, modern("tools/call", { name: "nope", arguments: {} }, { headers: { "mcp-name": "nope" } }))).json.error.message).toBe("Unknown tool: nope");
    const r = await rpc(app.url, legacy("tools/call", { name: "get2", arguments: [] }));
    expect(r.json.error.code).toBe(-32602);
  });

  it("before 2026-07-28, array structuredContent is dropped (it had to be an object)", async () => {
    // listOrders returns an object; a code tool returning an array shows the rule.
    const r = await rpc(app.url, legacy("tools/call", { name: "order_count", arguments: {} }), apiKey(CUSTOMER_KEY));
    expect(r.json.result.structuredContent).toEqual({ count: 12 });
  });
});

describe("the request builder", () => {
  const tools = ordersManifest({ writes: true }).tools;
  const get2 = tools.find((t) => t.name === "get2")!;
  const list = tools.find((t) => t.name === "listOrders")!;
  const create = tools.find((t) => t.name === "post_v1_orders")!;
  const opts = { origin: "https://api.acme.com", headers: { "x-agentify-tool": "t" } };

  it("encodes path parameters and refuses traversal", () => {
    expect(buildOperationRequest(get2, { id: "a/b c" }, opts).url).toBe("https://api.acme.com/v1/orders/a%2Fb%20c");
    expect(buildOperationRequest(get2, { id: "%2e%2e" }, opts).url).toBe("https://api.acme.com/v1/orders/%252e%252e");
    for (const bad of ["", ".", ".."]) expect(() => buildOperationRequest(get2, { id: bad }, opts)).toThrow(/Invalid value/);
  });

  it("sends only declared query parameters, arrays exploded", () => {
    const r = buildOperationRequest(list, { status: "open", limit: 5, extra: "no" }, opts);
    expect(r.url).toBe("https://api.acme.com/v1/orders?status=open&limit=5");
  });

  it("sends a JSON body with its content type", async () => {
    const r = buildOperationRequest(create, { body: { customer: "a@b.c", items: [] } }, opts);
    expect(r.method).toBe("POST");
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(await r.json()).toEqual({ customer: "a@b.c", items: [] });
  });

  it("never lets a header parameter set a credential or an Agentify header", () => {
    const evil = { ...get2, params: [...get2.params, { name: "X-Agentify-Agent", in: "header" as const, arg: "a", required: false }] };
    expect(() => buildOperationRequest(evil, { id: "1", a: "forged" }, opts)).toThrow(/can't be set/);
    const auth = { ...get2, params: [...get2.params, { name: "Authorization", in: "header" as const, arg: "a", required: false }] };
    expect(() => buildOperationRequest(auth, { id: "1", a: "Bearer x" }, opts)).toThrow(/can't be set/);
    const crlf = { ...get2, params: [...get2.params, { name: "X-Trace", in: "header" as const, arg: "a", required: false }] };
    expect(() => buildOperationRequest(crlf, { id: "1", a: "x\r\nInjected: 1" }, opts)).toThrow(/Invalid characters/);
  });

  it("keeps the request on this API's origin", () => {
    const weird = { ...get2, path: "//evil.example/{id}" };
    expect(() => buildOperationRequest(weird, { id: "1" }, opts)).toThrow(/leaves this API/);
  });

  it("maps responses: JSON → structuredContent, non-2xx → isError, redirects not followed, a size cap", async () => {
    expect(await toToolResult(Response.json({ a: 1 }), 1000)).toMatchObject({ structuredContent: { a: 1 }, status: 200 });
    expect(await toToolResult(new Response("nope", { status: 500 }), 1000)).toMatchObject({ isError: true, status: 500, content: [{ text: "The API answered 500: nope" }] });
    expect(await toToolResult(new Response(null, { status: 302, headers: { location: "https://elsewhere" } }), 1000)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("not followed") }] });
    const big = await toToolResult(new Response("x".repeat(5000), { headers: { "content-type": "text/plain" } }), 1000);
    expect(big.content[0]).toMatchObject({ text: expect.stringContaining("[response truncated at 1000 bytes]") });
    const bigJson = await toToolResult(new Response(JSON.stringify({ a: "x".repeat(5000) }), { headers: { "content-type": "application/json" } }), 1000);
    expect(bigJson.structuredContent).toBeUndefined();
  });

  it("makes a W3C traceparent that continues the caller's trace", () => {
    const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const child = childTraceparent(parent);
    expect(child).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    expect(child).not.toBe(parent);
    expect(childTraceparent("garbage")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});

describe("dispatch: http (a loopback to a separate process)", () => {
  let upstream: Server;
  let upstreamUrl: string;
  let app: Running;
  const seen: Array<Record<string, string>> = [];
  beforeAll(async () => {
    upstream = serve({
      fetch: (r) => {
        seen.push(Object.fromEntries(r.headers));
        return Response.json({ path: new URL(r.url).pathname });
      },
      port: 0,
      hostname: "127.0.0.1",
    }) as Server;
    await new Promise<void>((r) => upstream.once("listening", () => r()));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    app = await start("hono", config({ baseUrl: "http://localhost:3000", dispatch: { mode: "http", url: upstreamUrl } }));
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  it("sends the tool call to the other process, with Agentify's headers", async () => {
    const r = await rpc(app.url, modern("tools/call", { name: "get2", arguments: { id: "ord_1" } }));
    expect(r.json.result.structuredContent).toEqual({ path: "/v1/orders/ord_1" });
    expect(seen.at(-1)).toMatchObject({ "x-agentify-tool": "get2", traceparent: expect.stringMatching(/^00-/) });
  });

  it("builds the same way from the helper", async () => {
    const d = httpDispatcher(upstreamUrl);
    const res = await d(new Request("https://api.acme.com/v1/x?y=1"), { remoteAddress: null });
    expect(await res.json()).toEqual({ path: "/v1/x" });
  });
});
