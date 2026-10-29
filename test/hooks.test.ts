import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgentify } from "../src/core.js";
import { type AgentifyHooks, composeHooks, type ToolCall, type ToolCallResult } from "../src/hooks.js";
import { memoryIdempotencyStore } from "../src/idempotency.js";
import { defineTool, ToolError } from "../src/mcp/tools.js";
import type { Principal } from "../src/principal.js";
import { VERSION } from "../src/version.js";
import { apiKey, config, CUSTOMER_KEY, legacy, modern, ordersManifest, rpc, type Running, SERVICE_KEY, start } from "./helpers.js";

/**
 * The extension points: what a deployment (or a paid edition) plugs in for
 * its own credentials, limits, metering and payments. docs/extending.md
 * walks through the same hooks.
 */

describe("hooks over /mcp", () => {
  let app: Running;
  const after: Array<{ call: ToolCall; result: ToolCallResult }> = [];
  const calls = new Map<string, number>();
  // One hook set: agents bring their own key (x-agent-key), get the service key on tool calls,
  // a per-key limit of 3 calls, a "paid" tool that needs a ticket, and every call metered.
  const keys: Record<string, { scopes: string[] }> = { "ak_reader": { scopes: ["api:read"] } };
  const hooks: AgentifyHooks = {
    authenticate: (request) => {
      const key = request.headers.get("x-agent-key");
      if (!key) return null;
      const k = keys[key];
      if (!k) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -31001, message: "Unknown agent key" } }, { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
      return { type: "agent-key", id: `key:${key}`, label: key, scopes: k.scopes, forward: { "x-api-key": SERVICE_KEY, "x-agentify-agent": key } } satisfies Principal;
    },
    listTool: (listing, tool) => (tool.price ? { ...listing, description: `${listing.description}\n\nPaid: $${tool.price} per call.`, _meta: { "example/price": tool.price } } : listing),
    serverMeta: () => ({ "example/payments": { accepts: ["ticket"] } }),
    mcpRequestHeaders: ["X-Agent-Key", "X-Ticket"],
    beforeToolCall: (call) => {
      if (call.principal.type === "agent-key") {
        const n = (calls.get(call.principal.id) ?? 0) + 1;
        calls.set(call.principal.id, n);
        if (n > 3) return { refuse: { kind: "error", status: 429, code: -31029, message: "Rate limit exceeded for this agent", data: { retry_after: 60 }, headers: { "Retry-After": "60" }, outcome: "rate_limited" } };
      }
      if (call.tool.price) {
        const ticket = (call.meta?.["example/ticket"] as string | undefined) ?? call.headers("x-ticket");
        if (!ticket) return { refuse: { kind: "result", output: { content: [{ type: "text", text: "A ticket is required" }], structuredContent: { accepts: ["ticket"] }, isError: true }, outcome: "payment_required" } };
        call.state.ticket = ticket;
        return { headers: { "x-agentify-payer": ticket } };
      }
    },
    afterToolCall: (call, result) => {
      after.push({ call, result });
      if (call.state.ticket && result.success) return { meta: { "example/receipt": { ticket: call.state.ticket } } };
      if (call.state.ticket && !result.success) return { output: { content: [{ type: "text", text: "Withheld" }], isError: true } };
    },
  };
  beforeAll(async () => {
    const tools = ordersManifest();
    tools.tools.find((t) => t.name === "getSalesReport")!.price = "0.01";
    app = await start("hono", config({ tools, hooks }));
  });
  afterAll(() => app.close());

  it("authenticate: a hook's principal forwards its own headers to your routes", async () => {
    const r = await rpc(app.url, legacy("tools/call", { name: "get2", arguments: { id: "ord_1001" } }), { "x-agent-key": "ak_reader" });
    expect(r.json.result.isError).toBe(false);
    expect(app.orders.audit.at(-1)).toMatchObject({ caller: "service", agent: "ak_reader", tool: "get2" });
  });

  it("authenticate: a Response refuses, answered in JSON-RPC with the request's id", async () => {
    const r = await rpc(app.url, legacy("tools/list"), { "x-agent-key": "ak_nope" });
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ jsonrpc: "2.0", error: { code: -31001, message: "Unknown agent key" } });
    expect(typeof r.json.id).toBe("number");
    expect(r.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
  });

  it("without a hook's answer, the built-in passthrough still applies", async () => {
    const r = await rpc(app.url, legacy("tools/call", { name: "get2", arguments: { id: "ord_1001" } }), apiKey(CUSTOMER_KEY));
    expect(r.json.result.isError).toBe(false);
    expect(app.orders.audit.at(-1)).toMatchObject({ caller: "customer", agent: null });
  });

  it("listTool and serverMeta change what clients see", async () => {
    const list = await rpc(app.url, modern("tools/list"), apiKey(CUSTOMER_KEY));
    const report = list.json.result.tools.find((t: { name: string }) => t.name === "getSalesReport");
    expect(report.description).toContain("Paid: $0.01 per call.");
    expect(report._meta).toEqual({ "example/price": "0.01" });
    const d = await rpc(app.url, modern("server/discover"));
    expect(d.json.result._meta["example/payments"]).toEqual({ accepts: ["ticket"] });
  });

  it("beforeToolCall: a refusal as a tool result (terms), then headers on the call once satisfied", async () => {
    const unpaid = await rpc(app.url, legacy("tools/call", { name: "getSalesReport", arguments: {} }), apiKey(CUSTOMER_KEY));
    expect(unpaid.json.result).toMatchObject({ isError: true, structuredContent: { accepts: ["ticket"] } });
    expect(after.at(-1)!.result).toMatchObject({ outcome: "payment_required", success: false });
    const paid = await rpc(app.url, modern("tools/call", { name: "getSalesReport", arguments: {} }, { meta: { "example/ticket": "t-42" } }), apiKey(CUSTOMER_KEY));
    expect(paid.json.result.isError).toBe(false);
    expect(paid.json.result._meta["example/receipt"]).toEqual({ ticket: "t-42" });
    expect(app.orders.audit.at(-1)).toMatchObject({ payer: "t-42", tool: "getSalesReport" });
  });

  it("afterToolCall: can withhold a result", async () => {
    const r = await rpc(app.url, legacy("tools/call", { name: "getSalesReport", arguments: {} }), { "x-ticket": "t-43" });
    // No credentials: the API answers 401, and the hook withholds instead of settling.
    expect(r.json.result).toMatchObject({ isError: true, content: [{ text: "Withheld" }] });
    expect(after.at(-1)!.result).toMatchObject({ outcome: "error", httpStatus: 401, success: false });
  });

  it("beforeToolCall: a refusal as a JSON-RPC error with an HTTP status", async () => {
    for (let i = 0; i < 2; i++) await rpc(app.url, legacy("tools/call", { name: "get2", arguments: { id: "ord_1001" } }), { "x-agent-key": "ak_reader" });
    const r = await rpc(app.url, legacy("tools/call", { name: "get2", arguments: { id: "ord_1001" } }), { "x-agent-key": "ak_reader" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(r.json.error).toMatchObject({ code: -31029, data: { retry_after: 60 } });
    expect(after.at(-1)!.result.outcome).toBe("rate_limited");
  });

  it("afterToolCall hears about every outcome, for metering", () => {
    const outcomes = new Set(after.map((a) => a.result.outcome));
    expect([...outcomes].sort()).toEqual(["error", "ok", "payment_required", "rate_limited"]);
    expect(after.every((a) => typeof a.result.latencyMs === "number")).toBe(true);
  });

  it("CORS on /mcp allows the hooks' request headers", async () => {
    // (The example apps answer preflights with their own cors() first; the core is asked directly.)
    const ag = createAgentify(config({ hooks }));
    const pre = await ag.handle(new Request("http://localhost:3000/mcp", { method: "OPTIONS", headers: { origin: "http://localhost:5173" } }), { dispatch: async () => new Response() });
    expect(pre!.status).toBe(204);
    expect(pre!.headers.get("access-control-allow-headers")).toContain("X-Agent-Key, X-Ticket");
  });
});

describe("hooks: visibility, timeouts and anonymous callers", () => {
  it("toolVisible hides a tool from a caller; an anonymous caller gets the auth challenge for it", async () => {
    const app = await start("express", config({ hooks: { toolVisible: (tool, p) => (tool.name === "getSalesReport" ? p.type !== "anonymous" : undefined) } }));
    try {
      const anon = await rpc(app.url, legacy("tools/list"));
      expect(anon.json.result.tools.map((t: { name: string }) => t.name)).toEqual(["listOrders", "get2"]);
      const call = await rpc(app.url, legacy("tools/call", { name: "getSalesReport", arguments: {} }));
      expect(call.status).toBe(401);
      expect(call.headers.get("www-authenticate")).toBe('Bearer realm="agentify"');
      const withKey = await rpc(app.url, legacy("tools/list"), apiKey(CUSTOMER_KEY));
      expect(withKey.json.result.tools).toHaveLength(3);
    } finally {
      await app.close();
    }
  });

  it('anonymous: "deny" refuses callers without credentials, with a challenge', async () => {
    const app = await start("express", config({ anonymous: "deny" }));
    try {
      const r = await rpc(app.url, legacy("tools/list"));
      expect(r.status).toBe(401);
      expect(r.json.error.code).toBe(-31001);
      expect(r.headers.get("www-authenticate")).toBe('Bearer realm="agentify"');
      expect((await rpc(app.url, legacy("tools/list"), apiKey(CUSTOMER_KEY))).status).toBe(200);
      const card = await (await fetch(`${app.url}/mcp/server-card`)).json();
      expect(card.remotes[0].headers.every((h: { isRequired: boolean }) => h.isRequired)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("a timed-out call reaches afterToolCall with the pending outcome", async () => {
    let finish!: () => void;
    const slow = defineTool({
      name: "slow",
      description: "Takes its time.",
      input: z.object({}),
      timeoutMs: 50,
      handler: () => new Promise((r) => (finish = () => r({ done: true }))),
    });
    let seen: ToolCallResult | undefined;
    const app = await start("hono", config({ codeTools: [slow], hooks: { afterToolCall: (_c, r) => void (seen = r) } }));
    try {
      const r = await rpc(app.url, legacy("tools/call", { name: "slow", arguments: {} }));
      expect(r.json.result).toMatchObject({ isError: true, content: [{ text: "slow timed out after 50 ms" }] });
      expect(seen).toMatchObject({ outcome: "error", success: false });
      expect(seen!.pending).toBeInstanceOf(Promise);
      finish();
      expect(await seen!.pending).toMatchObject({ structuredContent: { done: true } });
    } finally {
      await app.close();
    }
  });

  it("a hook that throws in afterToolCall doesn't break the call", async () => {
    const boom = defineTool({ name: "boom", description: "Fails.", input: z.object({}), handler: async () => { throw new ToolError("nope"); } });
    const app = await start("hono", config({ codeTools: [boom], hooks: { afterToolCall: () => { throw new Error("meter down"); } } }));
    try {
      const r = await rpc(app.url, legacy("tools/call", { name: "boom", arguments: {} }));
      expect(r.json.result).toMatchObject({ isError: true, content: [{ text: "nope" }] });
    } finally {
      await app.close();
    }
  });
});

describe("composeHooks", () => {
  it("runs hooks in the documented order", async () => {
    const log: string[] = [];
    const h = composeHooks([
      {
        authenticate: () => (log.push("auth1"), null),
        beforeToolCall: () => (log.push("before1"), { headers: { a: "1" } }),
        afterToolCall: () => (log.push("after1"), { meta: { one: 1 } }),
        listTool: (l) => ({ ...l, description: `${l.description} +1` }),
        toolVisible: () => undefined,
        surfaces: [{ path: "/one", serve: () => null }],
      },
      {
        authenticate: () => (log.push("auth2"), { type: "x", id: "x", label: "x", scopes: ["*"], forward: {} }),
        beforeToolCall: () => (log.push("before2"), { headers: { b: "2" } }),
        afterToolCall: (_c, r) => (log.push(`after2:${r.output.content.length}`), { output: { content: [] }, meta: { two: 2 } }),
        listTool: (l) => ({ ...l, description: `${l.description} +2` }),
        toolVisible: () => false,
        surfaces: [{ path: "/two", serve: () => null }],
      },
    ]);
    expect(await h.authenticate!(new Request("http://x"), { ip: null, origin: "http://x", resourceMetadataUrl: null })).toMatchObject({ type: "x" });
    const call = {} as ToolCall;
    expect(await h.beforeToolCall!(call)).toEqual({ headers: { a: "1", b: "2" } });
    const out = await h.afterToolCall!(call, { outcome: "ok", output: { content: [{ type: "text", text: "x" }] }, success: true, latencyMs: 1 });
    expect(out).toEqual({ output: { content: [] }, meta: { one: 1, two: 2 } });
    expect(log).toEqual(["auth1", "auth2", "before1", "before2", "after2:1", "after1"]);
    expect(h.listTool!({ name: "t", description: "d", inputSchema: { type: "object" } }, {} as never, {} as never).description).toBe("d +1 +2");
    expect(h.toolVisible!({} as never, {} as never)).toBe(false);
    expect(h.surfaces!.map((s) => s.path)).toEqual(["/one", "/two"]);
  });

  it("guardRoute: the first respond wins and earlier hooks are cancelled; finishes run in reverse", async () => {
    const log: string[] = [];
    const respond = composeHooks([
      { guardRoute: () => ({ setHeaders: { a: "1" }, cancel: async () => void log.push("cancel1") }) },
      { guardRoute: () => ({ respond: new Response(null, { status: 429 }) }) },
      { guardRoute: () => (log.push("never"), undefined) },
    ]);
    const r = await respond.guardRoute!(new Request("http://x"), {} as never);
    expect(r && "respond" in r && r.respond.status).toBe(429);
    expect(log).toEqual(["cancel1"]);
    const merged = composeHooks([
      { guardRoute: () => ({ setHeaders: { a: "1" }, finish: async () => (log.push("finish1"), { headers: { x: "1" } }), idempotencyScope: "key:1" }) },
      { guardRoute: () => ({ removeHeaders: ["b"], buffer: true, finish: async () => (log.push("finish2"), { headers: { y: "2" } }) }) },
    ]);
    const m = await merged.guardRoute!(new Request("http://x"), {} as never);
    expect(m).toMatchObject({ setHeaders: { a: "1" }, removeHeaders: ["b"], buffer: true, idempotencyScope: "key:1" });
    const out = await (m as { finish: (r: never) => Promise<unknown> }).finish({} as never);
    expect(out).toEqual({ headers: { x: "1", y: "2" } });
    expect(log.slice(1)).toEqual(["finish2", "finish1"]);
  });

  it("one hook set is used as is; none is an empty set", () => {
    const one: AgentifyHooks = { serverMeta: () => ({ a: 1 }) };
    expect(composeHooks(one)).toBe(one);
    expect(composeHooks(undefined)).toEqual({});
  });
});

describe("idempotency stores", () => {
  it("the memory store: new, in progress, mismatch, completed, released, expired", async () => {
    let t = 0;
    const s = memoryIdempotencyStore({ now: () => t });
    expect(await s.beginIdempotent("k", "h1", 100, 1000)).toEqual({ state: "new" });
    expect(await s.beginIdempotent("k", "h1", 100, 1000)).toEqual({ state: "in_progress" });
    expect(await s.beginIdempotent("k", "h2", 100, 1000)).toEqual({ state: "mismatch" });
    t = 150; // the first attempt died holding the claim
    expect(await s.beginIdempotent("k", "h1", 100, 1000)).toEqual({ state: "new" });
    await s.completeIdempotent("k", { status: 201, headers: {}, body: "e30=" });
    expect(await s.beginIdempotent("k", "h1", 100, 1000)).toEqual({ state: "completed", response: { status: 201, headers: {}, body: "e30=" } });
    await s.releaseIdempotent("k"); // a completed record stays
    expect((await s.beginIdempotent("k", "h1", 100, 1000)).state).toBe("completed");
    t = 5000;
    expect(await s.beginIdempotent("k", "h2", 100, 1000)).toEqual({ state: "new" });
    expect(await s.beginIdempotent("other", "h", 100, 1000)).toEqual({ state: "new" });
    await s.releaseIdempotent("other");
    expect(await s.beginIdempotent("other", "h", 100, 1000)).toEqual({ state: "new" });
  });

  it("is bounded", async () => {
    const s = memoryIdempotencyStore({ max: 3 });
    for (const k of ["a", "b", "c", "d"]) await s.beginIdempotent(k, "h", 1000, 60_000);
    expect(await s.beginIdempotent("a", "other", 1000, 60_000)).toEqual({ state: "new" });
  });

  it("your own store, shared by your instances, plugs into the config", async () => {
    const used: string[] = [];
    const inner = memoryIdempotencyStore();
    const store = {
      beginIdempotent: (...a: Parameters<typeof inner.beginIdempotent>) => (used.push("begin"), inner.beginIdempotent(...a)),
      completeIdempotent: (...a: Parameters<typeof inner.completeIdempotent>) => (used.push("complete"), inner.completeIdempotent(...a)),
      releaseIdempotent: (...a: Parameters<typeof inner.releaseIdempotent>) => (used.push("release"), inner.releaseIdempotent(...a)),
    };
    const app = await start("express", config({ tools: ordersManifest({ writes: true }), idempotency: { store } }));
    try {
      const send = () =>
        fetch(`${app.url}/v1/orders`, {
          method: "POST",
          headers: { ...apiKey(CUSTOMER_KEY), "user-agent": "ClaudeBot/1.0", "content-type": "application/json", "idempotency-key": "own-1" },
          body: JSON.stringify({ customer: "own@example.com", items: [{ sku: "tea-green", qty: 1 }] }),
        });
      await send();
      expect((await send()).headers.get("idempotent-replayed")).toBe("true");
      expect(used).toEqual(["begin", "complete", "begin"]);
    } finally {
      await app.close();
    }
  });

  it("idempotency: false leaves the header to your app", async () => {
    const app = await start("express", config({ tools: ordersManifest({ writes: true }), idempotency: false }));
    try {
      const send = () =>
        fetch(`${app.url}/v1/orders`, {
          method: "POST",
          headers: { ...apiKey(CUSTOMER_KEY), "user-agent": "ClaudeBot/1.0", "content-type": "application/json", "idempotency-key": "off-1" },
          body: JSON.stringify({ customer: "off@example.com", items: [{ sku: "tea-green", qty: 1 }] }),
        });
      await send();
      expect((await send()).headers.get("idempotent-replayed")).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe("the package", () => {
  it("VERSION is package.json's", () => {
    expect(VERSION).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
  });

  it("the config refuses what isn't built in, and says where it plugs in", async () => {
    const { validateConfig } = await import("../src/config.js");
    expect(() => validateConfig(config({ auth: { mode: "agent-keys" } as never }))).toThrow(/hooks.authenticate/);
    expect(() => validateConfig(config({ anonymous: "paid" as never }))).toThrow(/isn't built in/);
  });
});
