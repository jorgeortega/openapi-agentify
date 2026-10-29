import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createAgentify } from "../src/core.js";
import { SERVER_CARD_SCHEMA, validateServerCard } from "../src/surfaces/server-card.js";
import { doc, reverseDns, slug } from "../src/surfaces/model.js";
import { config, ordersManifest, type Running, start } from "./helpers.js";

/** Every discovery document, against its format; caching; switches. */

const BASE = "https://api.acme.com";

async function get(ag: ReturnType<typeof createAgentify>, path: string, headers: Record<string, string> = {}) {
  const res = await ag.handle(new Request(`${BASE}${path}`, { headers }), { dispatch: async () => new Response(null, { status: 500 }) });
  return res;
}

describe("discovery surfaces", () => {
  const tools = ordersManifest();
  tools.tools.find((t) => t.name === "listOrders")!.suggestions = {
    source: "rules",
    accepted: true,
    title: "List orders",
    description: "Lists orders, newest last. Filter by status; page with limit and cursor.",
    params: { status: "Only orders with this status.", limit: "How many to return (1–100)." },
    examples: [{ arguments: { status: "paid", limit: 10 } }],
  };
  tools.tools.find((t) => t.name === "post_v1_orders")!.suggestions = { source: "rules", accepted: true, idempotencyKey: true, operationId: "createOrder" };
  tools.tools.find((t) => t.name === "get2")!.suggestions = { source: "claude", accepted: false, description: "NOT ACCEPTED YET" };
  const ag = createAgentify(
    config({
      baseUrl: BASE,
      tools,
    }),
  );

  it("/llms.txt follows llmstxt.org: H1, blockquote, H2 link lists, Optional last", async () => {
    const res = (await get(ag, "/llms.txt"))!;
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await res.text();
    const lines = text.split("\n");
    expect(lines[0]).toBe("# Orders API");
    expect(lines[2]).toBe("> Look up, create and refund orders.");
    const h2 = lines.filter((l) => l.startsWith("## "));
    expect(h2).toEqual(["## MCP", "## Operations", "## Optional"]);
    expect(lines.filter((l) => /^#{3,}/.test(l))).toEqual([]);
    // Every list item under an H2 is `- [name](url): notes`.
    const firstH2 = lines.findIndex((l) => l.startsWith("## "));
    for (const l of lines.slice(firstH2)) if (l.startsWith("- ")) expect(l).toMatch(/^- \[[^\]]+\]\([^)\s]+\)(: .+)?$/);
    expect(text).toContain(`- [List orders](${BASE}/v1/orders): \`GET /v1/orders\`, MCP tool \`listOrders\`. Lists orders, newest last.`);
    expect(text).toContain('Example: `listOrders({"status":"paid","limit":10})`');
    expect(text).toContain("Send the credentials this API already accepts (`authorization`, `x-api-key`)");
    expect(text).not.toContain("Price:");
  });

  it("/llms-full.txt adds parameters and schemas", async () => {
    const text = await (await get(ag, "/llms-full.txt"))!.text();
    expect(text).toContain("## List orders");
    expect(text).toContain("- `status` (query, string): Only orders with this status.");
    expect(text).toContain("- `id` (path, required, string)");
    expect(text).toContain("```json");
  });

  it("the server card matches SEP-2127's schema (and lists no tools)", async () => {
    const res = (await get(ag, "/mcp/server-card"))!;
    expect(res.headers.get("content-type")).toBe("application/mcp-server-card+json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const card = await res.json();
    expect(validateServerCard(card)).toEqual([]);
    expect(card).toMatchObject({
      $schema: SERVER_CARD_SCHEMA,
      name: "com.acme.api/orders-api",
      version: "1.4.0",
      title: "Orders API",
      remotes: [{ type: "streamable-http", url: `${BASE}/mcp`, supportedProtocolVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"], headers: [
          { name: "authorization", isSecret: true, isRequired: false },
          { name: "x-api-key", isSecret: true, isRequired: false },
        ] }],
    });
    expect(card.tools).toBeUndefined();
    expect(card._meta["io.github.jorgeortega/openapi-agentify"]).toEqual({ auth: "passthrough", llmsTxt: `${BASE}/llms.txt`, openapi: `${BASE}/openapi.json` });
  });

  it("the card validator catches what the schema forbids", () => {
    expect(validateServerCard({ $schema: "x", name: "noslash", version: "^1.0", description: "", tools: [] })).toHaveLength(5);
  });

  it("/.well-known/mcp.json answers with the same card; the AI Catalog points at it", async () => {
    const alias = await (await get(ag, "/.well-known/mcp.json"))!.json();
    expect(alias.name).toBe("com.acme.api/orders-api");
    const res = (await get(ag, "/.well-known/ai-catalog.json"))!;
    expect(res.headers.get("content-type")).toBe("application/ai-catalog+json");
    const cat = await res.json();
    expect(cat.specVersion).toBe("1.0");
    expect(cat.entries[0]).toEqual({ identifier: "urn:air:api.acme.com:mcp:orders-api", type: "application/mcp-server-card+json", url: `${BASE}/mcp/server-card`, displayName: "Orders API" });
    for (const e of cat.entries) expect(("url" in e) !== ("data" in e)).toBe(true);
  });

  it("/openapi.json: your spec, with x-agentify and accepted suggestions only", async () => {
    const spec = await (await get(ag, "/openapi.json"))!.json();
    expect(spec["x-agentify"]).toMatchObject({ mcp: `${BASE}/mcp`, auth: "passthrough", llmsTxt: `${BASE}/llms.txt` });
    const list = spec.paths["/v1/orders"].get;
    expect(list["x-agentify"]).toEqual({ tool: "listOrders", agents: true });
    expect(list.summary).toBe("List orders");
    expect(list.parameters[0].description).toBe("Only orders with this status.");
    const create = spec.paths["/v1/orders"].post;
    expect(create.operationId).toBe("createOrder");
    expect(create["x-agentify"]).toEqual({ agents: false });
    expect(create.parameters.find((p: { name: string }) => p.name === "Idempotency-Key")).toMatchObject({ in: "header", required: false });
    expect(spec.paths["/v1/orders/{id}"].get.description).toBeUndefined();
    expect(spec.paths["/v1/reports/sales"].get["x-agentify"]).toEqual({ tool: "getSalesReport", agents: true });
    expect(spec.servers).toEqual([{ url: "http://localhost:3000" }]);
  });

  it("/openapi.yaml is the same document", async () => {
    const res = (await get(ag, "/openapi.yaml"))!;
    const yaml = parseYaml(await res.text());
    const json = await (await get(ag, "/openapi.json"))!.json();
    expect(yaml).toEqual(json);
  });

  it("/agent indexes everything, as JSON or HTML", async () => {
    const idx = await (await get(ag, "/agent"))!.json();
    expect(idx).toMatchObject({
      name: "Orders API",
      mcp: { url: `${BASE}/mcp`, transport: "streamable-http" },
      auth: { mode: "passthrough", headers: ["authorization", "x-api-key"] },
      discovery: {
        openapi: `${BASE}/openapi.json`,
        llmsTxt: `${BASE}/llms.txt`,
        serverCard: `${BASE}/mcp/server-card`,
        aiCatalog: `${BASE}/.well-known/ai-catalog.json`,
      },
      generator: "openapi-agentify",
    });
    expect(Object.keys(idx.discovery)).toHaveLength(6);
    const html = (await get(ag, "/agent", { accept: "text/html" }))!;
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("<h1>Orders API</h1>");
  });

  // /agent picks JSON or HTML by Accept under a public max-age: without Vary a CDN hands one to the other.
  const headersOf = (res: Response) => Object.fromEntries(res.headers);

  it("/agent as JSON varies on Accept, with CORS", async () => {
    const res = (await get(ag, "/agent"))!;
    expect(headersOf(res)).toEqual({
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      etag: expect.stringMatching(/^".+"$/),
      vary: "Accept",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "Content-Type, If-None-Match",
      "access-control-expose-headers": "ETag",
    });
  });

  it("/agent as HTML varies on Accept, without CORS", async () => {
    const res = (await get(ag, "/agent", { accept: "text/html" }))!;
    expect(headersOf(res)).toEqual({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      etag: expect.stringMatching(/^".+"$/),
      vary: "Accept",
    });
  });

  it("/agent answers If-None-Match with a 304 that varies on Accept too", async () => {
    for (const accept of [{}, { accept: "text/html" }] as Record<string, string>[]) {
      const first = (await get(ag, "/agent", accept))!;
      const again = (await get(ag, "/agent", { ...accept, "if-none-match": first.headers.get("etag")! }))!;
      expect(again.status).toBe(304);
      expect(await again.text()).toBe("");
      expect(headersOf(again)).toEqual(headersOf(first));
      expect(again.headers.get("vary")).toBe("Accept");
    }
  });

  it("serves ETags and answers If-None-Match with 304", async () => {
    const first = (await get(ag, "/llms.txt"))!;
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^".+"$/);
    const again = (await get(ag, "/llms.txt", { "if-none-match": etag }))!;
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("answers CORS preflights on documents, and 405 for writes", async () => {
    const pre = await ag.handle(new Request(`${BASE}/llms.txt`, { method: "OPTIONS" }), { dispatch: async () => new Response() });
    expect(pre!.status).toBe(204);
    expect(pre!.headers.get("access-control-allow-origin")).toBe("*");
    const post = await ag.handle(new Request(`${BASE}/llms.txt`, { method: "POST", body: "x" }), { dispatch: async () => new Response() });
    expect(post!.status).toBe(405);
  });

  it("returns null for paths that aren't surfaces (your app handles them)", async () => {
    expect(await get(ag, "/v1/orders")).toBeNull();
    expect(await get(ag, "/robots.txt")).toBeNull();
    expect(await get(ag, "/.well-known/oauth-protected-resource")).toBeNull();
  });

  it("never answers Agentify's own in-process calls (no loops)", async () => {
    // The internal header's value is a per-process secret: a guess is just an outside request.
    const res = await ag.handle(new Request(`${BASE}/llms.txt`, { headers: { "x-agentify-internal": "guess" } }), { dispatch: async () => new Response() });
    expect(res!.status).toBe(200);
  });
});

describe("surface switches and the no-baseUrl case", () => {
  it("each surface can be turned off", async () => {
    const ag = createAgentify(config({ surfaces: { llmsTxt: false, serverCard: false, openapi: false, agentIndex: false, aiCatalog: false }, robots: undefined } as never));
    for (const p of ["/llms.txt", "/llms-full.txt", "/mcp/server-card", "/.well-known/mcp.json", "/openapi.json", "/agent", "/.well-known/ai-catalog.json"]) expect(await get(ag, p)).toBeNull();
  });

  it("robots.txt only when asked", async () => {
    const ag = createAgentify(config({ surfaces: { robots: true } }));
    const text = await (await get(ag, "/robots.txt"))!.text();
    expect(text).toContain("For AI agents: https://api.acme.com/llms.txt");
  });

  it("without baseUrl, documents use the request's origin (cached per origin)", async () => {
    const ag = createAgentify(config());
    const a = await (await ag.handle(new Request("http://one.test/agent"), { dispatch: async () => new Response() }))!.json();
    const b = await (await ag.handle(new Request("http://two.test/agent"), { dispatch: async () => new Response() }))!.json();
    expect(a.mcp.url).toBe("http://one.test/mcp");
    expect(b.mcp.url).toBe("http://two.test/mcp");
  });

  it("forwarded host/proto only when trustProxy is on", async () => {
    const headers = { "x-forwarded-host": "public.example", "x-forwarded-proto": "https" };
    const off = createAgentify(config());
    expect((await (await off.handle(new Request("http://internal:3000/agent", { headers }), { dispatch: async () => new Response() }))!.json()).mcp.url).toBe("http://internal:3000/mcp");
    const on = createAgentify(config({ trustProxy: true }));
    expect((await (await on.handle(new Request("http://internal:3000/agent", { headers }), { dispatch: async () => new Response() }))!.json()).mcp.url).toBe("https://public.example/mcp");
  });

  it("passthrough documents the spec's credential headers", async () => {
    const ag = createAgentify(config({ baseUrl: BASE }));
    const card = await (await get(ag, "/mcp/server-card"))!.json();
    expect(card.remotes[0].headers.map((h: { name: string }) => h.name)).toEqual(["authorization", "x-api-key"]);
    expect(await (await get(ag, "/llms.txt"))!.text()).toContain("(`authorization`, `x-api-key`)");
  });

  it("names: reverse DNS and slugs", () => {
    expect(reverseDns("api.acme.com:8443")).toBe("com.acme.api");
    expect(reverseDns("127.0.0.1:3000")).toBe("local");
    expect(reverseDns("localhost")).toBe("localhost");
    expect(slug("Acme Orders API!")).toBe("acme-orders-api");
  });
});

describe("hooks: describe and extra surfaces", () => {
  const tools = ordersManifest();
  tools.tools.find((t) => t.name === "getSalesReport")!.price = "0.01";
  const ag = createAgentify(
    config({
      baseUrl: BASE,
      tools,
      hooks: {
        describe: (m) => ({
          ...m,
          auth: { ...m.auth, mode: "api-keys", headers: ["authorization"], instructions: ["Send your key as `Authorization: Bearer <key>`."], cardHeaders: [{ name: "Authorization", description: "Bearer <key>", isRequired: true, isSecret: true }] },
          notes: ["Some operations cost money per call."],
          showPrices: true,
          extraLinks: [...m.extraLinks, { key: "pricing", url: `${m.origin}/.well-known/pricing.json`, title: "Pricing", notes: "what each operation costs" }],
          extensions: { ...m.extensions, pricing: { currency: "USD" } },
        }),
        surfaces: [
          { path: "/.well-known/pricing.json", serve: (_req, m) => doc(JSON.stringify({ tools: m.tools.filter((t) => t.def.price).map((t) => ({ tool: t.def.name, price: t.def.price })) }), "application/json") },
          {
            path: "/admin/usage",
            cache: false,
            serve: (req) => (req.headers.get("authorization") === "Bearer admin" ? Response.json({ calls: 0 }) : Response.json({ error: "unauthorized" }, { status: 401 })),
          },
        ],
      },
    }),
  );

  it("changes what every document says, from one model", async () => {
    const llms = await (await get(ag, "/llms.txt"))!.text();
    expect(llms).toContain("Send your key as `Authorization: Bearer <key>`.");
    expect(llms).toContain("Some operations cost money per call.");
    expect(llms).toContain("Price: $0.01 per call.");
    expect(llms).toContain(`- [Pricing](${BASE}/.well-known/pricing.json): what each operation costs`);
    const card = await (await get(ag, "/mcp/server-card"))!.json();
    expect(card.remotes[0].headers).toEqual([{ name: "Authorization", description: "Bearer <key>", isRequired: true, isSecret: true }]);
    expect(card._meta["io.github.jorgeortega/openapi-agentify"]).toMatchObject({ auth: "api-keys", pricing: { currency: "USD" } });
    const idx = await (await get(ag, "/agent"))!.json();
    expect(idx).toMatchObject({ auth: { mode: "api-keys" }, discovery: { pricing: `${BASE}/.well-known/pricing.json` }, pricing: { currency: "USD" } });
    const spec = await (await get(ag, "/openapi.json"))!.json();
    expect(spec["x-agentify"]).toMatchObject({ auth: "api-keys", pricing: { currency: "USD" } });
    expect(spec.paths["/v1/reports/sales"].get["x-agentify"]).toEqual({ tool: "getSalesReport", agents: true, price: "$0.01" });
  });

  it("serves extra documents like its own (ETag, CORS), and plain Responses as they are", async () => {
    const res = (await get(ag, "/.well-known/pricing.json"))!;
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ tools: [{ tool: "getSalesReport", price: "0.01" }] });
    const again = (await get(ag, "/.well-known/pricing.json", { "if-none-match": res.headers.get("etag")! }))!;
    expect(again.status).toBe(304);
    expect((await get(ag, "/admin/usage"))!.status).toBe(401);
    expect(await (await get(ag, "/admin/usage", { authorization: "Bearer admin" }))!.json()).toEqual({ calls: 0 });
    expect(ag.surfacePaths()).toEqual(expect.arrayContaining(["/.well-known/pricing.json", "/admin/usage"]));
  });

  it("an extra surface is reachable through an adapter", async () => {
    const app: Running = await start("express", config({ hooks: { surfaces: [{ path: "/hello", serve: () => doc("hi", "text/plain") }] } }));
    try {
      expect(await (await fetch(`${app.url}/hello`)).text()).toBe("hi");
    } finally {
      await app.close();
    }
  });
});
