import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectAgent, pathMatcher, userAgentMatcher } from "../src/detect.js";
import type { RouteInfo } from "../src/hooks.js";
import { apiKey, config, CUSTOMER_KEY, FRAMEWORKS, modern, ordersManifest, rpc, type Running, start } from "./helpers.js";

/** On the app's own routes: detection, idempotency, and the guardRoute hook. */

describe("agent detection", () => {
  const match = userAgentMatcher("default");

  it("knows the dated list of AI agents, as whole tokens", () => {
    expect(match("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)")).toBe("ClaudeBot");
    expect(match("Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)")).toBe("ChatGPT-User");
    expect(match("perplexitybot/1.0")).toBe("PerplexityBot");
    expect(match("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15")).toBeNull();
    expect(match("NotClaudeBotReally/1.0")).toBeNull();
    expect(match("curl/8.4.0")).toBeNull();
  });

  it("takes your own list, or none", () => {
    expect(userAgentMatcher(["AcmeAgent"])("AcmeAgent/2 (+https://acme.com)")).toBe("AcmeAgent");
    expect(userAgentMatcher(["AcmeAgent"])("ClaudeBot/1.0")).toBeNull();
    expect(userAgentMatcher(false)("ClaudeBot/1.0")).toBeNull();
  });

  it("records Web Bot Auth's Signature-Agent (not verified)", () => {
    const d = detectAgent(new Headers({ "signature-agent": '"https://chatgpt.com"', "user-agent": "Mozilla/5.0" }), match);
    expect(d).toEqual({ agent: true, via: "signature", name: "https://chatgpt.com", signatureAgent: "https://chatgpt.com" });
    expect(detectAgent(new Headers({ "user-agent": "Mozilla/5.0" }), match).agent).toBe(false);
  });

  it("path globs for include/exclude", () => {
    const m = pathMatcher(["/v1/*", "/"], ["/v1/internal/*"]);
    expect(m("/v1/orders")).toBe(true);
    expect(m("/")).toBe(true);
    expect(m("/v1/internal/x")).toBe(false);
    expect(m("/health")).toBe(false);
    expect(pathMatcher(undefined, undefined)("/anything")).toBe(true);
  });
});

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await fn();
  for (let i = 0; i < 40 && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 25));
    v = await fn();
  }
  return v;
}

for (const fw of FRAMEWORKS) {
  describe(`${fw}: the route guard`, () => {
    let app: Running;
    const seen: Array<{ info: RouteInfo; status?: number }> = [];
    const buckets = new Map<string, number>();
    beforeAll(async () => {
      const tools = ordersManifest({ writes: true });
      tools.tools.find((t) => t.name === "post_v1_orders")!.suggestions = { source: "rules", accepted: true, idempotencyKey: true };
      tools.tools.find((t) => t.name === "listOrders")!.weight = 3;
      app = await start(
        fw,
        config({
          tools,
          detect: { include: ["/v1/*"] },
          hooks: {
            // A tiny rate limiter and meter, the way a deployment would add its own.
            guardRoute: (_request, info) => {
              if (!info.detected.agent) return;
              const entry: { info: RouteInfo; status?: number } = { info };
              seen.push(entry);
              if (info.detected.name === "PerplexityBot") {
                const used = (buckets.get(info.detected.name) ?? 0) + (info.operation?.weight ?? 1);
                buckets.set(info.detected.name, used);
                if (used > 5) return { respond: Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } }) };
              }
              return {
                setHeaders: { "x-agentify-agent": info.detected.name ?? "agent" },
                responseHeaders: { "x-metered": "1" },
                finish: async (res) => {
                  entry.status = res.status;
                  return {};
                },
              };
            },
          },
        }),
      );
    });
    afterAll(() => app.close());

    it("tells the hook what the request is: the operation, the agent, the caller's credentials", async () => {
      const r = await fetch(`${app.url}/v1/orders/ord_1003`, { headers: { ...apiKey(CUSTOMER_KEY), "user-agent": "Claude-User/1.0" } });
      expect(r.status).toBe(200);
      expect(r.headers.get("x-metered")).toBe("1");
      const hit = await waitFor(async () => seen.find((x) => x.info.detected.name === "Claude-User"), (x) => x?.status !== undefined);
      expect(hit!.info).toMatchObject({ operation: { name: "get2" }, canonical: true, ambiguous: false, hasCredentials: true, detected: { agent: true, via: "user-agent" } });
      expect(hit!.status).toBe(200);
      // The header the hook set reached the route, the forged one didn't.
      expect(app.orders.audit.at(-1)).toMatchObject({ agent: "Claude-User", path: "/v1/orders/ord_1003" });
    });

    it("strips forged X-Agentify-* headers from everyone", async () => {
      await fetch(`${app.url}/v1/orders/ord_1003`, { headers: { ...apiKey(CUSTOMER_KEY), "user-agent": "Mozilla/5.0", "x-agentify-agent": "forged", "x-agentify-payer": "0xforged" } });
      expect(app.orders.audit.at(-1)).toMatchObject({ agent: null, payer: null });
    });

    it("a hook can answer instead of the route (a rate limit), people pass", async () => {
      const ua = { ...apiKey(CUSTOMER_KEY), "user-agent": "PerplexityBot/1.0" };
      // listOrders weighs 3 of the 5: the second call is refused.
      expect((await fetch(`${app.url}/v1/orders`, { headers: ua })).status).toBe(200);
      const limited = await fetch(`${app.url}/v1/orders`, { headers: ua });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      for (let i = 0; i < 6; i++) expect((await fetch(`${app.url}/v1/orders`, { headers: apiKey(CUSTOMER_KEY) })).status).toBe(200);
    });

    it("honours Idempotency-Key on agent writes: one order, the same answer twice", async () => {
      const body = JSON.stringify({ customer: "retry@example.com", items: [{ sku: "tea-green", qty: 1 }] });
      const headers = { ...apiKey(CUSTOMER_KEY), "user-agent": "Claude-User/1.0", "content-type": "application/json", "idempotency-key": `k-${fw}-1` };
      const a = await fetch(`${app.url}/v1/orders`, { method: "POST", headers, body });
      const b = await fetch(`${app.url}/v1/orders`, { method: "POST", headers, body });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.headers.get("idempotent-replayed")).toBe("true");
      const [ja, jb] = await Promise.all([a.json(), b.json()]);
      expect(jb.id).toBe(ja.id);
      expect(app.orders.list({ limit: 100 }).orders.filter((o) => o.customer === "retry@example.com")).toHaveLength(1);
    });

    it("leaves people's Idempotency-Key to your app", async () => {
      const body = JSON.stringify({ customer: "person@example.com", items: [{ sku: "tea-green", qty: 1 }] });
      const headers = { ...apiKey(CUSTOMER_KEY), "user-agent": "Mozilla/5.0", "content-type": "application/json", "idempotency-key": `k-${fw}-person` };
      await fetch(`${app.url}/v1/orders`, { method: "POST", headers, body });
      const b = await fetch(`${app.url}/v1/orders`, { method: "POST", headers, body });
      expect(b.headers.get("idempotent-replayed")).toBeNull();
    });

    it("refuses the same key with a different body (422)", async () => {
      const headers = { ...apiKey(CUSTOMER_KEY), "user-agent": "Claude-User/1.0", "content-type": "application/json", "idempotency-key": `k-${fw}-2` };
      await fetch(`${app.url}/v1/orders`, { method: "POST", headers, body: JSON.stringify({ customer: "one@example.com", items: [{ sku: "tea-green", qty: 1 }] }) });
      const r = await fetch(`${app.url}/v1/orders`, { method: "POST", headers, body: JSON.stringify({ customer: "two@example.com", items: [{ sku: "tea-green", qty: 1 }] }) });
      expect(r.status).toBe(422);
    });

    it("stores a 4xx answer too (as Stripe does): the retry gets it back", async () => {
      const headers = { ...apiKey(CUSTOMER_KEY), "user-agent": "Claude-User/1.0", "content-type": "application/json", "idempotency-key": `k-${fw}-3` };
      const bad = JSON.stringify({ customer: "nope", items: [] });
      expect((await fetch(`${app.url}/v1/orders`, { method: "POST", headers, body: bad })).status).toBe(400);
      const again = await fetch(`${app.url}/v1/orders`, { method: "POST", headers, body: bad });
      expect(again.headers.get("idempotent-replayed")).toBe("true");
    });

    it("over MCP: the documented idempotencyKey argument makes a retried write safe", async () => {
      const list = await rpc(app.url, modern("tools/list"), apiKey(CUSTOMER_KEY));
      const create = list.json.result.tools.find((t: { name: string }) => t.name === "post_v1_orders");
      expect(create.inputSchema.properties.idempotencyKey).toMatchObject({ type: "string" });
      const args = { body: { customer: "mcp-retry@example.com", items: [{ sku: "mug-blue", qty: 1 }] }, idempotencyKey: `mcp-${fw}` };
      const a = await rpc(app.url, modern("tools/call", { name: "post_v1_orders", arguments: args }), apiKey(CUSTOMER_KEY));
      const b = await rpc(app.url, modern("tools/call", { name: "post_v1_orders", arguments: args }), apiKey(CUSTOMER_KEY));
      expect(a.json.result.structuredContent.id).toBe(b.json.result.structuredContent.id);
      expect(app.orders.list({ limit: 100 }).orders.filter((o) => o.customer === "mcp-retry@example.com")).toHaveLength(1);
      expect(app.orders.audit.filter((e) => e.tool === "post_v1_orders" && e.method === "POST").length).toBeGreaterThan(0);
    });

    it("leaves excluded paths alone", async () => {
      const before = seen.length;
      const r = await fetch(`${app.url}/health`, { headers: { "user-agent": "ClaudeBot/1.0" } });
      expect(r.status).toBe(200);
      expect(seen.length).toBe(before);
    });
  });
}
