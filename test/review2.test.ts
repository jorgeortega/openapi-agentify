import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { agentifyFastify } from "../src/adapters/fastify.js";
import { nextDispatcher } from "../src/adapters/next.js";
import { validateConfig } from "../src/config.js";
import { ambiguousPath, createAgentify } from "../src/core.js";
import { httpDispatcher, INTERNAL_HEADER } from "../src/dispatch.js";
import type { RouteInfo } from "../src/hooks.js";
import { importOpenApi } from "../src/openapi/convert.js";
import { apiKey, config, CUSTOMER_KEY, ordersManifest, ordersSpec, start } from "./helpers.js";

/**
 * Regression tests for the second review (an independent adversarial pass):
 * each scenario was demonstrated against the code before its fix.
 */

const rawGet = (url: string, path: string, headers: Record<string, string> = {}) =>
  // fetch() would tidy the path; send it exactly as written.
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const u = new URL(url);
    import("node:http").then(({ request }) => {
      const r = request({ host: u.hostname, port: u.port, path, method: "GET", headers }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
      r.on("error", reject);
      r.end();
    });
  });

describe("review 2: paths a router could resolve differently", () => {
  it("knows ambiguous paths", () => {
    for (const p of ["/a/../b", "/a/%2e%2e/b", "/a/%2E/b", "//a", "/a%2fb", "/a%5cb", "/a\\b"]) expect(ambiguousPath(p)).toBe(true);
    for (const p of ["/v1/orders/ord_1", "/v1/orders/a%20b", "/v1/reports/sales?x=1", "/"]) expect(ambiguousPath(p)).toBe(false);
  });

  it("Express: an agent's request through dot segments or empty segments is refused, not guessed at", async () => {
    const seen: RouteInfo[] = [];
    const app = await start("express", config({ tools: importOpenApi(ordersSpec).manifest, hooks: { guardRoute: (_r, info) => void seen.push(info) } }));
    try {
      const agent = { ...apiKey(CUSTOMER_KEY), "user-agent": "ClaudeBot/1.0" };
      expect((await rawGet(app.url, "/v1/orders/x/%2e%2e/%2e%2e/reports/sales", agent)).status).toBe(400);
      expect((await rawGet(app.url, "//v1/reports/sales", agent)).status).toBe(400);
      expect(seen).toHaveLength(0);
      // People aren't refused: their request is the router's to resolve, and the hook is told.
      await rawGet(app.url, "//v1/reports/sales", apiKey(CUSTOMER_KEY));
      expect(seen.at(-1)).toMatchObject({ ambiguous: true });
    } finally {
      await app.close();
    }
  });

  for (const [fw, path] of [
    ["express", "/V1/reports/sales"],
    ["hono", "/%761/reports/sales"],
    ["fastify", "/%761/reports/sales"],
  ] as const) {
    it(`${fw}: detect.include matches ${path} as a router would`, async () => {
      const seen: RouteInfo[] = [];
      const app = await start(fw, config({ tools: importOpenApi(ordersSpec).manifest, detect: { include: ["/v1/*"] }, hooks: { guardRoute: (_r, info) => void seen.push(info) } }));
      try {
        await rawGet(app.url, path, apiKey(CUSTOMER_KEY));
        expect(seen.at(-1)).toMatchObject({ operation: { name: "getSalesReport" }, canonical: false });
      } finally {
        await app.close();
      }
    });
  }
});

describe("review 2: who is calling", () => {
  it("trustProxy reads the hop your proxy added, not what the client wrote", async () => {
    const seen: RouteInfo[] = [];
    const app = await start("express", config({ trustProxy: true, hooks: { guardRoute: (_r, info) => void seen.push(info) } }));
    try {
      const h = (spoof: string) => ({ ...apiKey(CUSTOMER_KEY), "user-agent": "ClaudeBot/1.0", "x-forwarded-for": `${spoof}, 203.0.113.9` });
      await fetch(`${app.url}/v1/orders/ord_1001`, { headers: h("1.1.1.1") });
      await fetch(`${app.url}/v1/orders/ord_1001`, { headers: h("2.2.2.2") });
      expect(seen.map((i) => i.ip)).toEqual(["203.0.113.9", "203.0.113.9"]);
    } finally {
      await app.close();
    }
  });

  it("an agent with no IP and no credential gets no shared idempotency namespace", async () => {
    const ag = createAgentify(config({ tools: ordersManifest({ writes: true }) }));
    const g = await ag.guard(new Request("http://x/v1/orders", { method: "POST", headers: { "user-agent": "ClaudeBot/1.0", "idempotency-key": "k", "content-type": "application/json" }, body: "{}" }), {
      dispatch: async () => new Response(),
      ip: null,
    });
    expect(g.action === "continue" && g.buffer).toBe(false);
  });
});

describe("review 2: where credentials and the marker may go", () => {
  it("passthrough refuses to dispatch agents' credentials to another origin; a loopback is fine", () => {
    expect(() => validateConfig(config({ baseUrl: "https://api.acme.com", dispatch: { mode: "http", url: "https://other.example" } }))).toThrow(/passthrough refuses to start/);
    expect(() => validateConfig(config({ baseUrl: "https://api.acme.com", dispatch: { mode: "http", url: "http://127.0.0.1:8080" } }))).not.toThrow();
    expect(() => validateConfig(config({ dispatch: { mode: "http", url: "http://127.0.0.1:8080" } }))).toThrow(/needs baseUrl/);
  });

  it("the in-process marker is never sent to another host", async () => {
    const seen: Array<string | null> = [];
    const f = (async (_u: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get(INTERNAL_HEADER));
      return new Response("{}");
    }) as typeof fetch;
    await httpDispatcher("https://internal.example", f)(new Request("https://api/x", { headers: { [INTERNAL_HEADER]: "secret" } }), { remoteAddress: null });
    await httpDispatcher("http://127.0.0.1:9", f)(new Request("https://api/x", { headers: { [INTERNAL_HEADER]: "secret" } }), { remoteAddress: null });
    expect(seen).toEqual([null, "secret"]);
  });

  it("Next.js: a handler (even unwrapped) never sees the marker", async () => {
    let got: string | null | undefined;
    const d = nextDispatcher({ "/x": { GET: async (req) => ((got = req.headers.get(INTERNAL_HEADER)), Response.json({})) } });
    await d(new Request("http://app/x", { headers: { [INTERNAL_HEADER]: "secret" } }), { remoteAddress: null });
    expect(got).toBeNull();
  });
});

describe("review 2: Fastify keeps a big agent body whole", () => {
  it("a 1.5 MiB JSON body with Idempotency-Key reaches the route intact", async () => {
    const app = Fastify({ bodyLimit: 5 * 1024 * 1024 });
    await app.register(agentifyFastify, config({ detect: { userAgents: ["TestAgent"] } }));
    app.post("/v1/orders", async (req) => ({ size: JSON.stringify(req.body).length }));
    await app.ready();
    const body = JSON.stringify({ blob: "x".repeat(1.5 * 1024 * 1024) });
    const r = await app.inject({ method: "POST", url: "/v1/orders", headers: { "content-type": "application/json", "user-agent": "TestAgent/1", "idempotency-key": "big", "transfer-encoding": "chunked" }, payload: body });
    expect(r.json()).toEqual({ size: body.length });
    await app.close();
  });
});
