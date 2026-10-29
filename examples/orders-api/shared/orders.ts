/**
 * The Orders API's data and rules, shared by the four framework versions
 * (Express, Hono, Fastify, Next.js) so they behave the same. In memory: a demo.
 *
 * Auth is the API's own, not Agentify's: every /v1 route needs an API key in
 * `x-api-key`. There are two:
 *   - a customer's key (DEMO_CUSTOMER_KEY), what a person, their script or
 *     their agent sends (Agentify forwards it on tool calls: passthrough);
 *   - a service key (ORDERS_SERVICE_KEY), what a hook could send on behalf of
 *     agents it authenticates itself (see docs/extending.md).
 */

export interface OrderItem {
  sku: string;
  qty: number;
  priceCents: number;
}

export interface Order {
  id: string;
  customer: string;
  items: OrderItem[];
  totalCents: number;
  status: "open" | "paid" | "refunded";
  createdAt: string;
  refundReason?: string;
}

export const DEMO_CUSTOMER_KEY = "demo-customer-key-0001";
export const serviceKey = () => process.env.ORDERS_SERVICE_KEY ?? "orders-service-key-0001";

const CATALOG: Record<string, number> = { "tea-green": 1200, "tea-black": 1100, "mug-blue": 1800, "kettle-steel": 4500 };

/** What the API's own auth middleware saw, per request (tests and demos read it). */
export interface AuditEntry {
  caller: "customer" | "service";
  method: string;
  path: string;
  tool: string | null;
  agent: string | null;
  payer: string | null;
}

export function createOrders() {
  const orders = new Map<string, Order>();
  const audit: AuditEntry[] = [];
  let next = 1001;
  const add = (customer: string, items: Array<{ sku: string; qty: number }>, status: Order["status"], day: number) => {
    const lines = items.map((i) => ({ ...i, priceCents: CATALOG[i.sku] ?? 1000 }));
    const o: Order = {
      id: `ord_${next++}`,
      customer,
      items: lines,
      totalCents: lines.reduce((s, l) => s + l.qty * l.priceCents, 0),
      status,
      createdAt: new Date(Date.UTC(2026, 8, day, 10)).toISOString(),
    };
    orders.set(o.id, o);
  };
  const customers = ["ada@example.com", "grace@example.com", "alan@example.com", "edsger@example.com"];
  for (let i = 0; i < 12; i++) add(customers[i % 4]!, [{ sku: Object.keys(CATALOG)[i % 4]!, qty: 1 + (i % 3) }], i % 5 === 0 ? "refunded" : i % 2 ? "paid" : "open", 1 + i);

  return {
    audit,

    /** The API's own auth: returns who is calling, or null (→ 401). */
    authorize(header: (name: string) => string | null | undefined, method: string, path: string): AuditEntry["caller"] | null {
      const key = header("x-api-key");
      const caller = key === DEMO_CUSTOMER_KEY ? "customer" : key && key === serviceKey() ? "service" : null;
      if (caller) audit.push({ caller, method, path, tool: header("x-agentify-tool") ?? null, agent: header("x-agentify-agent") ?? null, payer: header("x-agentify-payer") ?? null });
      return caller;
    },

    list(q: { status?: string | null; limit?: string | number | null; cursor?: string | null }) {
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
      let all = [...orders.values()];
      if (q.status) all = all.filter((o) => o.status === q.status);
      const start = q.cursor ? all.findIndex((o) => o.id === q.cursor) + 1 : 0;
      const page = all.slice(start, start + limit);
      return { orders: page, nextCursor: start + limit < all.length ? page.at(-1)!.id : null };
    },

    get(id: string) {
      return orders.get(id) ?? null;
    },

    create(body: unknown): { ok: true; order: Order } | { ok: false; error: string } {
      const b = body as { customer?: unknown; items?: unknown };
      if (!b || typeof b.customer !== "string" || !b.customer.includes("@")) return { ok: false, error: "customer must be an email address" };
      if (!Array.isArray(b.items) || b.items.length === 0) return { ok: false, error: "items must be a non-empty array" };
      for (const i of b.items as Array<{ sku?: unknown; qty?: unknown }>) {
        if (typeof i?.sku !== "string" || !(i.sku in CATALOG)) return { ok: false, error: `unknown sku ${String(i?.sku)}` };
        if (!Number.isInteger(i.qty) || (i.qty as number) < 1) return { ok: false, error: "qty must be a positive integer" };
      }
      add(b.customer, b.items as Array<{ sku: string; qty: number }>, "open", 29);
      return { ok: true, order: [...orders.values()].at(-1)! };
    },

    refund(id: string, body: unknown): { ok: true; order: Order } | { ok: false; status: number; error: string } {
      const o = orders.get(id);
      if (!o) return { ok: false, status: 404, error: `No order ${id}` };
      if (o.status === "refunded") return { ok: false, status: 409, error: `${id} is already refunded` };
      o.status = "refunded";
      const reason = (body as { reason?: unknown } | null)?.reason;
      if (typeof reason === "string") o.refundReason = reason.slice(0, 200);
      return { ok: true, order: o };
    },

    salesReport() {
      const paid = [...orders.values()].filter((o) => o.status === "paid");
      return { currency: "USD", orders: paid.length, totalCents: paid.reduce((s, o) => s + o.totalCents, 0), bySku: Object.fromEntries(Object.keys(CATALOG).map((sku) => [sku, paid.filter((o) => o.items.some((i) => i.sku === sku)).length])) };
    },
  };
}

export type OrdersDb = ReturnType<typeof createOrders>;
