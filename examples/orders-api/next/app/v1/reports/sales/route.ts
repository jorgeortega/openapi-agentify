import { wrap } from "../../../../lib/agentify";
import { orders, requireKey } from "../../../../lib/orders";

export const GET = wrap(async (req: Request) => {
  const denied = requireKey(req);
  if (denied) return denied;
  return Response.json(orders.salesReport());
});
