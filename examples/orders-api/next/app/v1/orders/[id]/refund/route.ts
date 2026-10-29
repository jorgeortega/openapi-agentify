import { wrap } from "../../../../../lib/agentify";
import { orders, requireKey } from "../../../../../lib/orders";

export const POST = wrap(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const denied = requireKey(req);
  if (denied) return denied;
  const { id } = await params;
  const r = orders.refund(id, await req.json().catch(() => null));
  if (!r.ok) return Response.json({ error: r.status === 404 ? "not_found" : "conflict", message: r.error }, { status: r.status });
  return Response.json(r.order);
});
