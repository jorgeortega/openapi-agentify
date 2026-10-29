import { Hono } from "hono";

const app = new Hono();
app.get("/v1/widgets", (c) => c.json([]));

export default app;
