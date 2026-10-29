import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import type { Agentify, AgentifyConfig } from "openapi-agentify";
import { agentify } from "openapi-agentify/express";
import { createOrders, type OrdersDb } from "../shared/orders.js";

/** The Orders API on Express 5, with the usual middleware (helmet, cors, a JSON body parser, a router). */
export function createExpressApp(config: AgentifyConfig | Agentify, orders: OrdersDb = createOrders()) {
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(agentify(config)); // ← Agentify: the surfaces, and the guard on the routes below
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.json({ name: "Orders API", docs: "/llms.txt" });
  });
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const v1 = express.Router();
  // The API's own auth. Agentify never replaces it.
  v1.use((req: Request, res: Response, next: NextFunction) => {
    const caller = orders.authorize((n) => req.get(n), req.method, req.originalUrl.split("?")[0]!);
    if (!caller) {
      res.status(401).json({ error: "unauthorized", message: "Send your API key in x-api-key" });
      return;
    }
    next();
  });
  v1.get("/orders", (req, res) => {
    res.json(orders.list({ status: req.query.status as string, limit: req.query.limit as string, cursor: req.query.cursor as string }));
  });
  v1.post("/orders", (req, res) => {
    const r = orders.create(req.body);
    if (!r.ok) {
      res.status(400).json({ error: "invalid_order", message: r.error });
      return;
    }
    res.status(201).location(`/v1/orders/${r.order.id}`).json(r.order);
  });
  v1.get("/orders/:id", (req, res) => {
    const o = orders.get(req.params.id!);
    if (!o) {
      res.status(404).json({ error: "not_found", message: `No order ${req.params.id}` });
      return;
    }
    res.json(o);
  });
  v1.post("/orders/:id/refund", (req, res) => {
    const r = orders.refund(req.params.id!, req.body);
    if (!r.ok) {
      res.status(r.status).json({ error: r.status === 404 ? "not_found" : "conflict", message: r.error });
      return;
    }
    res.json(r.order);
  });
  v1.get("/reports/sales", (_req, res) => {
    res.json(orders.salesReport());
  });
  app.use("/v1", v1);

  // What the API's auth middleware saw (for tests and demos; not part of the spec).
  app.get("/internal/audit", (req, res) => {
    if (orders.authorize((n) => req.get(n), req.method, "/internal/audit") !== "customer") {
      res.status(401).end();
      return;
    }
    res.json(orders.audit);
  });
  return app;
}
