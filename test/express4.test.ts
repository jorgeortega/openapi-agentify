import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
// Express 4, installed under an alias next to Express 5.
// @ts-expect-error express4 has no bundled types; its API is the one used here
import express4 from "express4";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentify } from "../src/adapters/express.js";
import { importOpenApi } from "../src/openapi/convert.js";
import type { AgentifyHooks } from "../src/hooks.js";
import { config, legacy, rpc } from "./helpers.js";

/**
 * Express 4: body-parser 1.x, the older router. The spec is read from the
 * app itself ("app:/docs/json"), in-process.
 */

const spec = {
  openapi: "3.1.0",
  info: { title: "Legacy", version: "4.0.0" },
  paths: {
    "/api/things/{id}": { get: { operationId: "getThing", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK" } } } },
    "/api/things": {
      post: { operationId: "createThing", requestBody: { content: { "application/json": { schema: { type: "object" } } } }, responses: { 201: { description: "OK" } } },
    },
    "/api/premium": { get: { operationId: "premium", responses: { 200: { description: "OK" } } } },
  },
};

describe("Express 4", () => {
  let url: string;
  let server: Server;
  let created = 0;
  // A hook that answers for one operation until a header is sent, then holds the
  // response and adds a header once it has seen it (how a payment hook settles).
  const hooks: AgentifyHooks = {
    guardRoute: (request, info) => {
      if (info.operation?.name !== "premium") return;
      if (!request.headers.get("x-ticket")) return { respond: Response.json({ error: "ticket_required" }, { status: 402 }) };
      return { removeHeaders: ["x-ticket"], buffer: true, finish: async (res) => ({ headers: { "x-receipt": `seen ${res.status} ${res.body?.byteLength}` } }) };
    },
  };
  beforeAll(async () => {
    const app = express4();
    const manifest = importOpenApi(spec, { includeWrites: true }).manifest;
    app.use(agentify(config({ name: "Legacy", spec: "app:/docs/json", tools: manifest, hooks, detect: { userAgents: ["TestAgent"] } })));
    app.use(express4.json());
    app.get("/docs/json", (_req: any, res: any) => res.json(spec));
    const router = express4.Router();
    router.get("/things/:id", (req: any, res: any) => res.json({ id: req.params.id }));
    router.post("/things", (req: any, res: any) => res.status(201).json({ n: ++created, body: req.body }));
    router.get("/premium", (req: any, res: any) => res.json({ secret: 42, ticket: req.get("x-ticket") ?? null }));
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("reads the spec from the app, in-process, and serves it", async () => {
    const r = await (await fetch(`${url}/openapi.json`)).json();
    expect(r.info.title).toBe("Legacy");
  });

  it("dispatches GET and POST tool calls through the router and body-parser 1.x", async () => {
    const g = await rpc(url, legacy("tools/call", { name: "getThing", arguments: { id: "a b" } }));
    expect(g.json.result.structuredContent).toEqual({ id: "a b" });
    const p = await rpc(url, legacy("tools/call", { name: "createThing", arguments: { body: { x: 1 } } }));
    expect(p.json.result.structuredContent).toMatchObject({ body: { x: 1 } });
  });

  it("idempotent agent writes: the body is read once and still parsed (the _body flag)", async () => {
    const post = () =>
      fetch(`${url}/api/things`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "TestAgent/1", "idempotency-key": "i-4", "x-api-key": "k" }, body: JSON.stringify({ y: 2 }) });
    const a = await (await post()).json();
    const b = await (await post()).json();
    expect(a).toEqual({ n: a.n, body: { y: 2 } });
    expect(b.n).toBe(a.n);
  });

  it("a guardRoute hook on a route: answers first, then holds the response and adds to it", async () => {
    const c = await fetch(`${url}/api/premium`);
    expect(c.status).toBe(402);
    const ok = await fetch(`${url}/api/premium`, { headers: { "x-ticket": "t-1" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ secret: 42, ticket: null });
    expect(ok.headers.get("x-receipt")).toBe("seen 200 27");
  });
});
