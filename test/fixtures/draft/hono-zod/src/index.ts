import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { admin } from "./admin";

const NoteInput = z.object({
  title: z.string().min(1).max(200).describe("The note's title"),
  body: z.string().optional(),
  tags: z.array(z.string()).default([]),
  priority: z.enum(["low", "normal", "high"]).optional(),
});

const api = new Hono().basePath("/api");

api.get("/notes", zValidator("query", z.object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).optional() })), (c) => c.json([]));
api.post("/notes", zValidator("json", NoteInput), (c) => c.json({}, 201));
api.get("/notes/:id", (c) => c.json({}));
api.route("/admin", admin);

const app = new OpenAPIHono();
const getTag = createRoute({
  method: "get",
  path: "/tags/{name}",
  summary: "Get a tag",
  request: { params: z.object({ name: z.string().openapi({ example: "work" }) }) },
  responses: { 200: { description: "The tag", content: { "application/json": { schema: z.object({ name: z.string(), count: z.number().int() }) } } } },
});
app.openapi(getTag, (c) => c.json({ name: "x", count: 1 }));

export default app;
export { api };
