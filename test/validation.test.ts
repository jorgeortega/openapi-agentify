import { monitorEventLoopDelay } from "node:perf_hooks";
import { runInNewContext } from "node:vm";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { validateConfig } from "../src/config.js";
import { countValues, DEFAULT_MAX_ARGUMENT_VALUES, defineTool, jsonSchemaValidator, pathParamValidator, URL_FORMAT } from "../src/mcp/tools.js";
import type { Manifest } from "../src/openapi/manifest.js";
import type { ToolCallResult } from "../src/hooks.js";
import { config, CUSTOMER_KEY, legacy, ordersManifest, rpc, type Running, start } from "./helpers.js";

/** ajv-formats' own `url`, before the user info was rewritten. */
const AJV_FORMATS_URL = fullFormats.url as RegExp;

/**
 * Argument validation in linear time. Tool arguments (MCP tools/call) and path
 * parameters (guarded routes) are checked before any credential or payment, so
 * one anonymous request reaches these paths. Two were super-linear: the `url`
 * format's pattern and `uniqueItems` over objects. The Python edition has the
 * same fix, and the two editions accept exactly the same inputs.
 */

/** Validates `{ v: value }` against `{ v: schema }`, as a tool argument. */
function argument(schema: Record<string, unknown>) {
  const validate = jsonSchemaValidator("t", { type: "object", properties: { v: schema } });
  return (value: unknown) => validate({ v: value });
}

/**
 * Runs `fn` with a deadline that interrupts it, even inside a regular
 * expression: a regression fails here after a second instead of holding the
 * run for minutes.
 */
function withinBudget<T>(fn: () => T, ms = 1000): T {
  return runInNewContext("run()", { run: fn }, { timeout: ms });
}

/** A seeded PRNG (mulberry32), so a failure can be replayed. */
function random(seed: number) {
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const below = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]) => xs[below(xs.length)];
  const some = (xs: readonly string[], most: number) => Array.from({ length: below(most) }, () => pick(xs)).join("");
  return { next, below, pick, some };
}

describe("the url format", () => {
  const url = argument({ type: "string", format: "url" });
  const urlParam = pathParamValidator({ type: "string", format: "url" })!;

  const PIECES = [
    ...["http://", "https://", "ftp://", "HTTP://", "ftps://", "http:/", "mailto:"],
    ...["a", "z", "Z", "0", "1", "9", "-", ".", ":", "@", "/", "?", "#", "%", "_", "~"],
    ...[" ", "\t", "\n", " ", " ", "　", "﻿", "é", "ſ", "😀"],
    ...["com", "example", "user", "pass", "localhost", "10.", "127.", "192.168.", "172.16."],
    ...["8.8.8.8", "223.1.1.1", "1.2.3.4", ":8080", ":1", "[::1]", "xn--", ".c", ".co"],
  ];

  /** Random pieces, or half the time a URL's shape built from them, so both verdicts come up often. */
  function randomUrl(r: ReturnType<typeof random>): string {
    if (r.next() < 0.5) return (r.next() < 0.8 ? r.pick(PIECES.slice(0, 7)) : "") + r.some(PIECES, 12);
    const userinfo = r.next() < 0.6 ? `${r.some(["u", ":", "@", "p", "%", "é", " ", " "], 6)}@` : "";
    const host = r.pick(["example.com", "a-b.co", "8.8.8.8", "10.0.0.1", "exé.org", "a.c"]);
    const port = r.pick(["", "", ":80", ":8080", ":1", ":123456"]);
    const path = r.pick(["", "/", "/a/b?c#d", "/x y", "/ "]);
    return r.pick(PIECES.slice(0, 4)) + userinfo + host + port + path + r.some(PIECES, 2);
  }

  it("is ajv-formats' own pattern with the user info rewritten", () => {
    expect(URL_FORMAT.source).toBe(AJV_FORMATS_URL.source.replace(String.raw`(?:\S+(?::\S*)?@)?`, String.raw`(?:\S+@)?`));
    expect(URL_FORMAT.source).not.toBe(AJV_FORMATS_URL.source);
    expect(URL_FORMAT.flags).toBe(AJV_FORMATS_URL.flags);
  });

  it("agrees with ajv-formats' own pattern on 200,000 random strings", () => {
    const r = random(20261006);
    let valid = 0;
    for (let n = 0; n < 200_000; n++) {
      const text = randomUrl(r);
      const expected = AJV_FORMATS_URL.test(text);
      if (url(text).ok !== expected || urlParam(text) !== expected) expect.fail(`${JSON.stringify(text)}: ajv-formats says ${expected}`);
      valid += Number(expected);
    }
    expect(valid).toBeGreaterThan(5_000); // the sample reaches both verdicts
  });

  // The Python edition's tests/test_formats.py holds the same verdicts.
  it.each([
    ["https://example.com", true],
    ["http://localhost", false],
    ["http://10.0.0.1", false],
    ["http://8.8.8.8", true],
    ["ftp://ex.com/x", true],
    ["https://exé.com", true],
    ["https://example.c", false],
    ["stream", false],
    ["HTTPS://EXAMPLE.COM", true],
    ["https://example.com/\n", false],
    ["https://user:pass@example.com:8080/p?q", true],
    ["https://:@example.com", true],
    ["https://user:pa ss@example.com", false],
    ["https://exa mple.com", false],
    ["https://exſample.com", true],
    ["https://😀.com", false],
    ["https://192.168.1.1", false],
    ["https://223.1.1.1", true],
  ])("%j is a url: %s", (text, expected) => {
    expect(url(text).ok).toBe(expected);
    expect(urlParam(text)).toBe(expected);
  });

  const ADVERSARIAL: Record<string, string> = {
    "user info :@": `http://${":@".repeat(524_288)}`,
    "user info :": `http://${":".repeat(1_048_576)}`,
    "user info @": `http://${"@".repeat(1_048_576)}`,
    "user info a:@": `http://${"a:@".repeat(349_525)}`,
    "host labels": `http://${"a-a.".repeat(262_144)}!`,
    path: `http://a.com/${"x".repeat(1_048_576)} `,
  };

  it.each(Object.entries(ADVERSARIAL))("refuses about 1 MiB of %s within a second", (_, text) => {
    expect(text.length).toBeGreaterThan(1_000_000);
    expect(withinBudget(() => url(text).ok)).toBe(false);
    expect(withinBudget(() => urlParam(text))).toBe(false);
  });
});

describe("uniqueItems", () => {
  const unique = argument({ type: "array", uniqueItems: true });

  // Equal as JSON, as in Ajv (and the Python edition): 1 and 1.0 are one
  // number, true is not 1, object key order doesn't count. As the wire carries them.
  it.each([
    ["[1, 2, 3]", true],
    ["[1, 1.0]", false],
    ["[0, -0]", false],
    ["[1, true]", true],
    ['[0, false, null, "", [], {}]', true],
    ['["1", 1]', true],
    ['["true", true]', true],
    ["[null, null]", false],
    ['[{"a": 1, "b": 2}, {"b": 2, "a": 1}]', false],
    ['[{"a": 1}, {"a": 1.0}]', false],
    ['[{"a": true}, {"a": 1}]', true],
    ["[[1], [true]]", true],
    ["[[1], [true], [1]]", false],
    ["[[1, 2], [2, 1]]", true],
    ['[{"a": [1, {"b": true}]}, {"a": [1.0, {"b": true}]}]', false],
    ['[{"a": 1}, {"a": 1, "b": null}]', true],
    ['[{"a": "b"}, {"a": "c"}]', true],
    ['[{"a,b": 1}, {"a": 1, "b": 1}]', true],
    ['[["a,b"], ["a", "b"]]', true],
    ['[{"__proto__": 1}, {"__proto__": 1}]', false],
    ['[{"__proto__": 1}, {"__proto__": 2}]', true],
  ])("%s: unique %s", (json, expected) => {
    const issues = [{ path: "v", message: expect.stringMatching(/^must NOT have duplicate items/) }];
    expect(unique(JSON.parse(json))).toEqual(expected ? { ok: true, value: expect.anything() } : { ok: false, issues });
  });

  it("names the two items Ajv named: the last repeat and the nearest earlier copy", () => {
    const result = unique([{ a: 1 }, { b: 1 }, { a: 1 }, { b: 1 }, { c: 1 }]);
    expect(result).toEqual({ ok: false, issues: [{ path: "v", message: "must NOT have duplicate items (items ## 1 and 3 are identical)" }] });
    expect(unique([1, 2, 1, 2, 3])).toEqual({ ok: false, issues: [{ path: "v", message: "must NOT have duplicate items (items ## 1 and 3 are identical)" }] });
  });

  // Ajv's own check let these through, or threw; the Python edition refuses them.
  it.each([
    ["a string named __proto__", { items: { type: "string" } }, '["__proto__", "__proto__"]'],
    ["items under prefixItems", { prefixItems: [{ type: "integer" }, { type: "integer" }], items: { type: "string" } }, "[1, 1]"],
    ["a key named constructor", {}, '[{"constructor": {}}, {"constructor": {}}]'],
    ["a key named valueOf", {}, '[{"valueOf": 1}, {"valueOf": 1}]'],
    ["a key named toString", {}, '[{"toString": 1}, {"toString": 1}]'],
  ])("refuses a repeat with %s", (_, schema, json) => {
    const result = argument({ type: "array", uniqueItems: true, ...schema })(JSON.parse(json));
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.message)).toContainEqual(expect.stringMatching(/^must NOT have duplicate items/));
  });

  it("agrees with Ajv's pairwise check on 20,000 random arrays", () => {
    const stock = new Ajv2020({ strict: false }).compile({ type: "array", uniqueItems: true });
    const r = random(20261006);
    const SCALARS = [0, 1, -0, 2, 0.5, 1e21, true, false, null, "", "1", "a", "true", "null", "[]", "{}"];
    const json = (depth: number): unknown => {
      const roll = r.next();
      if (depth > 2 || roll < 0.5) return r.pick(SCALARS);
      if (roll < 0.75) return Array.from({ length: r.below(3) }, () => json(depth + 1));
      return Object.fromEntries(Array.from({ length: r.below(3) }, () => [r.pick(["a", "b", "c", ""]), json(depth + 1)]));
    };
    let repeats = 0;
    for (let n = 0; n < 20_000; n++) {
      // Through JSON, as arguments arrive.
      const items = JSON.parse(JSON.stringify(Array.from({ length: r.below(7) }, () => json(0))));
      const expected = stock(items);
      if (unique(items).ok !== expected) expect.fail(`${JSON.stringify(items)}: Ajv says ${expected}`);
      repeats += Number(!expected);
    }
    expect(repeats).toBeGreaterThan(2_000); // the sample reaches both verdicts
  });

  it("checks about 1 MiB of objects within a second", () => {
    // 32,768 distinct objects. Ajv compared them pairwise: 8,000 took half a second, 32,000 nine.
    const items = Array.from({ length: 32_768 }, (_, i) => ({ id: i, tags: [i, String(i)] }));
    expect(JSON.stringify(items).length).toBeGreaterThan(1_000_000);
    expect(withinBudget(() => unique(items).ok)).toBe(true);
    expect(withinBudget(() => unique([...items, JSON.parse('{"tags": [7, "7"], "id": 7.0}')]).ok)).toBe(false);
  });

  it("compares arrays nested 100,000 deep without recursing", () => {
    const deep = (n: number, inner: unknown) => JSON.parse(`${"[".repeat(n)}${JSON.stringify(inner)}${"]".repeat(n)}`);
    expect(withinBudget(() => unique([deep(100_000, 1), deep(100_000, 1)]).ok)).toBe(false);
    expect(withinBudget(() => unique([deep(100_000, 1), deep(100_000, 2)]).ok)).toBe(true);
  });
});

describe("path parameters", () => {
  // A path parameter is one string from the URL, which servers cap (Node's http at 16 KiB of
  // headers): checked in linear time, it stays on the request. 64 KiB is four times that.
  const SHAPES = (n: number) => ({
    letters: "a".repeat(n),
    digits: "1".repeat(n),
    "user info": `http://${":@".repeat(n / 2)}`,
    labels: `a@${"a-".repeat(n / 2)}`,
    dots: "a.".repeat(n / 2),
    colons: "f:".repeat(n / 2),
    slashes: "/".repeat(n),
    time: `2020-01-01T${"1".repeat(n)}`,
  });

  it.each(Object.keys(fullFormats))("checks a 64 KiB value against format %s within 50 ms", (format) => {
    const check = pathParamValidator({ type: "string", format })!;
    for (const [shape, value] of Object.entries(SHAPES(65_536))) {
      const started = performance.now();
      withinBudget(() => check(value));
      expect(performance.now() - started, shape).toBeLessThan(50);
    }
  });
});

/**
 * The argument cap. Checking arguments costs time in proportion to how many
 * values they hold, and Ajv (allErrors) keeps an error for every value that
 * fails: 4 MiB of `[0,0,…]` against ten anyOf branches took 0.8 s and 2.6 GiB.
 * Arguments holding more than maxArgumentValues values are refused before the
 * schema runs. The Python edition counts the same way and answers the same.
 */
describe("the argument cap", () => {
  const MESSAGE = (most: number) => `must NOT have more than ${most} values, counting every object, array, string, number, boolean and null at any depth`;

  it("counts every object, array, string, number, boolean and null, the arguments included", () => {
    expect(countValues({})).toBe(1);
    expect(countValues({ a: 1 })).toBe(2);
    expect(countValues({ s: "x", n: 1.5, t: true, f: false, z: null, a: [], o: {} })).toBe(8);
    expect(countValues({ deep: [[[["x"]]]] })).toBe(6);
    expect(countValues([1, [2, [3, { four: 4 }]]])).toBe(8);
    // Keys aren't values, however long; a key named __proto__ is one like any other.
    expect(countValues(JSON.parse(`{"${"k".repeat(10_000)}": 0, "__proto__": {"a": 0}}`))).toBe(4);
    expect(countValues(JSON.parse(`${"[".repeat(100_000)}0${"]".repeat(100_000)}`))).toBe(100_001);
  });

  it("stops counting once past the most it may count", () => {
    const flat = { xs: Array(2_000_000).fill(0) };
    const deep = JSON.parse(`${"[".repeat(100_000)}0${"]".repeat(100_000)}`);
    for (const value of [flat, deep]) {
      const started = performance.now();
      expect(countValues(value, 10)).toBeGreaterThan(10);
      expect(performance.now() - started).toBeLessThan(5);
    }
    // An object's keys are listed in full: still less than parsing them took.
    const text = JSON.stringify(Object.fromEntries(Array.from({ length: 300_000 }, (_, i) => [`k${i}`, 0])));
    let started = performance.now();
    const wide = JSON.parse(text);
    const parsing = performance.now() - started;
    started = performance.now();
    expect(countValues(wide, 10)).toBeGreaterThan(10);
    expect(performance.now() - started).toBeLessThan(parsing);
  });

  it("bounds what the costliest check takes at the default cap", () => {
    // Every value fails all ten branches: Ajv keeps 11 errors for each.
    const validate = jsonSchemaValidator("t", { type: "object", properties: { xs: { type: "array", items: TEN_BRANCHES } } });
    const xs = Array(DEFAULT_MAX_ARGUMENT_VALUES - 2).fill({});
    expect(countValues({ xs })).toBe(DEFAULT_MAX_ARGUMENT_VALUES);
    expect(withinBudget(() => validate({ xs }).ok, 250)).toBe(false);
  });

  it("is a whole number, 1 or more", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10" as unknown as number]) {
      expect(() => validateConfig(config({ maxArgumentValues: bad })), String(bad)).toThrow("agentify: maxArgumentValues must be a whole number, 1 or more");
    }
    expect(() => validateConfig(config({ maxArgumentValues: 1 }))).not.toThrow();
    expect(() => validateConfig(config({ maxArgumentValues: 3_000_000 }))).not.toThrow();
  });

  describe("on /mcp", () => {
    const total = defineTool({
      name: "total",
      description: "Adds up numbers.",
      input: z.object({ xs: z.array(z.number()) }),
      annotations: { readOnlyHint: true },
      handler: async ({ xs }) => ({ total: xs.reduce((a, b) => a + b, 0) }),
    });
    const outcomes: Array<{ tool: string; result: ToolCallResult }> = [];
    let app: Running;
    let small: Running;
    beforeAll(async () => {
      app = await start("hono", config({ tools: withImports(ordersManifest()), codeTools: [total], hooks: { afterToolCall: (call, result) => void outcomes.push({ tool: call.tool.name, result }) } }));
      small = await start("hono", config({ maxArgumentValues: 3, codeTools: [total] }));
    });
    afterAll(async () => {
      await app.close();
      await small.close();
    });

    it(`lets ${DEFAULT_MAX_ARGUMENT_VALUES} values through and refuses one more, before the schema`, async () => {
      const at = await rpc(app.url, legacy("tools/call", { name: "total", arguments: { xs: Array(DEFAULT_MAX_ARGUMENT_VALUES - 2).fill(1) } }));
      expect(at.json.result.structuredContent).toEqual({ total: DEFAULT_MAX_ARGUMENT_VALUES - 2 });
      // One value more, and every one of them the wrong type: only the cap is reported.
      const over = await rpc(app.url, legacy("tools/call", { name: "total", arguments: { xs: Array(DEFAULT_MAX_ARGUMENT_VALUES - 1).fill("1") } }));
      const message = MESSAGE(DEFAULT_MAX_ARGUMENT_VALUES);
      expect(over.status).toBe(200);
      expect(over.json.result).toEqual({
        content: [{ type: "text", text: `Invalid arguments for total: (root) ${message}` }],
        isError: true,
        structuredContent: { error: "invalid_input", issues: [{ path: "", message }] },
      });
      // Hooks hear about it (a meter would record it).
      expect(outcomes.find((o) => o.result.outcome === "invalid_input")).toMatchObject({ tool: "total", result: { httpStatus: 400, success: false } });
    });

    it("follows maxArgumentValues", async () => {
      const at = await rpc(small.url, legacy("tools/call", { name: "total", arguments: { xs: [1] } }));
      expect(at.json.result.structuredContent).toEqual({ total: 1 });
      const over = await rpc(small.url, legacy("tools/call", { name: "total", arguments: { xs: [1, 2] } }));
      expect(over.json.result.structuredContent).toEqual({ error: "invalid_input", issues: [{ path: "", message: MESSAGE(3) }] });
    });

    it("answers the biggest body /mcp takes quickly, and serves other requests meanwhile", async () => {
      // About 4 MiB of `[0,0,…]` for a tool whose items have ten anyOf branches: without the cap,
      // 0.8 s holding the event loop and 2.6 GiB of errors.
      const items = Array(2_097_000).fill(0);
      const call = legacy("tools/call", { name: "importLines", arguments: { body: items } });
      const body = JSON.stringify(call.body);
      expect(body.length).toBeGreaterThan(4_190_000);
      expect(body.length).toBeLessThanOrEqual(4 * 1024 * 1024);
      const before = app.orders.list({ limit: 100 }).orders.length;
      const delay = monitorEventLoopDelay({ resolution: 5 });
      delay.enable();
      const started = performance.now();
      const [big, other] = await Promise.all([
        rpc(app.url, { body, headers: call.headers }),
        (async () => {
          await new Promise((r) => setTimeout(r, 20)); // once the big call is on its way
          const sent = performance.now();
          const res = await fetch(`${app.url}/v1/orders`, { headers: { "x-api-key": CUSTOMER_KEY } });
          return { status: res.status, ms: performance.now() - sent };
        })(),
      ]);
      const elapsed = performance.now() - started;
      delay.disable();
      expect(big.json.result.structuredContent).toEqual({ error: "invalid_input", issues: [{ path: "", message: MESSAGE(DEFAULT_MAX_ARGUMENT_VALUES) }] });
      expect(app.orders.list({ limit: 100 }).orders.length).toBe(before);
      expect(other.status).toBe(200);
      expect(other.ms).toBeLessThan(500);
      expect(elapsed).toBeLessThan(1_000);
      expect(delay.max / 1e6).toBeLessThan(250);
    });
  });
});

/** Ten object shapes, each with its own required key: `{}` fails every one. */
const TEN_BRANCHES = { anyOf: Array.from({ length: 10 }, (_, i) => ({ type: "object", required: [`k${i}`] })) };

/** The Orders tools and `importLines`: order lines as a JSON array, each one of ten shapes. */
function withImports(manifest: Manifest): Manifest {
  const create = manifest.tools.find((t) => t.operation === "POST /v1/orders")!;
  manifest.tools.push({
    ...create,
    name: "importLines",
    enabled: true,
    operation: "POST /v1/imports",
    operationId: "importLines",
    title: "Import order lines",
    description: "Import order lines",
    path: "/v1/imports",
    inputSchema: { type: "object", properties: { body: { type: "array", items: TEN_BRANCHES } }, required: ["body"], additionalProperties: false },
  });
  return manifest;
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await fn();
  for (let i = 0; i < 40 && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 25));
    v = await fn();
  }
  return v;
}
