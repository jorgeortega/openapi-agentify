# Good first issues (drafts)

Three issues to open with the `good first issue` label. Each is small enough
for a first pull request and has a test that says when it's done.

## 1. A Koa adapter (`openapi-agentify/koa`)

**Why.** Koa is still a common choice for Node.js APIs, and Koa users can't
mount Agentify today without writing the glue themselves.

**Where.**
- New `src/adapters/koa.ts`. Koa's `app.callback()` is a Node request
  listener, so tool calls can run in-process with `src/adapters/node-inject.ts`,
  as the Express adapter does (`src/adapters/express.ts`). The surfaces and
  the guard work as in `src/adapters/hono.ts`: `agentify.handle()`, then
  `agentify.guard()` around `await next()`.
- `package.json`: the `./koa` export, `koa` as an optional peer dependency
  and a dev dependency.
- `examples/orders-api/koa/` (the same API, from `shared/orders.ts`) and `koa`
  in `FRAMEWORKS` and `start()` in `test/helpers.ts`.
- "Adding a framework adapter" in `CONTRIBUTING.md` has the whole list.

**Done when.**
- `npm test` passes with `koa` in `FRAMEWORKS` (the shared framework tests
  run against it unchanged).
- A tool call reaches the Koa route through the app's own auth middleware, on
  no extra port.
- The README's Frameworks table and `docs/dispatch.md` have a Koa row.
- `init` detecting Koa and `draft` reading Koa routes can be follow-up issues.

## 2. A Bun example

**Why.** People ask whether it runs on Bun. Hono runs on Bun without Node's
`http`, so an example answers the question and catches regressions.

**Where.**
- New `examples/orders-api/bun/server.ts`: the Hono app from
  `examples/orders-api/hono/app.ts`, served with `Bun.serve({ fetch: app.fetch })`.
- The Hono adapter (`src/adapters/hono.ts`) reads Node-only details
  (`env.incoming`) only when they're there; check that it behaves the same
  when `env` is Bun's server object, and fix it if not.
- A `demo:bun` script in `package.json`, and a line in the README's Examples
  section.

**Done when.**
- `bun examples/orders-api/bun/server.ts` serves `/agent`, `/llms.txt` and
  `/mcp`, and `tools/call listOrders` with the demo key
  (`demo-customer-key-0001` in `x-api-key`) returns the orders.
- The steps to try it are in `examples/orders-api/README.md`.
- If it's cheap, a CI job runs it with `oven-sh/setup-bun` (pinned to a commit
  SHA, like the other actions).

## 3. Examples for `x-agentify` in the spec

**Why.** You can name, describe, enable or hide a tool from the spec itself
with `x-agentify` on an operation, but the docs only describe the
`x-agentify` that `/openapi.json` adds on the way out. Nobody finds the input
side.

**Where.**
- What's read: `src/openapi/convert.ts`, around "`x-agentify` on an
  operation": `name`, `title`, `description`, `enabled`, `exclude` and
  `scope` (`x-mcp` is read the same way).
- How it meets `agentify.tools.json` (your edits there win):
  `mergeManifest()` in `src/openapi/manifest.ts`.
- The docs: a new "Annotating your spec" section in `docs/surfaces.md` or
  `docs/readiness.md`, linked from the README's Configuration section.

**Done when.**
- The section has a short OpenAPI excerpt for each key (YAML), what each
  does, and which wins when the tools file says otherwise.
- Every example is checked: a test in `test/` imports a spec using all the
  keys and asserts the tools it produces, so the docs can't drift.
