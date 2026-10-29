import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { Schema } from "./schemas";

export const admin = new Hono();
admin.delete("/notes/:id", (c) => c.body(null, 204));
admin.post("/import", zValidator("json", Schema), (c) => c.json({}));
