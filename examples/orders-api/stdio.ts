import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createExpressApp } from "./express/app.js";
import { loadExampleConfig } from "./load-config.js";

/**
 * The Express Orders API as a stdio MCP server, for MCP clients and
 * directories (Glama) that start a process instead of calling a URL.
 *
 * It starts the Express app on a private loopback port and relays each
 * JSON-RPC line from stdin to its /mcp endpoint, so every message goes
 * through the same middleware an HTTP agent would hit. Replies go to stdout,
 * one per line; logs go to stderr.
 */

// stdout carries only JSON-RPC.
console.log = console.error;

// The tool definitions `openapi-agentify improve --accept` wrote for the
// demo spec (readiness 54 → 96), so stdio clients see the reviewed tools.
const config = { ...(await loadExampleConfig(resolve(dirname(fileURLToPath(import.meta.url)), "express"))), tools: "./stdio.tools.json" };
const server = createExpressApp(config).listen(0, "127.0.0.1");
await new Promise<void>((ok, fail) => server.once("listening", ok).once("error", fail));
const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

let protocolVersion: string | undefined;
const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function relay(line: string): Promise<void> {
  let msg: { id?: unknown; method?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: line,
    });
    const text = await res.text();
    if (!text) return; // a notification: 202, no body
    const reply = JSON.parse(text);
    if (msg.method === "initialize" && reply.result?.protocolVersion) protocolVersion = reply.result.protocolVersion;
    write(reply);
  } catch (err) {
    if (msg.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(err) } });
  }
}

// Replies keep the order requests arrived in.
let queue = Promise.resolve();
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line.trim()) queue = queue.then(() => relay(line));
});
input.on("close", () => void queue.then(() => server.close()));
