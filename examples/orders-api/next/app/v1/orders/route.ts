import { wrap } from "../../../lib/agentify";
import { orders, requireKey } from "../../../lib/orders";

export const GET = wrap(async (req: Request) => {
  const denied = requireKey(req);
  if (denied) return denied;
  const q = new URL(req.url).searchParams;
  return Response.json(orders.list({ status: q.get("status"), limit: q.get("limit"), cursor: q.get("cursor") }));
});

export const POST = wrap(async (req: Request) => {
  const denied = requireKey(req);
  if (denied) return denied;
  const r = orders.create(await req.json().catch(() => null));
  if (!r.ok) return Response.json({ error: "invalid_order", message: r.error }, { status: 400 });
  return Response.json(r.order, { status: 201, headers: { location: `/v1/orders/${r.order.id}` } });
});
