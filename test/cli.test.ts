import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptAll, improve } from "../src/check/improve.js";
import { formatReport, readiness } from "../src/check/rules.js";
import { main, parseArgs } from "../src/cli/main.js";
import { findSpec, init, wireEntry } from "../src/cli/init.js";
import { detectProject } from "../src/cli/project.js";
import { draftSpec, guessOperationId, toOpenApiPath } from "../src/draft/draft.js";
import { importOpenApi } from "../src/openapi/convert.js";
import { operationTool } from "../src/mcp/operation-tool.js";
import { readManifest } from "../src/openapi/manifest.js";
import { ordersSpec } from "./helpers.js";

const FIX = resolve("test/fixtures");
const EX = resolve("examples/orders-api");

function temp(copyFrom?: string) {
  const dir = mkdtempSync(join(tmpdir(), "agentify-cli-"));
  if (copyFrom) cpSync(copyFrom, dir, { recursive: true });
  return dir;
}

async function run(args: string[]) {
  const lines: string[] = [];
  const code = await main(args, (l) => lines.push(l));
  return { code, text: lines.join("\n") };
}

describe("framework detection", () => {
  it("knows each example's framework and entry", () => {
    expect(detectProject(join(EX, "express"))).toMatchObject({ framework: "express", frameworkMajor: 5, entry: "app.ts" });
    expect(detectProject(join(EX, "hono"))).toMatchObject({ framework: "hono", entry: "app.ts" });
    expect(detectProject(join(EX, "fastify"))).toMatchObject({ framework: "fastify", entry: "app.ts" });
    expect(detectProject(join(EX, "next"))).toMatchObject({ framework: "next", appDir: "app", entry: null });
  });

  it("reads the version and finds the file that creates the app", () => {
    expect(detectProject(join(FIX, "draft/express-routers"))).toMatchObject({ framework: "express", frameworkMajor: 4, entry: "src/server.js" });
    expect(detectProject(join(FIX, "draft/next-app"))).toMatchObject({ framework: "next", appDir: "src/app" });
  });

  it("finds the API in a monorepo's workspaces", () => {
    const p = detectProject(join(FIX, "draft/monorepo"));
    expect(p.framework).toBeNull();
    expect(p.workspaces).toEqual([{ dir: "packages/api", name: "@acme/api", framework: "hono" }]);
  });

  it("lets --framework choose", () => {
    expect(detectProject(join(FIX, "draft/hono-zod"), "express").framework).toBe("express");
  });
});

describe("spec discovery", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    const app = new Hono();
    app.get("/docs/json", (c) => c.json(ordersSpec));
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    await new Promise<void>((r) => server.once("listening", () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("finds a spec file up to two folders up", async () => {
    const found = await findSpec(join(EX, "express"), {});
    expect(found?.file).toBe(join(EX, "openapi.json"));
  });

  it("probes a running app's usual spec paths", async () => {
    const found = await findSpec(temp(), { url });
    expect(found?.source).toBe(`${url}/docs/json`);
    expect(found?.doc.info.title).toBe("Orders API");
  });

  it("takes an explicit file or URL", async () => {
    expect((await findSpec(temp(), { spec: join(EX, "openapi.json") }))?.doc.openapi).toBe("3.1.0");
    expect((await findSpec(temp(), { spec: `${url}/docs/json` }))?.source).toBe(`${url}/docs/json`);
  });
});

describe("agentify draft (static: your code is never run)", () => {
  const paths = (dir: string, fw: "express" | "hono" | "fastify" | "next") => {
    const p = detectProject(join(FIX, dir), fw);
    return draftSpec(join(FIX, dir), { framework: fw, appDir: p.appDir });
  };

  it("Express: routers from other files, mount prefixes, route() chains", () => {
    const r = paths("draft/express-routers", "express");
    expect(Object.keys(r.spec.paths).sort()).toEqual(["/api/v1/carts/{cartId}", "/api/v1/orders", "/api/v1/orders/{orderId}", "/api/v1/orders/{orderId}/cancel", "/api/v1/users", "/api/v1/users/{userId}", "/health"]);
    expect(Object.keys(r.spec.paths["/api/v1/carts/{cartId}"])).toEqual(["delete", "get", "put"]);
    expect(r.spec.paths["/api/v1/users/{userId}"].get.parameters).toEqual([{ name: "userId", in: "path", required: true, schema: { type: "string" } }]);
    expect(r.spec.paths["/api/v1/users"].post.requestBody.content["application/json"].schema["x-agentify-todo"]).toBeDefined();
  });

  it("Hono: basePath, route() mounts, zValidator schemas from zod", () => {
    const r = paths("draft/hono-zod", "hono");
    expect(r.spec.paths["/api/notes"].post.requestBody.content["application/json"].schema).toEqual({
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200, description: "The note's title" },
        body: { type: "string" },
        tags: { type: "array", items: { type: "string" }, default: [] },
        priority: { type: "string", enum: ["low", "normal", "high"] },
      },
      required: ["title"],
    });
    expect(r.spec.paths["/api/notes"].get.parameters.map((p: { name: string }) => p.name)).toEqual(["q", "limit"]);
    expect(r.spec.paths["/api/notes"].get.parameters[1].schema).toEqual({ type: "integer", minimum: 1, maximum: 50 });
    expect(r.spec.paths["/api/admin/notes/{id}"].delete).toBeDefined();
    // A schema from a file it can't see is left to fill in.
    expect(r.spec.paths["/api/admin/import"].post.requestBody.content["application/json"].schema["x-agentify-todo"]).toMatch(/another file/);
  });

  it("Hono: @hono/zod-openapi createRoute (summary, params, response schema)", () => {
    const r = paths("draft/hono-zod", "hono");
    expect(r.spec.paths["/tags/{name}"].get).toMatchObject({
      summary: "Get a tag",
      parameters: [{ name: "name", in: "path", schema: { type: "string", examples: ["work"] } }],
      responses: { 200: { description: "The tag", content: { "application/json": { schema: { type: "object", required: ["name", "count"] } } } } },
    });
  });

  it("Fastify: register() prefixes, inline plugins, route schemas become real schemas", () => {
    const r = paths("draft/fastify-plugins", "fastify");
    expect(Object.keys(r.spec.paths).sort()).toEqual(["/account/me", "/ping", "/v2/invoices", "/v2/invoices/{invoiceId}"]);
    const list = r.spec.paths["/v2/invoices"].get;
    expect(list.summary).toBe("List invoices");
    expect(list.parameters[0]).toEqual({ name: "status", in: "query", required: false, schema: { type: "string", enum: ["draft", "open", "paid"] } });
    expect(list.responses["200"].content["application/json"].schema.type).toBe("array");
    expect(r.spec.paths["/v2/invoices"].post.requestBody.content["application/json"].schema.required).toEqual(["amount"]);
  });

  it("Next.js: [id] → {id}, route groups dropped, catch-alls flagged, private folders skipped, aliased exports", () => {
    const r = paths("draft/next-app", "next");
    expect(Object.keys(r.spec.paths).sort()).toEqual(["/api/files/{path}", "/api/products/{id}"]);
    expect(Object.keys(r.spec.paths["/api/products/{id}"])).toEqual(["delete", "get"]);
    expect(Object.keys(r.spec.paths["/api/files/{path}"])).toEqual(["get", "put"]);
    expect(r.guesses.join("\n")).toMatch(/catch-all segment \[\.\.\.path\]/);
  });

  it("marks what it guessed and where it came from", () => {
    const r = paths("draft/express-routers", "express");
    const op = r.spec.paths["/api/v1/orders/{orderId}/cancel"].post;
    expect(op).toMatchObject({ operationId: "cancelOrder", "x-agentify-guess": ["operationId", "requestBody", "responses"], "x-agentify-source": "src/routes/orders.js:5" });
  });

  it("drafts the example Orders API the same way on all four frameworks", () => {
    const shape = (fw: "express" | "hono" | "fastify" | "next") => {
      const r = draftSpec(join(EX, fw), { framework: fw });
      return Object.entries(r.spec.paths)
        .filter(([p]) => p.startsWith("/v1"))
        .map(([p, v]) => `${Object.keys(v as object).join(",")} ${p}`);
    };
    const express = shape("express");
    expect(express).toEqual(["get,post /v1/orders", "get /v1/orders/{id}", "post /v1/orders/{id}/refund", "get /v1/reports/sales"]);
    for (const fw of ["hono", "fastify", "next"] as const) expect(shape(fw)).toEqual(express);
  });

  it("guesses operationIds and converts paths", () => {
    expect(guessOperationId("GET", "/v1/orders")).toBe("listOrders");
    expect(guessOperationId("GET", "/v1/orders/{id}")).toBe("getOrder");
    expect(guessOperationId("POST", "/v1/orders")).toBe("createOrder");
    expect(guessOperationId("POST", "/v1/orders/{id}/refund")).toBe("refundOrder");
    expect(guessOperationId("DELETE", "/users/{userId}/keys/{keyId}")).toBe("deleteUserKey");
    expect(toOpenApiPath("/a/:id/b/:name?")).toMatchObject({ path: "/a/{id}/b/{name}", params: ["id", "name"], guess: expect.stringContaining("optional") });
  });

  it("the CLI writes openapi.draft.json", async () => {
    const dir = temp(join(FIX, "draft/fastify-plugins"));
    const r = await run(["draft", dir]);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/Drafted .*openapi.draft.json: 4 paths/);
    expect(JSON.parse(readFileSync(join(dir, "openapi.draft.json"), "utf8")).openapi).toBe("3.1.0");
  });
});

describe("agentify check: the readiness rules", () => {
  const op = (o: Record<string, unknown> = {}) => ({
    operationId: "listWidgets",
    summary: "List widgets",
    description: "Lists every widget you own, newest first, with their prices.",
    parameters: [{ name: "limit", in: "query", description: "How many to return.", schema: { type: "integer" }, example: 10 }],
    responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { type: "object" } } } } }, 400: { description: "Bad" } },
    ...o,
  });
  const spec = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    openapi: "3.1.0",
    info: { title: "W", version: "1" },
    components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "x-key" } } },
    security: [{ key: [] }],
    paths,
    ...extra,
  });
  const failing = (s: Record<string, unknown>) =>
    readiness(s)
      .rules.filter((r) => r.share < 1)
      .map((r) => r.id);

  it("a good spec scores 100", () => {
    const r = readiness(spec({ "/widgets": { get: op() } }));
    expect(r.score).toBe(100);
    expect(failing(spec({ "/widgets": { get: op() } }))).toEqual([]);
  });

  it("each rule, one at a time", () => {
    expect(failing(spec({ "/widgets": { get: op({ operationId: "get2" }) } }))).toEqual(["operation-ids"]);
    expect(failing(spec({ "/widgets": { get: op({ operationId: undefined }) } }))).toEqual(["operation-ids"]);
    expect(failing(spec({ "/widgets": { get: op({ summary: undefined }) } }))).toEqual(["summaries"]);
    expect(failing(spec({ "/widgets": { get: op({ description: "Lists." }) } }))).toEqual(["descriptions"]);
    expect(failing(spec({ "/widgets": { get: op() }, "/gadgets": { get: op({ operationId: "listGadgets" }) } }))).toEqual(["descriptions"]);
    expect(failing(spec({ "/widgets": { get: op({ parameters: [{ name: "limit", in: "query", schema: { type: "integer" }, example: 1 }] }) } }))).toEqual(["parameter-descriptions"]);
    expect(failing(spec({ "/widgets": { get: op({ parameters: [...op().parameters, { name: "status", in: "query", description: "Filter by status.", schema: { type: "string" } }] }) } }))).toEqual(["enums"]);
    expect(failing(spec({ "/widgets": { get: op({ parameters: [{ name: "limit", in: "query", description: "How many.", schema: { type: "integer" } }] }) } }))).toEqual(["examples"]);
    expect(failing(spec({ "/widgets": { get: op(), post: op({ operationId: "createWidget", description: "Creates a widget from the fields in the body and returns it.", requestBody: { content: { "multipart/form-data": {} } }, parameters: [{ name: "Idempotency-Key", in: "header", description: "Key.", schema: { type: "string" }, example: "k" }] }) } }))).toEqual(["json-bodies"]);
    expect(failing(spec({ "/widgets": { get: op({ responses: { 200: { description: "OK" }, 400: { description: "Bad" } } }) } }))).toEqual(["response-schemas", "pagination"].filter((x) => x !== "pagination"));
    expect(failing(spec({ "/widgets": { get: op({ responses: { 200: op().responses[200] } }) } }))).toEqual(["error-responses"]);
    expect(failing(spec({ "/widgets": { get: op({ parameters: [{ name: "q", in: "query", description: "Text.", schema: { type: "string" }, example: "x" }] }) } }))).toEqual(["pagination"]);
    expect(failing(spec({ "/widgets": { get: op() } }, { security: undefined }))).toEqual(["security"]);
    expect(failing(spec({ "/widgets": { get: op(), post: op({ operationId: "createWidget", description: "Creates a widget from the fields in the body and returns it.", requestBody: { content: { "application/json": { schema: { type: "object" } } } } }) } }))).toEqual(["idempotency"]);
  });

  it("flags more than 40 tools", () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 41; i++) many[`/w${i}`] = { get: op({ operationId: `listW${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, description: `Lists widgets of kind ${i} with everything you need to know.`, responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object" } } } }, 400: { description: "Bad" } } }) };
    expect(failing(spec(many))).toContain("tool-count");
  });

  it("scores by weighted share: one bad operation in many costs little", () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) paths[`/w${i}`] = { get: op({ operationId: `listThing${String.fromCharCode(97 + i)}`, description: `Lists things of kind ${i}, newest first, with prices.` }) };
    (paths["/w0"] as { get: Record<string, unknown> }).get.summary = undefined;
    const r = readiness(spec(paths));
    const total = r.rules.reduce((s, x) => s + x.weight, 0);
    expect(r.score).toBe(Math.round(((total - 8 * 0.1) / total) * 100));
  });

  it("the Orders example scores 54, and 96 with improve's suggestions accepted", async () => {
    const before = readiness(ordersSpec);
    expect(before.score).toBe(54);
    const m = importOpenApi(ordersSpec).manifest;
    const r = await improve(ordersSpec, m, { accept: true });
    expect(readiness(ordersSpec, { manifest: r.manifest }).score).toBe(96);
    expect(formatReport(before)).toMatch(/^Agent readiness: 54\/100 \(5 operations\)/);
  });

  it("warns when passthrough's baseUrl isn't the spec's server", () => {
    const r = readiness(ordersSpec, { authMode: "passthrough", baseUrl: "https://api.acme.com" });
    expect(r.warnings[0]).toMatch(/passthrough: the spec's server http:\/\/localhost:3000 is not baseUrl/);
  });

  it("--json and --fail-under for CI", async () => {
    const low = await run(["check", join(EX, "openapi.json"), "--fail-under", "80"]);
    expect(low.code).toBe(1);
    expect(low.text).toMatch(/Score 54 is under --fail-under 80/);
    const json = await run(["check", join(EX, "openapi.json"), "--json"]);
    expect(JSON.parse(json.text)).toMatchObject({ score: 54, operations: 5 });
  });
});

describe("agentify improve", () => {
  it("writes suggestions to agentify.tools.json, never to the spec, and serves nothing until accepted", async () => {
    const dir = temp();
    writeFileSync(join(dir, "openapi.json"), JSON.stringify(ordersSpec));
    const before = readFileSync(join(dir, "openapi.json"), "utf8");
    const r = await run(["improve", join(dir, "openapi.json"), "--tools", join(dir, "agentify.tools.json")]);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/Readiness: 54 now → 96 with these accepted/);
    expect(readFileSync(join(dir, "openapi.json"), "utf8")).toBe(before);
    const m = readManifest(join(dir, "agentify.tools.json"))!;
    expect(m.tools.find((t) => t.name === "get2")!.suggestions).toMatchObject({ source: "rules", accepted: false, operationId: "getOrder" });
    const accepted = await run(["improve", join(dir, "openapi.json"), "--tools", join(dir, "agentify.tools.json"), "--accept"]);
    expect(accepted.text).toMatch(/Accepted the suggestions/);
    const m2 = readManifest(join(dir, "agentify.tools.json"))!;
    expect(m2.tools.map((t) => t.name)).toEqual(["listOrders", "createOrder", "getOrder", "refundOrder", "getSalesReport"]);
  });

  it("is deterministic: rules only, the same spec gets the same suggestions", async () => {
    const tools = () => importOpenApi(ordersSpec, { now: new Date(0) }).manifest;
    const a = await improve(ordersSpec, tools());
    const b = await improve(ordersSpec, tools());
    expect(a).toEqual(b);
    expect(a.changed.every((c) => c.source === "rules")).toBe(true);
  });

  it("suggests allowed values from the response schema, and ids that look like ids", async () => {
    const r = await improve(ordersSpec, importOpenApi(ordersSpec).manifest);
    const list = r.manifest.tools.find((t) => t.name === "listOrders")!.suggestions!;
    expect(list.params!.status).toBe("Only orders with this status. One of: open, paid, refunded.");
    expect(r.manifest.tools.find((t) => t.name === "get2")!.suggestions!.examples![0]!.arguments).toEqual({ id: "order_123" });
  });

  it("accepted parameter descriptions reach tools/list", async () => {
    const r = await improve(ordersSpec, importOpenApi(ordersSpec).manifest, { accept: true });
    const tool = operationTool(r.manifest.tools.find((t) => t.name === "listOrders")!, 1_000_000);
    expect(tool.inputSchema.properties!.status).toEqual({ type: "string", description: "Only orders with this status. One of: open, paid, refunded." });
    const unaccepted = await improve(ordersSpec, importOpenApi(ordersSpec).manifest);
    expect(operationTool(unaccepted.manifest.tools.find((t) => t.name === "listOrders")!, 1_000_000).inputSchema.properties!.status).toEqual({ type: "string" });
  });

  it("acceptAll keeps a tool name you chose", () => {
    const m = importOpenApi(ordersSpec).manifest;
    m.tools.find((t) => t.name === "get2")!.name = "fetch_order";
    m.tools.find((t) => t.name === "fetch_order")!.suggestions = { source: "rules", accepted: false, operationId: "getOrder" };
    expect(acceptAll(m).tools.find((t) => t.operation === "GET /v1/orders/{id}")!.name).toBe("fetch_order");
  });
});

describe("agentify sync", () => {
  it("updates schemas from the spec and keeps your edits", async () => {
    const dir = temp();
    const specPath = join(dir, "openapi.json");
    writeFileSync(specPath, JSON.stringify(ordersSpec));
    const toolsPath = join(dir, "agentify.tools.json");
    await run(["sync", specPath, "--tools", toolsPath]);
    const m = readManifest(toolsPath)!;
    const list = m.tools.find((t) => t.name === "listOrders")!;
    list.description = "My own words.";
    list.price = "0.05";
    m.tools.find((t) => t.name === "refundOrder")!.enabled = true;
    writeFileSync(toolsPath, JSON.stringify(m));
    const next = structuredClone(ordersSpec);
    delete next.paths["/v1/reports/sales"];
    next.paths["/v1/customers"] = { get: { operationId: "listCustomers", responses: { 200: { description: "OK" } } }, post: { operationId: "createCustomer", responses: { 201: { description: "OK" } } } };
    next.paths["/v1/orders"].get.parameters.push({ name: "customer", in: "query", schema: { type: "string" } });
    next.paths["/v1/orders/{id}"].get["x-agentify"] = { price: "$0.02" };
    writeFileSync(specPath, JSON.stringify(next));
    const r = await run(["sync", specPath, "--tools", toolsPath]);
    expect(r.text).toMatch(/4 kept \(with your edits\), 2 added \(listCustomers, createCustomer; writes start disabled\), 1 removed \(getSalesReport\)/);
    const after = readManifest(toolsPath)!;
    const l2 = after.tools.find((t) => t.name === "listOrders")!;
    expect(l2).toMatchObject({ description: "My own words.", price: "0.05" });
    expect(Object.keys(l2.inputSchema.properties as object)).toContain("customer");
    expect(after.tools.find((t) => t.name === "refundOrder")!.enabled).toBe(true);
    expect(after.tools.find((t) => t.name === "createCustomer")!.enabled).toBe(false);
    // A price added to the spec comes in where the tool had none.
    expect(after.tools.find((t) => t.name === "get2")!.price).toBe("0.02");
  });
});

describe("agentify init", () => {
  it("on the Express example: finds the spec one folder up, scores it, writes the files", async () => {
    const dir = temp(EX);
    const lines: string[] = [];
    const r = await init({ dir: join(dir, "express"), yes: true, out: (l) => lines.push(l) });
    const text = lines.join("\n");
    expect(r).toMatchObject({ code: 0, score: 54 });
    expect(text).toContain("✔ Express 5, app created in app.ts");
    expect(text).toContain("✔ Spec: ../openapi.json");
    expect(text).toContain("3 of 5 operations enabled (listOrders, get2, getSalesReport)");
    const cfg = readFileSync(join(dir, "express", "agentify.config.ts"), "utf8");
    expect(cfg).toContain('import { defineConfig } from "openapi-agentify";');
    expect(cfg).toContain('auth: { mode: "passthrough" }');
    expect(cfg).toContain('spec: "../openapi.json"');
    expect(readFileSync(join(dir, "express", ".env.example"), "utf8")).toContain("PUBLIC_URL=");
    expect(JSON.parse(readFileSync(join(dir, "express", "package.json"), "utf8")).dependencies["openapi-agentify"]).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(text).toContain("✔ app.ts already imports Agentify");
  });

  it("--write adds two lines to a plain Express entry and shows the diff", async () => {
    const dir = temp(join(FIX, "plain-express"));
    writeFileSync(join(dir, "openapi.json"), JSON.stringify(ordersSpec));
    const lines: string[] = [];
    await init({ dir, yes: true, write: true, out: (l) => lines.push(l) });
    const server = readFileSync(join(dir, "server.js"), "utf8");
    expect(server).toContain('import { agentify } from "openapi-agentify/express";');
    expect(server).toContain('import agentifyConfig from "./agentify.config.mjs";');
    expect(server.indexOf("app.use(agentify(agentifyConfig));")).toBeLessThan(server.indexOf('app.get("/items"'));
    expect(lines.join("\n")).toContain("+ app.use(agentify(agentifyConfig));");
    // Idempotent: a second run changes nothing.
    await init({ dir, yes: true, write: true, out: () => {} });
    expect(readFileSync(join(dir, "server.js"), "utf8")).toBe(server);
  });

  it("wires Hono and Fastify entries, and CommonJS files with require", () => {
    expect(wireEntry("hono", 'import { Hono } from "hono";\nconst app = new Hono();\napp.get("/", (c) => c.text("hi"));\n', "./agentify.config.js")!.text).toContain("app.use(agentify(agentifyConfig, { app: app }));");
    expect(wireEntry("fastify", 'import Fastify from "fastify";\nconst server = Fastify({ logger: true });\n', "./agentify.config.js")!.text).toContain("await server.register(agentifyFastify, agentifyConfig);");
    const cjs = wireEntry("express", 'const express = require("express");\nconst app = express();\n', "./agentify.config.js")!.text;
    expect(cjs).toContain('const { agentify } = require("openapi-agentify/express");');
    expect(wireEntry("express", "export default {}", "./x.js")).toBeNull();
  });

  it("Next.js: writes the catch-all, lib/agentify.ts and the route map", async () => {
    const dir = temp(join(FIX, "draft/next-app"));
    writeFileSync(join(dir, "openapi.json"), JSON.stringify(ordersSpec));
    await init({ dir, yes: true, write: true, out: () => {} });
    expect(existsSync(join(dir, "src/app/[...agentify]/route.ts"))).toBe(true);
    const routes = readFileSync(join(dir, "agentify.routes.ts"), "utf8");
    expect(routes).toContain('"/api/products/[id]": () => import("./src/app/api/(shop)/products/[id]/route"),');
    expect(readFileSync(join(dir, "src/lib/agentify.ts"), "utf8")).toContain('import config from "../../agentify.config";');
  });

  it("drafts a spec when there's none, and says what it guessed", async () => {
    const dir = temp(join(FIX, "draft/fastify-plugins"));
    const lines: string[] = [];
    const r = await init({ dir, yes: true, out: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "openapi.draft.json"))).toBe(true);
    expect(lines.join("\n")).toMatch(/No spec found: drafted openapi.draft.json from \d+ files \(4 paths\)/);
  });

  it("in a monorepo, goes to the one API package", async () => {
    const dir = temp(join(FIX, "draft/monorepo"));
    const lines: string[] = [];
    const r = await init({ dir, yes: true, out: (l) => lines.push(l) });
    expect(lines[0]).toBe("Monorepo: using packages/api (Hono).");
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "packages/api/agentify.config.ts"))).toBe(true);
  });

  it("refuses a folder with no framework", async () => {
    const lines: string[] = [];
    const r = await init({ dir: temp(), yes: true, out: (l) => lines.push(l) });
    expect(r.code).toBe(1);
  });
});

describe("the CLI itself", () => {
  it("parses flags", () => {
    expect(parseArgs(["init", "x", "--yes", "--anonymous", "deny", "--include", "/a", "--include", "/b", "--k=v"])).toEqual({ _: ["init", "x"], flags: { yes: true, anonymous: "deny", include: "/b", k: "v" }, multi: { anonymous: ["deny"], include: ["/a", "/b"], k: ["v"] } });
  });

  it("prints help, and refuses unknown commands", async () => {
    expect((await run(["help"])).text).toContain("openapi-agentify init [dir]");
    for (const gone of ["keys", "usage", "--claude"]) expect((await run(["help"])).text).not.toContain(gone);
    expect((await run(["nope"])).code).toBe(1);
  });
});
