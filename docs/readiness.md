# Agent readiness: `check` and `improve`

## `openapi-agentify check`

```bash
npx openapi-agentify check                          # the spec your config names (or the one init found)
npx openapi-agentify check openapi.yaml             # a file
npx openapi-agentify check https://api.acme.com     # a running app (tries /openapi.json, /docs/json, /swagger.json, /api-docs…)
npx openapi-agentify check --json --fail-under 80   # for CI: exit 1 under 80
```

### The rules

Each rule looks at the operations (or parameters) it applies to and scores
the share that pass. The score is the weighted average:

```
score = Σ weight × passing share / Σ weight × 100
```

So one thin operation in fifty costs little; a spec without descriptions costs
a lot.

| Rule | Weight | Passes when |
|---|---|---|
| `operation-ids` | 10 | there's an operationId, and it isn't ambiguous (`get2`, `handler`, `post`, anything ending in a digit after a lowercase letter, under 3 characters) |
| `descriptions` | 10 | the description is 40+ characters and no other operation has the same one |
| `summaries` | 8 | there's a summary |
| `parameter-descriptions` | 8 | each parameter (credential headers and cookies aside) has a description |
| `response-schemas` | 8 | a 2xx response has a non-empty JSON schema (204 counts) |
| `security` | 8 | a security scheme is defined and applied (`security: []` means none) |
| `examples` | 6 | a parameter, request body or response has an example |
| `error-responses` | 6 | a 4xx, 5xx or `default` response is documented |
| `pagination` | 6 | a GET that returns a list has limit/cursor/page/offset-style parameters |
| `json-bodies` | 5 | request bodies accept JSON |
| `idempotency` | 5 | POST/PATCH accept an `Idempotency-Key` header (or say `x-idempotent: true`) |
| `enums` | 4 | status/sort/type-like parameters list their values (an enum, or "One of: …") |
| `tool-count` | 4 | at most 40 enabled tools, and no names that collided |

`check` scores your spec with the suggestions you accepted applied (what
`/openapi.json` serves). In passthrough mode it also warns when the spec's
`servers` name another origin than `baseUrl`.

## `openapi-agentify improve`

```bash
npx openapi-agentify improve             # write suggestions to agentify.tools.json
npx openapi-agentify improve --accept    # and accept them
```

For each finding it writes a `suggestions` object on the tool, from the
rules alone: no model is called, and the same spec always gets the same
suggestions. Your spec is never touched:

```json
"suggestions": {
  "source": "rules",
  "accepted": false,
  "operationId": "getOrder",
  "title": "Get an order",
  "description": "Gets one order by its id, with all its fields. Answers 404 when there's no such order. The response has id, customer, items, totalCents, status, createdAt.",
  "params": { "id": "The order's id, as returned by the list and create operations." },
  "examples": [{ "description": "Get an order", "arguments": { "id": "order_123" } }],
  "idempotencyKey": false
}
```

- **operationId**: `listOrders`, `getOrder`, `createOrder`, `refundOrder`…
  from the method and path. Accepting it also renames the tool, if its name
  was still the one made from the old id (a name you chose is kept).
- **Summary and description**: from the method, the resource and the fields
  the response has; writes say they change data and mention
  `Idempotency-Key`.
- **Parameter descriptions**: from the name (id, limit, cursor, page, q…), with
  the allowed values when the parameter or a same-named response field has an
  enum ("One of: open, paid, refunded").
- **Examples**: made from your schemas (their examples, defaults, enums and
  formats first).
- **Idempotency-Key**: documented on POST/PATCH, because Agentify honours it
  for agents (the tool then takes an optional `idempotencyKey` argument).

Accepted suggestions change what agents see: `tools/list` titles and
descriptions, `llms.txt`, and `/openapi.json`. Restart your app to pick up the
tools file.

Error responses and security schemes can't be suggested: only you know them.

## `openapi-agentify sync`

When your spec changes, `sync` re-imports it: each tool gets the spec's current
parameters and schemas, and keeps your edits (name, enabled, title,
description, scope, price, costUsd, timeoutMs, rateLimit, weight, annotations,
examples, suggestions). New operations are added (writes disabled), removed
ones dropped.

## `openapi-agentify draft`

No spec? `draft` reads your source with TypeScript's parser (your code is
never run) and writes `openapi.draft.json`:

- **Express**: `app.get("/x/:id", …)`, `express.Router()` / `Router()`,
  `app.use("/prefix", router)` (routers imported from other files, ESM or
  `require`), `app.route("/x").get(…).post(…)`;
- **Hono**: `app.get(…)`, `app.route("/prefix", sub)`, `new Hono().basePath("/v1")`,
  `zValidator("json" | "query" | "param", schema)`, and `@hono/zod-openapi`'s
  `createRoute({ method, path, request, responses })`;
- **Fastify**: `fastify.get(path, { schema }, h)`, `fastify.route({ method, url, schema })`,
  `app.register(plugin, { prefix })` (named or inline plugins); route
  `schema` blocks are JSON Schema already;
- **Next.js**: `app/**/route.{ts,js}` (or `src/app`), `[id]` → `{id}`, route
  groups dropped, private `_folders` skipped, catch-alls flagged; exported
  `GET`/`POST`/… (including `export { handler as GET }`).

Zod schemas it can resolve in the same file become JSON Schema (object,
string, number, boolean, enum, array, literal, union, record, optional,
nullable, default, describe, `.openapi({ example })`, min/max, email, url,
uuid, datetime, int). Anything else is `{}` marked `x-agentify-todo`. Every
operation is marked `x-agentify-guess` (at least its operationId) and
`x-agentify-source` (file and line). `init` drafts automatically when it finds
no spec.
