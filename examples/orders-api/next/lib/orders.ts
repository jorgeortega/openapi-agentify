import { createOrders, type OrdersDb } from "../../shared/orders";

// One store per process, kept across Next's hot reloads.
const g = globalThis as { __ordersDb?: OrdersDb };
export const orders: OrdersDb = (g.__ordersDb ??= createOrders());

/** The API's own auth. Agentify never replaces it. */
export function requireKey(req: Request): Response | null {
  const caller = orders.authorize((n) => req.headers.get(n), req.method, new URL(req.url).pathname);
  return caller ? null : Response.json({ error: "unauthorized", message: "Send your API key in x-api-key" }, { status: 401 });
}
