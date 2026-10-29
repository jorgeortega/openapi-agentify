import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acceptAll, improve } from "../src/check/improve.js";
import { readiness } from "../src/check/rules.js";
import { importOpenApi } from "../src/openapi/convert.js";
import { readSpecFile } from "../src/openapi/load.js";
import { readManifest } from "../src/openapi/manifest.js";

/**
 * The canonical readiness fixtures (test/fixtures/readiness): what the readiness rules score for each spec,
 * written down. Other implementations of the same rules replay these files to score the same; this test fails
 * when the rules and the files part ways.
 */

const root = fileURLToPath(new URL("./fixtures/readiness/", import.meta.url));
const manifest: { rulesVersion: string; cases: string[]; sha256: string } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const file = (...parts: string[]) => join(root, "cases", ...parts);
const json = (...parts: string[]) => JSON.parse(readFileSync(file(...parts), "utf8"));
const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("the readiness fixtures", () => {
  it.each(manifest.cases)("%s: readiness() equals expected.json", (name) => {
    const c = json(name, "case.json") as { spec: string; tools: string | null; authMode?: string; baseUrl?: string };
    const doc = readSpecFile(file(name, c.spec));
    // what `agentify check` passes with no config: the tools file if there is one, passthrough, no service credential
    const report = readiness(doc, { manifest: c.tools ? readManifest(file(name, c.tools)) : null, authMode: c.authMode ?? "passthrough", baseUrl: c.baseUrl, serviceCredential: false });
    expect(roundTrip(report)).toStrictEqual(json(name, "expected.json"));
  });

  it("improve() then acceptAll() on orders-thin equals improve.json, and orders-accepted ships it", async () => {
    const doc = readSpecFile(file("orders-thin", "openapi.json"));
    const tools = importOpenApi(doc, { specSource: "openapi.json", now: new Date(0) }).manifest;
    const improved = await improve(doc, tools, { accept: false, idempotency: true });
    expect(roundTrip(acceptAll(improved.manifest))).toStrictEqual(json("orders-thin", "improve.json"));
    expect(json("orders-accepted", "agentify.tools.json")).toStrictEqual(json("orders-thin", "improve.json"));
  });

  it("the manifest lists every case folder", () => {
    expect(readdirSync(file()).filter((name) => !name.startsWith(".")).sort()).toStrictEqual(manifest.cases);
  });
});
