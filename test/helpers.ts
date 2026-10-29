import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import type { AgentifyConfig } from "../src/config.js";
import { encodeHeaderValue, META } from "../src/mcp/protocol.js";
import { importOpenApi } from "../src/openapi/convert.js";
import type { Manifest } from "../src/openapi/manifest.js";
import { createExpressApp } from "../examples/orders-api/express/app.js";
import { createFastifyApp } from "../examples/orders-api/fastify/app.js";
import { createHonoApp } from "../examples/orders-api/hono/app.js";
import { createOrders, DEMO_CUSTOMER_KEY, type OrdersDb, serviceKey } from "../examples/orders-api/shared/orders.js";

export const FRAMEWORKS = ["express", "hono", "fastify", "next"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const ordersSpec = JSON.parse(readFileSync(new URL("../examples/orders-api/openapi.json", import.meta.url), "utf8"));
export const CUSTOMER_KEY = DEMO_CUSTOMER_KEY;
export const SERVICE_KEY = serviceKey();

/** The Orders API's tools, with writes on when asked (as a reviewed agentify.tools.json would have them). */
export function ordersManifest(opts: { writes?: boolean } = {}): Manifest {
  const m = importOpenApi(ordersSpec, { now: new Date(0), specSource: "openapi.json" }).manifest;
  if (opts.writes) for (const t of m.tools) t.enabled = true;
  return m;
}

export function config(overrides: Partial<AgentifyConfig> = {}): AgentifyConfig {
  return {
    name: "Orders API",
    description: "Look up, create and refund orders.",
    spec: ordersSpec,
    tools: ordersManifest(),
    logLevel: "silent",
    ...overrides,
  };
}

export interface Running {
  url: string;
  orders: OrdersDb;
  close: () => Promise<void>;
}

const listening = (server: Server) =>
  new Promise<number>((resolve) => {
    if (server.listening) resolve((server.address() as AddressInfo).port);
    else server.once("listening", () => resolve((server.address() as AddressInfo).port));
  });

/** The example Orders API on one framework, with Agentify mounted, on a real port. */
export async function start(fw: Framework, cfg: AgentifyConfig): Promise<Running> {
  if (fw === "express") {
    const orders = createOrders();
    const server = createExpressApp(cfg, orders).listen(0, "127.0.0.1");
    const port = await listening(server);
    return { url: `http://127.0.0.1:${port}`, orders, close: () => new Promise((r) => server.close(() => r())) };
  }
  if (fw === "hono") {
    const orders = createOrders();
    const server = serve({ fetch: createHonoApp(cfg, orders).fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    const port = await listening(server);
    return { url: `http://127.0.0.1:${port}`, orders, close: () => new Promise((r) => server.close(() => r())) };
  }
  if (fw === "fastify") {
    const orders = createOrders();
    const app = await createFastifyApp(cfg, orders);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}`, orders, close: () => app.close() };
  }
  const { useAgentify, orders, nextFetch } = await nextExample();
  useAgentify(cfg);
  orders.audit.length = 0;
  const server = serve({ fetch: nextFetch(), port: 0, hostname: "127.0.0.1" }) as Server;
  const port = await listening(server);
  return { url: `http://127.0.0.1:${port}`, orders, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * The Next.js example is its own TypeScript project (bundler resolution,
 * extensionless imports, typechecked by examples/orders-api/next/tsconfig.json),
 * so it's loaded by path here rather than through this project's imports.
 */
export async function nextExample() {
  const load = (p: string) => import(new URL(`../examples/orders-api/next/${p}`, import.meta.url).href);
  const [agentify, orders, harness] = await Promise.all([load("lib/agentify.ts"), load("lib/orders.ts"), load("harness.ts")]);
  return {
    useAgentify: agentify.useAgentify as (c: AgentifyConfig) => unknown,
    orders: orders.orders as OrdersDb,
    nextFetch: harness.nextFetch as () => (r: Request) => Promise<Response>,
  };
}

let nextId = 1;

/** A 2026-07-28 request: `_meta` in the body, mirrored headers. */
export function modern(method: string, params: Record<string, unknown> = {}, opts: { meta?: Record<string, unknown>; headers?: Record<string, string> } = {}) {
  const body = {
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: { [META.protocolVersion]: "2026-07-28", [META.clientInfo]: { name: "test-client", version: "1.0.0" }, [META.clientCapabilities]: {}, ...opts.meta },
    },
  };
  const name = method === "tools/call" ? params.name : undefined;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(typeof name === "string" ? { "mcp-name": encodeHeaderValue(name) } : {}),
    ...opts.headers,
  };
  return { body, headers };
}

/** A 2025-11-25 request (stateless, after `initialize`). */
export function legacy(method: string, params: Record<string, unknown> = {}, opts: { headers?: Record<string, string> } = {}) {
  return { body: { jsonrpc: "2.0", id: nextId++, method, params }, headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25", ...opts.headers } };
}

export async function rpc(url: string, req: { body: unknown; headers: Record<string, string> }, auth?: Record<string, string>) {
  const res = await fetch(`${url}/mcp`, { method: "POST", headers: { ...req.headers, ...auth }, body: typeof req.body === "string" ? req.body : JSON.stringify(req.body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const apiKey = (key: string) => ({ "x-api-key": key });
