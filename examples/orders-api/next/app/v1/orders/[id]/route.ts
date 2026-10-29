import { wrap } from "../../../../lib/agentify";
import { orders, requireKey } from "../../../../lib/orders";

export const GET = wrap(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const denied = requireKey(req);
  if (denied) return denied;
  const { id } = await params;
  const o = orders.get(id);
  return o ? Response.json(o) : Response.json({ error: "not_found", message: `No order ${id}` }, { status: 404 });
});
