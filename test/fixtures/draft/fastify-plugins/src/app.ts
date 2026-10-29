import Fastify from "fastify";
import invoices from "./plugins/invoices";

const app = Fastify({ logger: true });

app.get("/ping", async () => "pong");
await app.register(invoices, { prefix: "/v2" });
await app.register(
  async (instance) => {
    instance.get("/me", async () => ({}));
  },
  { prefix: "/account" },
);

await app.listen({ port: 3000 });
