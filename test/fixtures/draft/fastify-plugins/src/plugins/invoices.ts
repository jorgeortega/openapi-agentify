import type { FastifyInstance } from "fastify";

const invoiceSchema = { type: "object", properties: { id: { type: "string" }, amount: { type: "integer", minimum: 0 } } };

export default async function invoices(fastify: FastifyInstance) {
  fastify.get(
    "/invoices",
    {
      schema: {
        summary: "List invoices",
        querystring: { type: "object", properties: { status: { type: "string", enum: ["draft", "open", "paid"] }, limit: { type: "integer" } } },
        response: { 200: { type: "array", items: invoiceSchema } },
      },
    },
    async () => [],
  );
  fastify.route({
    method: ["POST"],
    url: "/invoices",
    schema: { body: { type: "object", required: ["amount"], properties: { amount: { type: "integer" } } }, response: { 201: invoiceSchema } },
    handler: async () => ({}),
  });
  fastify.get("/invoices/:invoiceId", async () => ({}));
}
