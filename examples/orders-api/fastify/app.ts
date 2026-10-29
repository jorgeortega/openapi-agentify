import Fastify from "fastify";
import { agentifyFastify } from "../../../src/adapters/fastify.js";
import type { AgentifyConfig } from "../../../src/config.js";
import type { Agentify } from "../../../src/core.js";
import { createOrders, type OrdersDb } from "../shared/orders.js";

/** The Orders API on Fastify 5, with route schemas and an auth hook in a /v1 plugin. */
export async function createFastifyApp(config: AgentifyConfig | Agentify, orders: OrdersDb = createOrders()) {
  const app = Fastify({ logger: false });
  await app.register(agentifyFastify, config as AgentifyConfig); // ← Agentify: the surfaces, and hooks on the routes below

  app.get("/", async () => ({ name: "Orders API", docs: "/llms.txt" }));
  app.get("/health", async () => ({ ok: true }));

  await app.register(
    async (v1) => {
      // The API's own auth. Agentify never replaces it.
      v1.addHook("onRequest", async (req, reply) => {
        const caller = orders.authorize((n) => req.headers[n] as string | undefined, req.method, req.url.split("?")[0]!);
        if (!caller) return reply.code(401).send({ error: "unauthorized", message: "Send your API key in x-api-key" });
      });
      v1.get("/orders", {
        schema: { querystring: { type: "object", properties: { status: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string" } } } },
        handler: async (req) => orders.list(req.query as { status?: string; limit?: number; cursor?: string }),
      });
      v1.post("/orders", {
        schema: {
          body: {
            type: "object",
            required: ["customer", "items"],
            properties: { customer: { type: "string" }, items: { type: "array", items: { type: "object", properties: { sku: { type: "string" }, qty: { type: "integer" } } } } },
          },
        },
        handler: async (req, reply) => {
          const r = orders.create(req.body);
          if (!r.ok) return reply.code(400).send({ error: "invalid_order", message: r.error });
          return reply.code(201).header("location", `/v1/orders/${r.order.id}`).send(r.order);
        },
      });
      v1.get("/orders/:id", async (req, reply) => {
        const { id } = req.params as { id: string };
        const o = orders.get(id);
        return o ?? reply.code(404).send({ error: "not_found", message: `No order ${id}` });
      });
      v1.post("/orders/:id/refund", async (req, reply) => {
        const { id } = req.params as { id: string };
        const r = orders.refund(id, req.body ?? null);
        if (!r.ok) return reply.code(r.status).send({ error: r.status === 404 ? "not_found" : "conflict", message: r.error });
        return r.order;
      });
      v1.get("/reports/sales", async () => orders.salesReport());
    },
    { prefix: "/v1" },
  );

  app.get("/internal/audit", async (req, reply) =>
    orders.authorize((n) => req.headers[n] as string | undefined, "GET", "/internal/audit") === "customer" ? orders.audit : reply.code(401).send(),
  );
  await app.ready();
  return app;
}
