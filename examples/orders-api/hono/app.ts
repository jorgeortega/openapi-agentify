import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { agentify } from "../../../src/adapters/hono.js";
import type { AgentifyConfig } from "../../../src/config.js";
import type { Agentify } from "../../../src/core.js";
import { createOrders, type OrdersDb } from "../shared/orders.js";

/** The Orders API on Hono 4, with cors, secure headers and a sub-app mounted at /v1. */
export function createHonoApp(config: AgentifyConfig | Agentify, orders: OrdersDb = createOrders()) {
  const app = new Hono();
  app.use(secureHeaders());
  app.use(cors());
  app.use(agentify(config, { app })); // ← Agentify: the surfaces, and the guard on the routes below

  app.get("/", (c) => c.json({ name: "Orders API", docs: "/llms.txt" }));
  app.get("/health", (c) => c.json({ ok: true }));

  const v1 = new Hono();
  // The API's own auth. Agentify never replaces it.
  v1.use(async (c, next) => {
    const caller = orders.authorize((n) => c.req.header(n), c.req.method, new URL(c.req.url).pathname);
    if (!caller) return c.json({ error: "unauthorized", message: "Send your API key in x-api-key" }, 401);
    await next();
  });
  v1.get("/orders", (c) => c.json(orders.list({ status: c.req.query("status"), limit: c.req.query("limit"), cursor: c.req.query("cursor") })));
  v1.post("/orders", async (c) => {
    const r = orders.create(await c.req.json().catch(() => null));
    if (!r.ok) return c.json({ error: "invalid_order", message: r.error }, 400);
    c.header("location", `/v1/orders/${r.order.id}`);
    return c.json(r.order, 201);
  });
  v1.get("/orders/:id", (c) => {
    const o = orders.get(c.req.param("id"));
    return o ? c.json(o) : c.json({ error: "not_found", message: `No order ${c.req.param("id")}` }, 404);
  });
  v1.post("/orders/:id/refund", async (c) => {
    const r = orders.refund(c.req.param("id"), await c.req.json().catch(() => null));
    if (!r.ok) return c.json({ error: r.status === 404 ? "not_found" : "conflict", message: r.error }, r.status as 404 | 409);
    return c.json(r.order);
  });
  v1.get("/reports/sales", (c) => c.json(orders.salesReport()));
  app.route("/v1", v1);

  app.get("/internal/audit", (c) => (orders.authorize((n) => c.req.header(n), "GET", "/internal/audit") === "customer" ? c.json(orders.audit) : c.body(null, 401)));
  return app;
}
