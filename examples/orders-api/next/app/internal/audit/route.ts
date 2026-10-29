import { orders } from "../../../lib/orders";

// What the API's auth middleware saw (for tests and demos; not part of the spec).
export const GET = async (req: Request) =>
  orders.authorize((n) => req.headers.get(n), "GET", "/internal/audit") === "customer" ? Response.json(orders.audit) : new Response(null, { status: 401 });
