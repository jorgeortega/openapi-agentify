import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

/**
 * The stdio entry (examples/orders-api/stdio.ts) answers MCP introspection.
 * With AGENTIFY_STDIO_IMAGE set, the same checks run against that Docker
 * image instead (CI builds it from the Dockerfile Glama uses).
 */
const image = process.env.AGENTIFY_STDIO_IMAGE;
const [cmd, args] = image
  ? ["docker", ["run", "-i", "--rm", image]]
  : [process.execPath, ["--import", "tsx", "examples/orders-api/stdio.ts"]];

describe(`stdio MCP server (${image ? `docker ${image}` : "node"})`, () => {
  it("answers initialize and tools/list", { timeout: 120_000 }, async () => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const send = (msg: unknown) => child.stdin!.write(`${JSON.stringify(msg)}\n`);
    const next = async () => JSON.parse((await lines.next()).value as string);
    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      const init = await next();
      expect(init).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "Orders API" }, capabilities: { tools: {} } } });

      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const list = await next();
      expect(list.id).toBe(2);
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["listOrders", "getOrder", "getSalesReport"]);

      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "listOrders", arguments: {} } });
      const call = await next();
      expect(call.id).toBe(3);
      expect(call.result).toBeDefined();
    } finally {
      child.stdin!.end();
      child.kill();
    }
  });
});
