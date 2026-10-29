import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import express from "express";
import Fastify from "fastify";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentify as expressAgentify } from "../src/adapters/express.js";
import { agentifyFastify } from "../src/adapters/fastify.js";
import { agentify as honoAgentify } from "../src/adapters/hono.js";
import { readiness } from "../src/check/rules.js";
import { createAgentify } from "../src/core.js";
import { importOpenApi } from "../src/openapi/convert.js";
import type { RouteInfo } from "../src/hooks.js";
import { apiKey, config, CUSTOMER_KEY, legacy, ordersManifest, ordersSpec, rpc, start } from "./helpers.js";

/**
 * Regression tests for what the review pass found (see the spec's build
 * notes): each one failed before its fix.
 */

const listen = async (server: Server) => {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

/** A tiny API that echoes what it received, to see exactly what reaches your routes. */
function echoApi() {
  const spec = {
    openapi: "3.1.0",
    info: { title: "Echo", version: "1" },
    components: { securitySchemes: { k: { type: "apiKey", in: "header", name: "x-api-key" } } },
    security: [{ k: [] }],
    paths: {
      "/echo": {
        get: { operationId: "echo", responses: { 200: { description: "OK" } } },
        post: { operationId: "note", requestBody: { content: { "application/json": { schema: { type: "object" } } } }, parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" } }], responses: { 201: { description: "OK" } } },
      },
    },
  };
  let n = 0;
  const app = new Hono();
  const manifest = importOpenApi(spec, { includeWrites: true }).manifest;
  const ag = createAgentify({ name: "Echo", spec, tools: manifest, logLevel: "silent" });
  app.use(honoAgentify(ag, { app }));
  app.get("/echo", (c) => c.json({ headers: Object.fromEntries(c.req.raw.headers) }));
  app.post("/echo", async (c) => c.json({ n: ++n, key: c.req.header("x-api-key") ?? null, body: await c.req.json() }, 201));
  return app;
}

describe("review: what reaches your routes", () => {
  let url: string;
  let server: Server;
  beforeAll(async () => {
    server = serve({ fetch: echoApi().fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    url = await listen(server);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("the per-process secret that marks in-process calls never reaches your code", async () => {
    const r = await rpc(url, legacy("tools/call", { name: "echo", arguments: {} }), apiKey("k-1"));
    const seen = r.json.result.structuredContent.headers as Record<string, string>;
    expect(seen["x-agentify-tool"]).toBe("echo");
    expect(seen["x-api-key"]).toBe("k-1");
    expect(seen["x-agentify-internal"]).toBeUndefined();
    expect(seen.cookie).toBeUndefined();
  });

  it("a guessed internal header from outside is stripped, and changes nothing", async () => {
    const r = await fetch(`${url}/echo`, { headers: { "x-agentify-internal": "guess", "x-agentify-tool": "forged" } });
    const seen = (await r.json()).headers as Record<string, string>;
    expect(seen["x-agentify-internal"]).toBeUndefined();
    expect(seen["x-agentify-tool"]).toBeUndefined();
  });

  it("idempotency keys are per credential over MCP: two customers, one key, two results", async () => {
    const call = (key: string) => rpc(url, legacy("tools/call", { name: "note", arguments: { body: { t: key }, "Idempotency-Key": "same-key" } }), apiKey(key));
    const a = await call("customer-a");
    const b = await call("customer-b");
    expect(a.json.result.structuredContent).toMatchObject({ key: "customer-a", body: { t: "customer-a" } });
    expect(b.json.result.structuredContent).toMatchObject({ key: "customer-b", body: { t: "customer-b" } });
    const again = await call("customer-a");
    expect(again.json.result.structuredContent.n).toBe(a.json.result.structuredContent.n);
  });

  it("idempotency keys are per credential on routes too (same IP, same agent UA)", async () => {
    const post = (key: string) =>
      fetch(`${url}/echo`, { method: "POST", headers: { "x-api-key": key, "user-agent": "Claude-User/1.0", "content-type": "application/json", "idempotency-key": "k-route" }, body: JSON.stringify({ t: key }) });
    const a = await (await post("customer-c")).json();
    const b = await (await post("customer-d")).json();
    expect(b.key).toBe("customer-d");
    expect(b.n).not.toBe(a.n);
  });
});

describe("review: caching rules", () => {
  it("documents built from the request's Host (no baseUrl) are never publicly cacheable", async () => {
    const noBase = createAgentify(config());
    const r = await noBase.handle(new Request("http://evil.example/llms.txt"), { dispatch: async () => new Response() });
    expect(r!.headers.get("cache-control")).toBe("private, max-age=60");
    const withBase = createAgentify(config({ baseUrl: "https://api.acme.com" }));
    const r2 = await withBase.handle(new Request("http://evil.example/llms.txt"), { dispatch: async () => new Response() });
    expect(r2!.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await r2!.text()).toContain("https://api.acme.com/mcp");
  });

  it("`security: []` (no auth) doesn't pass the security rule", () => {
    const s = structuredClone(ordersSpec);
    s.security = [];
    expect(readiness(s).rules.find((r) => r.id === "security")!.share).toBe(0);
  });
});

describe("review: switched-off surfaces stay your app's", () => {
  it("surfacePaths lists only what's on", () => {
    const ag = createAgentify(config({ surfaces: { openapi: false, llmsTxt: false } }));
    const paths = ag.surfacePaths();
    expect(paths).toContain("/mcp");
    expect(paths).not.toContain("/openapi.json");
    expect(paths).not.toContain("/llms.txt");
    expect(paths).not.toContain("/robots.txt");
    expect(paths).not.toContain("/.well-known/oauth-protected-resource");
    expect(paths).not.toContain("/agentify/usage");
  });

  it("Fastify: an app with its own /openapi.json and /robots.txt still starts, and keeps them", async () => {
    const app = Fastify();
    await app.register(agentifyFastify, config({ surfaces: { openapi: false } }));
    app.get("/openapi.json", async () => ({ mine: true }));
    app.get("/robots.txt", async () => "User-agent: *");
    await app.ready();
    expect((await app.inject({ url: "/openapi.json" })).json()).toEqual({ mine: true });
    expect((await app.inject({ url: "/llms.txt" })).statusCode).toBe(200);
    await app.close();
  });
});

describe("review: an operation can't be dodged by spelling its path differently", () => {
  for (const [fw, path] of [
    ["express", "/V1/Reports/SALES"],
    ["hono", "/v1/reports/%73ales"],
    ["express", "/v1/reports/sales/"],
  ] as const) {
    it(`${fw}: ${path} is getSalesReport to the guard hook (and not canonical)`, async () => {
      const seen: RouteInfo[] = [];
      const app = await start(fw, config({ tools: importOpenApi(ordersSpec).manifest, hooks: { guardRoute: (_r, info) => void seen.push(info) } }));
      try {
        await fetch(`${app.url}${path}`, { headers: apiKey(CUSTOMER_KEY) });
        expect(seen.at(-1)).toMatchObject({ operation: { name: "getSalesReport" }, canonical: path.endsWith("/") });
      } finally {
        await app.close();
      }
    });
  }
});

describe("review: when Agentify can't load, your API keeps working", () => {
  it("a hook whose setup fails doesn't take your routes down", async () => {
    const app = await start(
      "express",
      config({
        hooks: {
          setup: () => {
            throw new Error("the database is down");
          },
        },
      }),
    );
    try {
      const r = await fetch(`${app.url}/v1/orders/ord_1001`, { headers: { ...apiKey(CUSTOMER_KEY), "user-agent": "ClaudeBot/1.0", "x-agentify-agent": "forged" } });
      expect(r.status).toBe(200);
      expect(app.orders.audit.at(-1)).toMatchObject({ caller: "customer", agent: null });
      // The agent surfaces say so instead.
      expect((await fetch(`${app.url}/llms.txt`)).status).toBe(500);
    } finally {
      await app.close();
    }
  });
});

describe("review: Express body handling", () => {
  it("an agent's JSON write with Idempotency-Key still reaches express.json(), which parses it itself", async () => {
    const app = express();
    app.use(expressAgentify(config({ tools: ordersManifest({ writes: true }), detect: { userAgents: ["TestAgent"] } })));
    app.use(express.json());
    app.post("/v1/orders", (req, res) => {
      res.status(201).json({ body: req.body, flagged: (req as { _body?: boolean })._body === true });
    });
    const server = app.listen(0, "127.0.0.1");
    const url = await listen(server);
    try {
      const send = () => fetch(`${url}/v1/orders`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "TestAgent/1", "idempotency-key": "e1", "x-api-key": CUSTOMER_KEY }, body: JSON.stringify({ a: 1 }) });
      const r = await send();
      // Agentify read the bytes and put them back; it never marks the body parsed.
      expect(await r.json()).toEqual({ body: { a: 1 }, flagged: false });
      const again = await send();
      expect(again.headers.get("idempotent-replayed")).toBe("true");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("review: Hono responses with immutable headers", () => {
  it("still gets Link headers on /", async () => {
    const app = new Hono();
    app.use(honoAgentify(config(), { app }));
    app.get("/", async () => {
      const r = Response.json({ ok: true });
      Object.freeze(r.headers);
      // A response straight from fetch() has immutable headers; simulate with a guarded Headers.
      return new Proxy(r, {
        get(target, prop) {
          if (prop === "headers") {
            const h = target.headers;
            return new Proxy(h, { get: (t, p) => (p === "set" ? () => { throw new TypeError("immutable"); } : typeof (t as any)[p] === "function" ? (t as any)[p].bind(t) : (t as any)[p]) });
          }
          const v = (target as any)[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    });
    const res = await app.request("/");
    expect(res.headers.get("link")).toContain("llms-txt");
  });
});

