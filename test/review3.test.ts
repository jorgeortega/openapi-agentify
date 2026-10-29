import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import express from "express";
// Express 4, installed under an alias next to Express 5.
// @ts-expect-error express4 has no bundled types; its API is the one used here
import express4 from "express4";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentify as expressAgentify } from "../src/adapters/express.js";
import { agentify as honoAgentify, dispatchEnv } from "../src/adapters/hono.js";
import { readiness, unpatternedTemplates } from "../src/check/rules.js";
import { init, insideProject } from "../src/cli/init.js";
import { detectProject } from "../src/cli/project.js";
import type { AgentifyConfig } from "../src/config.js";
import { compilePath } from "../src/core.js";
import { INTERNAL_HEADER } from "../src/dispatch.js";
import type { RouteInfo } from "../src/hooks.js";
import { defineTool, pathParamValidator } from "../src/mcp/tools.js";
import { importOpenApi } from "../src/openapi/convert.js";
import type { Manifest } from "../src/openapi/manifest.js";
import type { Principal } from "../src/principal.js";
import { EventSampler } from "../src/util/sample.js";
import { apiKey, config, CUSTOMER_KEY, FRAMEWORKS, legacy, ordersManifest, ordersSpec, rpc, start } from "./helpers.js";

/**
 * The third review (security): regression tests for each finding that
 * concerns the open core, numbered as in the review.
 */

async function listen(server: Server): Promise<string> {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const close = (server: Server) => new Promise<void>((r) => server.close(() => r()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const temp = () => mkdtempSync(join(tmpdir(), "agentify-r3-"));

function raw(url: string, opts: { method?: string; path: string; headers: Record<string, string>; body?: string; chunks?: string[] }) {
  const u = new URL(url);
  return new Promise<{ status: number; body: string }>((done, fail) => {
    const headers = { ...opts.headers, ...(opts.body !== undefined ? { "content-length": String(Buffer.byteLength(opts.body)) } : {}) };
    const r = httpRequest({ host: u.hostname, port: u.port, path: opts.path, method: opts.method ?? "POST", headers }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => done({ status: res.statusCode!, body: b }));
    });
    r.on("error", fail);
    if (opts.chunks) for (const c of opts.chunks) r.write(c);
    r.end(opts.body);
  });
}

const writes = () => ordersManifest({ writes: true });

// ── 0. The package ─────────────────────────────────────────────────────────

describe("review3 #0: the npm package", () => {
  it("package.json's files keep dist/ and bin/ in the pack, and leave tests, examples and sources out", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.files).toEqual(expect.arrayContaining(["dist/src", "bin"]));
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", shell: process.platform === "win32" });
    expect(r.status).toBe(0);
    const files = (JSON.parse(r.stdout)[0].files as Array<{ path: string }>).map((f) => f.path);
    expect(files).toEqual(expect.arrayContaining(["bin/openapi-agentify.mjs", "package.json", "LICENSE", "README.md"]));
    if (existsSync("dist/src/index.js")) expect(files).toContain("dist/src/index.js");
    expect(files.some((f) => f.startsWith("test/") || f.startsWith("examples/") || f.startsWith("src/"))).toBe(false);
  });

  it("init adds openapi-agentify to package.json's dependencies (once)", async () => {
    const dir = temp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "api", dependencies: { express: "^5.0.0" } }));
    writeFileSync(join(dir, "openapi.json"), JSON.stringify(ordersSpec));
    const lines: string[] = [];
    expect((await init({ dir, yes: true, out: (l) => lines.push(l) })).code).toBe(0);
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies["openapi-agentify"]).toBe(`^${version}`);
    await init({ dir, yes: true, out: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("already depends on openapi-agentify");
  });
});

// ── 1 and 8. Express: the app's own body parser always runs ────────────────

describe("review3 #1/#8: Express never parses the body for the app", () => {
  const SECRET = "whsec_test";
  const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");

  for (const [label, lib] of [
    ["Express 5", express],
    ["Express 4", express4],
  ] as const) {
    it(`${label}: express.json's verify hook and limit run for an agent with an Idempotency-Key on an operation`, async () => {
      const app = (lib as typeof express)();
      let runs = 0;
      app.use(expressAgentify(config({ tools: writes() })));
      app.use(
        (lib as typeof express).json({
          limit: "1kb",
          verify: (req, _res, buf) => {
            if (sign(buf.toString()) !== req.headers["x-signature"]) throw Object.assign(new Error("bad signature"), { status: 401 });
          },
        }),
      );
      app.post("/v1/orders", (req, res) => {
        runs++;
        res.status(201).json({ got: req.body });
      });
      app.use((err: { status?: number; type?: string; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(err.status ?? 500).json({ error: err.type ?? err.message });
      });
      const server = app.listen(0, "127.0.0.1");
      const url = await listen(server);
      try {
        const agent = { "content-type": "application/json", "user-agent": "ClaudeBot/1.0" };
        const body = JSON.stringify({ customer: "x@example.com" });
        const forged = await fetch(`${url}/v1/orders`, { method: "POST", headers: { ...agent, "idempotency-key": "k1", "x-signature": "forged" }, body });
        expect(forged.status).toBe(401);
        const sig = await fetch(`${url}/v1/orders`, { method: "POST", headers: { ...agent, "signature-agent": "x", "idempotency-key": "k2", "x-signature": "forged" }, body });
        expect(sig.status).toBe(401);
        const big = JSON.stringify({ text: "x".repeat(5_000) });
        const tooBig = await fetch(`${url}/v1/orders`, { method: "POST", headers: { ...agent, "idempotency-key": "k3", "x-signature": sign(big) }, body: big });
        expect(tooBig.status).toBe(413);
        const bad = await fetch(`${url}/v1/orders`, { method: "POST", headers: { ...agent, "idempotency-key": "k4", "x-signature": sign("{bad") }, body: "{bad" });
        expect(bad.status).toBe(400);
        expect(runs).toBe(0);
        // A good request still gets idempotency: the replay doesn't run the handler again.
        const ok = () => fetch(`${url}/v1/orders`, { method: "POST", headers: { ...agent, "idempotency-key": "k5", "x-signature": sign(body) }, body });
        expect((await ok()).status).toBe(201);
        const again = await ok();
        expect(again.headers.get("idempotent-replayed")).toBe("true");
        expect(await again.json()).toEqual({ got: { customer: "x@example.com" } });
        expect(runs).toBe(1);
      } finally {
        await close(server);
      }
    });
  }

  it("#8: a chunked body over 1 MiB reaches the route whole (no hash, no replay protection from Agentify)", async () => {
    const app = express();
    app.use(expressAgentify(config({ tools: writes() })));
    app.use(express.json({ limit: "10mb" }));
    app.post("/v1/orders", (req, res) => res.json({ bytes: JSON.stringify(req.body).length }));
    const server = app.listen(0, "127.0.0.1");
    const url = await listen(server);
    try {
      const text = JSON.stringify({ note: "x".repeat(1024 * 1024 + 100) });
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += 64 * 1024) chunks.push(text.slice(i, i + 64 * 1024));
      const r = await raw(url, { path: "/v1/orders", headers: { "content-type": "application/json", "transfer-encoding": "chunked", "user-agent": "ClaudeBot/1.0", "idempotency-key": "big" }, chunks });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body).bytes).toBe(text.length);
    } finally {
      await close(server);
    }
  });

  it("non-JSON bodies are hashed by their raw bytes: the same key with another body is refused", async () => {
    const app = express();
    app.use(expressAgentify(config({ tools: writes() })));
    app.use(express.text());
    app.post("/v1/orders", (req, res) => res.status(201).json({ got: req.body }));
    const server = app.listen(0, "127.0.0.1");
    const url = await listen(server);
    try {
      const send = (body: string) => fetch(`${url}/v1/orders`, { method: "POST", headers: { "content-type": "text/plain", "user-agent": "ClaudeBot/1.0", "idempotency-key": "t1" }, body });
      expect(await (await send("first")).json()).toEqual({ got: "first" });
      expect((await send("second")).status).toBe(422);
    } finally {
      await close(server);
    }
  });

  it("an Idempotency-Key on a route that isn't an operation is left to the app", async () => {
    const app = express();
    let runs = 0;
    app.use(expressAgentify(config({ tools: writes() })));
    app.use(express.json());
    app.post("/webhooks/payment", (_req, res) => {
      runs++;
      res.json({ runs });
    });
    const server = app.listen(0, "127.0.0.1");
    const url = await listen(server);
    try {
      const send = () => fetch(`${url}/webhooks/payment`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "ClaudeBot/1.0", "idempotency-key": "w1" }, body: "{}" });
      await send();
      const second = await send();
      expect(second.headers.get("idempotent-replayed")).toBeNull();
      expect(runs).toBe(2);
    } finally {
      await close(server);
    }
  });
});

// ── 2. Disabled operations are not operations ──────────────────────────────

describe("review3 #2: operations disabled in agentify.tools.json", () => {
  const disabledManifest = (): Manifest => {
    const m = importOpenApi(ordersSpec).manifest; // writes off: create and refund disabled
    for (const t of m.tools) if ((t.path === "/v1/orders" && t.method === "GET") || t.path === "/v1/reports/sales") t.enabled = false;
    return m;
  };

  for (const fw of FRAMEWORKS) {
    it(`${fw}: not a tool, not advertised, and a hook is told it's disabled`, async () => {
      const seen: RouteInfo[] = [];
      const app = await start(fw, config({ tools: disabledManifest(), hooks: { guardRoute: (_r, info) => void seen.push(info) } }));
      try {
        // On the route itself it's your API's call (and auth): the hook just knows agents may not use it.
        await fetch(`${app.url}/v1/orders/ord_1004/refund`, { method: "POST", headers: { ...apiKey(CUSTOMER_KEY), "user-agent": "ClaudeBot/1.0", "content-type": "application/json" }, body: "{}" });
        expect(seen.at(-1)).toMatchObject({ operation: null, disabled: { name: "refundOrder" } });
        const list = await rpc(app.url, legacy("tools/list"), apiKey(CUSTOMER_KEY));
        expect(list.json.result.tools.map((t: { name: string }) => t.name)).toEqual(["get2"]);
        const call = await rpc(app.url, legacy("tools/call", { name: "refundOrder", arguments: { id: "ord_1002" } }), apiKey(CUSTOMER_KEY));
        expect(call.json.error.message).toMatch(/Unknown tool/);
        expect(app.orders.get("ord_1002")!.status).toBe("paid");
        const llms = await (await fetch(`${app.url}/llms.txt`)).text();
        expect(llms).not.toContain("getSalesReport");
        const spec = await (await fetch(`${app.url}/openapi.json`)).json();
        expect(spec.paths["/v1/reports/sales"].get["x-agentify"]).toEqual({ agents: false });
        const card = await (await fetch(`${app.url}/mcp/server-card`)).text();
        expect(card).not.toContain("getSalesReport");
      } finally {
        await app.close();
      }
    });
  }

  it("a disabled static path is never taken for an enabled template", async () => {
    const spec = structuredClone(ordersSpec);
    spec.paths["/v1/orders/export"] = { get: { operationId: "exportOrders", summary: "Export", responses: { 200: { description: "ok" } } } };
    const m = importOpenApi(spec).manifest;
    for (const t of m.tools) if (t.name === "exportOrders") t.enabled = false;
    const seen: RouteInfo[] = [];
    const app = express();
    app.use(expressAgentify(config({ spec, tools: m, hooks: { guardRoute: (_r, info) => void seen.push(info) } })));
    app.get("/v1/orders/:id", (req, res) => res.json({ id: req.params.id }));
    const server = app.listen(0, "127.0.0.1");
    const url = await listen(server);
    try {
      await fetch(`${url}/v1/orders/export`);
      expect(seen.at(-1)).toMatchObject({ operation: null, disabled: { name: "exportOrders" } });
      await fetch(`${url}/v1/orders/ord_1`);
      expect(seen.at(-1)).toMatchObject({ operation: { name: "get2" }, disabled: null });
    } finally {
      await close(server);
    }
  });
});

// ── 3. Template shadowing ──────────────────────────────────────────────────

describe("review3 #3: path parameters are checked against the spec, and the operation is named", () => {
  const patterned = () => {
    const spec = structuredClone(ordersSpec);
    for (const item of Object.values(spec.paths) as Array<Record<string, { parameters?: Array<{ in: string; schema: Record<string, unknown> }> }>>) {
      for (const op of Object.values(item)) for (const p of op.parameters ?? []) if (p.in === "path") p.schema = { type: "string", pattern: "^ord_[0-9]+$" };
    }
    return spec;
  };

  it("a route outside the spec that matches a template isn't the operation when the id has a pattern (HTTP and MCP)", async () => {
    const spec = patterned();
    const seen: RouteInfo[] = [];
    const app = express();
    app.use(expressAgentify(config({ spec, tools: importOpenApi(spec).manifest, hooks: { guardRoute: (_r, info) => void seen.push(info) } })));
    app.get("/v1/orders/export", (_req, res) => res.json({ export: "internal" }));
    app.get("/v1/orders/:id", (req, res) => res.json({ id: req.params.id, operation: req.headers["x-agentify-operation"] ?? null }));
    const server = app.listen(0, "127.0.0.1");
    const url = await listen(server);
    try {
      await fetch(`${url}/v1/orders/export`, { headers: { "user-agent": "ClaudeBot/1.0" } });
      expect(seen.at(-1)).toMatchObject({ operation: null, disabled: null });
      await fetch(`${url}/v1/orders/ord_1`, { headers: { "user-agent": "ClaudeBot/1.0" } });
      expect(seen.at(-1)).toMatchObject({ operation: { name: "get2" }, canonical: true });
      const shadow = await rpc(url, legacy("tools/call", { name: "get2", arguments: { id: "export" } }));
      expect(shadow.json.result.isError).toBe(true);
      expect(shadow.json.result.structuredContent.error).toBe("invalid_input");
      // Tool calls name the operation they're for, so a route can check.
      const ok = await rpc(url, legacy("tools/call", { name: "get2", arguments: { id: "ord_1" } }));
      expect(ok.json.result.structuredContent).toEqual({ id: "ord_1", operation: "get2" });
    } finally {
      await close(server);
    }
  });

  it("the path matcher captures parameters, and constrained ones are validated", () => {
    expect(compilePath("/v1/orders/{id}/items/{item}.json").names).toEqual(["id", "item"]);
    expect(pathParamValidator({ type: "string" })).toBeNull();
    const n = pathParamValidator({ type: "integer", minimum: 1 })!;
    expect([n("12"), n("0"), n("export")]).toEqual([true, false, false]);
    expect(pathParamValidator({ type: "string", enum: ["a", "b"] })!("c")).toBe(false);
    expect(pathParamValidator({ type: "string", format: "uuid" })!("export")).toBe(false);
  });

  it("check flags templated parameters without a pattern where a service credential is handed out", () => {
    const warnings = unpatternedTemplates(ordersManifest());
    expect(warnings.some((w) => w.startsWith("GET /v1/orders/{id}: {id} takes any value"))).toBe(true);
    expect(unpatternedTemplates(importOpenApi(patterned()).manifest)).toEqual([]);
    expect(readiness(ordersSpec, { manifest: ordersManifest(), serviceCredential: true }).warnings.join("\n")).toContain("X-Agentify-Operation");
    expect(readiness(ordersSpec, { manifest: ordersManifest() }).warnings.join("\n")).not.toContain("X-Agentify-Operation");
  });
});

// ── 5. Scopes ──────────────────────────────────────────────────────────────

describe("review3 #5: /mcp scope defaults, for callers a hook gives scopes", () => {
  it("a tool without a scope needs api:write for writes (api:read for reads); a code tool without one needs api:write", async () => {
    const manifest = writes();
    for (const t of manifest.tools) delete t.scope;
    const codeTools = [defineTool({ name: "wipeCache", description: "Wipes the cache", input: z.object({}), handler: async () => "wiped" })];
    const keys: Record<string, string[]> = { ro: ["api:read"], rw: ["api:read", "api:write"] };
    const authenticate = (request: Request): Principal | null => {
      const k = request.headers.get("x-agent-key");
      const scopes = k ? keys[k] : undefined;
      return scopes ? { type: "api-key", id: `key:${k}`, label: k!, scopes, forward: apiKey(CUSTOMER_KEY) } : null;
    };
    const app = await start("express", config({ tools: manifest, codeTools, hooks: { authenticate } }));
    try {
      const list = await rpc(app.url, legacy("tools/list"), { "x-agent-key": "ro" });
      const names = list.json.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("get2");
      expect(names).not.toContain("refundOrder");
      expect(names).not.toContain("wipeCache");
      const refund = await rpc(app.url, legacy("tools/call", { name: "refundOrder", arguments: { id: "ord_1002", body: { reason: "x" } } }), { "x-agent-key": "ro" });
      expect(refund.json.error?.message ?? "").toMatch(/Unknown tool|scope/);
      expect(app.orders.get("ord_1002")!.status).toBe("paid");
      const wipe = await rpc(app.url, legacy("tools/call", { name: "wipeCache", arguments: {} }), { "x-agent-key": "rw" });
      expect(wipe.json.result.content[0].text).toBe("wiped");
      // A read-only caller marked stepUp sees the write, and calling it is a 403 challenge.
    } finally {
      await app.close();
    }
  });

  it("stepUp callers see tools they lack the scope for, and get a 403 insufficient_scope challenge", async () => {
    const authenticate = (): Principal => ({ type: "oauth", id: "sub:1", label: "client", scopes: ["api:read"], forward: apiKey(CUSTOMER_KEY), stepUp: true });
    const app = await start("express", config({ tools: writes(), hooks: { authenticate } }));
    try {
      const names = (await rpc(app.url, legacy("tools/list"))).json.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("refundOrder");
      const refund = await rpc(app.url, legacy("tools/call", { name: "refundOrder", arguments: { id: "ord_1002" } }));
      expect(refund.status).toBe(403);
      expect(refund.headers.get("www-authenticate")).toBe('Bearer realm="agentify", error="insufficient_scope", scope="api:write"');
      expect(app.orders.get("ord_1002")!.status).toBe("paid");
    } finally {
      await app.close();
    }
  });
});

// ── 6. DNS rebinding without baseUrl ───────────────────────────────────────

describe("review3 #6: /mcp without baseUrl only takes browser requests from loopback pages on a loopback Host", () => {
  const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get2", arguments: { id: "ord_1001" } } });
  const hdr = { "content-type": "application/json", "mcp-protocol-version": "2025-11-25" };

  for (const fw of FRAMEWORKS) {
    it(`${fw}: a rebinding page (Host = Origin = attacker) is refused`, async () => {
      const app = await start(fw, config());
      try {
        const port = new URL(app.url).port;
        const rebind = await raw(app.url, { path: "/mcp", headers: { ...hdr, host: `attacker.example:${port}`, origin: `http://attacker.example:${port}` }, body: call });
        expect(rebind.status).toBe(403);
        const local = await raw(app.url, { path: "/mcp", headers: { ...hdr, host: `localhost:${port}`, origin: `http://localhost:${port}` }, body: call });
        expect(local.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }

  it("clients that send no Origin (agents, not browsers) and allowedOrigins still work", async () => {
    const app = await start("express", config({ allowedOrigins: ["https://console.example"] }));
    try {
      const port = new URL(app.url).port;
      expect((await raw(app.url, { path: "/mcp", headers: { ...hdr, host: `api.example:${port}` }, body: call })).status).toBe(200);
      expect((await raw(app.url, { path: "/mcp", headers: { ...hdr, origin: "https://console.example" }, body: call })).status).toBe(200);
      expect((await raw(app.url, { path: "/mcp", headers: { ...hdr, host: `api.example:${port}`, origin: `http://api.example:${port}` }, body: call })).status).toBe(403);
    } finally {
      await app.close();
    }
  });
});

// ── 7. Forwarded host with trustProxy ──────────────────────────────────────

describe("review3 #7: X-Forwarded-Host is read like X-Forwarded-For, and baseUrl wins", () => {
  async function tenantApp(extra: Partial<AgentifyConfig>) {
    const app = express();
    app.use(expressAgentify(config({ trustProxy: true, ...extra })));
    app.get("/v1/orders/:id", (req, res) => res.json({ tenant: req.headers.host }));
    const server = app.listen(0, "127.0.0.1");
    return { url: await listen(server), server };
  }

  it("the proxy-added (rightmost) host, not the one the client wrote", async () => {
    const { url, server } = await tenantApp({});
    try {
      const m = await rpc(url, legacy("tools/call", { name: "get2", arguments: { id: "ord_1" } }), { ...apiKey(CUSTOMER_KEY), "x-forwarded-host": "victim.api.test, acme.api.test", "x-forwarded-proto": "http, https" });
      expect(m.json.result.structuredContent).toEqual({ tenant: "acme.api.test" });
      const llms = await (await fetch(`${url}/llms.txt`, { headers: { "x-forwarded-host": "evil.test, acme.api.test", "x-forwarded-proto": "https" } })).text();
      expect(llms).toContain("https://acme.api.test/mcp");
      expect(llms).not.toContain("evil.test");
    } finally {
      await close(server);
    }
  });

  it("with baseUrl, forwarded headers don't matter", async () => {
    const { url, server } = await tenantApp({ baseUrl: "https://api.example.com" });
    try {
      const llms = await (await fetch(`${url}/llms.txt`, { headers: { "x-forwarded-host": "evil.test", "x-forwarded-proto": "http" } })).text();
      expect(llms).toContain("https://api.example.com/mcp");
      expect(llms).not.toContain("evil.test");
    } finally {
      await close(server);
    }
  });
});

// ── 9. Sampling ───────────────────────────────────────────────────────────

describe("review3 #9: the event sampler (for hooks that log floods)", () => {
  it("the sampler is bounded, and reports what it held back", () => {
    const held: Array<[string, number]> = [];
    const s = new EventSampler((k, n) => held.push([k, n]), 1000, 3);
    expect([s.take("a", 0), s.take("a", 1), s.take("a", 2)]).toEqual([true, false, false]);
    expect(s.take("a", 2000)).toBe(true);
    expect(held).toEqual([["a", 2]]);
    for (const k of ["b", "c", "d", "e"]) s.take(k, 2000);
    expect(s.size).toBeLessThanOrEqual(3);
  });

});

// ── Lower-confidence items ─────────────────────────────────────────────────

describe("review3: lower-confidence items", () => {
  it("idempotency scope includes the cookies: two browser sessions with the same key don't share a replay", async () => {
    const app = express();
    let runs = 0;
    app.use(expressAgentify(config({ tools: writes() })));
    app.use(express.json());
    app.post("/v1/orders", (req, res) => {
      runs++;
      res.status(201).json({ for: req.headers.cookie });
    });
    const server = app.listen(0, "127.0.0.1");
    const url = await listen(server);
    try {
      const send = (cookie: string) => fetch(`${url}/v1/orders`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "ClaudeBot/1.0", "idempotency-key": "same", cookie }, body: "{}" });
      expect(await (await send("sid=alice")).json()).toEqual({ for: "sid=alice" });
      expect(await (await send("sid=bob")).json()).toEqual({ for: "sid=bob" });
      expect((await send("sid=alice")).headers.get("idempotent-replayed")).toBe("true");
      expect(runs).toBe(2);
    } finally {
      await close(server);
    }
  });

  it("the X-Agentify-Internal marker is single-use: one seen by earlier middleware is dead afterwards", async () => {
    let seen: string | undefined;
    const app = express();
    app.use((req, _res, next) => {
      const v = req.headers[INTERNAL_HEADER];
      if (typeof v === "string") seen = v;
      next();
    });
    app.use(expressAgentify(config()));
    app.get("/v1/orders/:id", (req, res) => res.json({ agent: req.headers["x-agentify-agent"] ?? null, internal: req.headers[INTERNAL_HEADER] ?? null }));
    const server = app.listen(0, "127.0.0.1");
    const url = await listen(server);
    try {
      const m = await rpc(url, legacy("tools/call", { name: "get2", arguments: { id: "ord_1" } }));
      expect(m.json.result.structuredContent).toEqual({ agent: null, internal: null });
      expect(seen).toBeTruthy();
      const replay = await fetch(`${url}/v1/orders/ord_1`, { headers: { [INTERNAL_HEADER]: seen!, "x-agentify-agent": "forged" } });
      expect(await replay.json()).toEqual({ agent: null, internal: null });
      // And /mcp answers it as the surface, not as an internal call.
      expect((await rpc(url, legacy("tools/list"), { [INTERNAL_HEADER]: seen! })).status).toBe(200);
    } finally {
      await close(server);
    }
  });

  it("Hono: a tool call doesn't see the /mcp request's own incoming/outgoing", async () => {
    const app = new Hono<{ Bindings: { incoming?: { headers: Record<string, string>; socket: { remoteAddress: string } } } }>();
    app.use(honoAgentify(config(), { app }));
    app.get("/v1/orders/:id", (c) => c.json({ callerSecret: c.env?.incoming?.headers["x-caller-secret"] ?? null, remote: c.env?.incoming?.socket.remoteAddress ?? null, hasOutgoing: "outgoing" in (c.env ?? {}) }));
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    const url = await listen(server);
    try {
      const m = await rpc(url, legacy("tools/call", { name: "get2", arguments: { id: "ord_1" } }), { "x-caller-secret": "s3cret" });
      expect(m.json.result.structuredContent).toEqual({ callerSecret: null, remote: "127.0.0.1", hasOutgoing: false });
      expect(dispatchEnv({ DB: 1 }, new Request("http://x/"), null)).toEqual({ DB: 1 });
    } finally {
      await close(server);
    }
  });

  it("init never takes an entry file outside the project, and warns about Next.js middleware/proxy", async () => {
    const root = temp();
    mkdirSync(join(root, "outside"));
    mkdirSync(join(root, "api"));
    writeFileSync(join(root, "outside", "server.js"), 'import express from "express";\nconst app = express();\n');
    writeFileSync(join(root, "api", "package.json"), JSON.stringify({ name: "api", main: "../outside/server.js", dependencies: { express: "^5.0.0" } }));
    writeFileSync(join(root, "api", "openapi.json"), JSON.stringify(ordersSpec));
    expect(detectProject(join(root, "api")).entry).toBeNull();
    expect([insideProject(root, "../x.js"), insideProject(root, "src/app.ts")]).toEqual([false, true]);
    await init({ dir: join(root, "api"), yes: true, write: true, out: () => {} });
    expect(readFileSync(join(root, "outside", "server.js"), "utf8")).not.toContain("agentify");

    const next = temp();
    cpSync(resolve("test/fixtures/draft/next-app"), next, { recursive: true });
    writeFileSync(join(next, "openapi.json"), JSON.stringify(ordersSpec));
    writeFileSync(join(next, "middleware.ts"), "export function middleware() {}\n");
    const lines: string[] = [];
    await init({ dir: next, yes: true, out: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("middleware.ts: tool calls go straight to your route handlers");
  });
});
