import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CUSTOMER_KEY } from "./helpers.js";

/**
 * The Next.js example under the real `next build` + `next start` (not the
 * test harness). Slow (a production build), so it runs when
 * AGENTIFY_NEXT_E2E=1 and after `npm run build` (the example resolves
 * "openapi-agentify" to dist/).
 */

const RUN = process.env.AGENTIFY_NEXT_E2E === "1";
const dir = resolve("examples/orders-api/next");
const next = resolve("node_modules/.bin/next");

describe.skipIf(!RUN)("Next.js example: real next build and next start", () => {
  let child: ChildProcess;
  let base: string;
  beforeAll(async () => {
    if (!existsSync(resolve("dist/src/index.js"))) throw new Error("npm run build first");
    rmSync(resolve(dir, ".next"), { recursive: true, force: true });
    const build = spawnSync(next, ["build"], { cwd: dir, encoding: "utf8", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
    if (build.status !== 0) throw new Error(`next build failed:\n${build.stdout}\n${build.stderr}`);
    const port = 3400 + Math.floor(Math.random() * 500);
    base = `http://127.0.0.1:${port}`;
    child = spawn(next, ["start", "-p", String(port), "-H", "127.0.0.1"], { cwd: dir, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PUBLIC_URL: base }, stdio: "ignore" });
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("next start didn't answer");
  }, 240_000);
  afterAll(() => {
    child?.kill("SIGTERM");
  });

  it("serves the surfaces from the [...agentify] catch-all", async () => {
    const agent = await (await fetch(`${base}/agent`)).json();
    expect(agent.mcp.url).toBe(`${base}/mcp`);
    expect(await (await fetch(`${base}/llms.txt`)).text()).toMatch(/^# Orders API/);
  });

  it("guards the wrapped route handlers: forged X-Agentify-* headers never reach them, Link headers on /", async () => {
    const r = await fetch(`${base}/v1/orders/ord_1001`, { headers: { "x-api-key": CUSTOMER_KEY, "user-agent": "ClaudeBot/1.0", "x-agentify-agent": "forged", "x-agentify-tool": "forged" } });
    expect(r.status).toBe(200);
    const audit = await (await fetch(`${base}/internal/audit`, { headers: { "x-api-key": CUSTOMER_KEY } })).json();
    expect(audit.find((e: { path: string }) => e.path === "/v1/orders/ord_1001")).toMatchObject({ agent: null, tool: null });
    expect((await fetch(`${base}/`)).headers.get("link")).toContain('rel="llms-txt"');
  });

  it("dispatches an MCP tool call in-process to the route module, through its own auth", async () => {
    const call = (headers: Record<string, string>) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "getSalesReport", arguments: {} } }),
      }).then((r) => r.json());
    const r = await call({ "x-api-key": CUSTOMER_KEY });
    expect(r.result.isError).toBe(false);
    expect(r.result.structuredContent).toMatchObject({ currency: "USD" });
    const denied = await call({});
    expect(denied.result.isError).toBe(true);
  });
});
