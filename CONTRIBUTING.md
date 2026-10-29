# Contributing

Thanks for helping. Bug reports, fixes, docs and new framework adapters are all
welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree
  on the approach.
- Security problems: don't open an issue; see [SECURITY.md](SECURITY.md).
- By contributing you agree that your contribution is licensed under the
  [MIT License](LICENSE), and you follow the
  [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

You need Node.js 22.13 or newer.

```bash
git clone https://github.com/jorgeortega/openapi-agentify
cd openapi-agentify
npm install
npm run build       # dist/ (the Next.js example and the e2e test use it)
npm run typecheck
npm test
```

`AGENTIFY_NEXT_E2E=1 npm test` also runs the Next.js example under a real
`next build` and `next start` (slow).

Run the example API on any framework: `npm run demo:hono` (or `demo:express`,
`demo:fastify`, `demo:next`), then open `http://localhost:3000/agent`.

The examples import the package by name (`openapi-agentify`,
`openapi-agentify/express`), as your app would. Inside the repository those
names point at `src/` (`paths` in `tsconfig.json`, which `tsx` reads, and the
aliases in `vitest.config.ts`), so the demos and the tests run the code you're
changing. `examples/orders-api` is also a project of its own: its
`package.json` installs the published package from npm, which is what
StackBlitz runs (`.stackblitzrc`). If you add an import from a new subpath to
an example, add it to both `paths` and the aliases.

## Tests

- `npm test` runs everything in `test/` with Vitest: each framework against
  the example API on a real port (`test/helpers.ts`), the MCP protocol with the
  official TypeScript client, the CLI, the drafter and the readiness rules.
- `npm run typecheck` checks `src/`, `test/` and the examples, and the Next.js
  example with its own `tsconfig.json`.
- `AGENTIFY_NEXT_E2E=1 npm test` adds the Next.js production build.
- CI also builds the `Dockerfile` and runs `test/stdio.test.ts` against it
  (`AGENTIFY_STDIO_IMAGE`).

## The readiness rules and their version

`check`, `improve` and the score come from `src/check/rules.ts`. The same
rules run in [openapi-agent-check](https://github.com/jorgeortega/openapi-agent-check)
(the standalone CLI and library) and in Latitude 10's hosted check and paid
kit, and every copy has to give the same spec the same score.

That's what `test/fixtures/readiness` is for: one folder per case (a spec,
optionally a tools file, and the `expected.json` report), and a
`manifest.json` with the `rulesVersion` and the cases. Other implementations
replay the same files.

- A change that moves any score is a new rules version: bump `rulesVersion`,
  update the affected `expected.json` files in the same pull request, and say
  so in the pull request. The maintainer carries the change to the other
  copies, so they move together.
- A new case goes in its own folder and in `manifest.json`'s `cases`.
- Never edit an `expected.json` to make a test pass: a difference is a real
  difference in scoring.

## Adding a framework adapter

An adapter is a thin layer: everything framework-independent is in
`createAgentify()` (`src/core.ts`). It does three things:

1. **Serves the surfaces.** Turn the framework's request into a Fetch
   `Request`, pass it to `agentify.handle()`, and send back the `Response` it
   returns, or call the next handler when it returns nothing.
2. **Guards your routes.** Call `agentify.guard()` before the app's own
   routes: it strips forged `X-Agentify-*` headers, detects agents, runs
   `guardRoute` hooks and handles `Idempotency-Key`. Apply what it returns
   (`applyFinish()` in `src/adapters/shared.ts` does it for Fetch responses).
3. **Dispatches tool calls in-process.** Give `chooseDispatcher()` a function
   that runs a Fetch `Request` through the app without a socket: Hono uses
   `app.fetch()`, Fastify `app.inject()`, Express a Node request listener on
   in-memory objects (`src/adapters/node-inject.ts`).

`src/adapters/hono.ts` (about 110 lines) is the shortest one to copy from.
Then:

- add the subpath to `exports` in `package.json` and the framework as an
  optional peer dependency (and a dev dependency for the tests);
- add the example API on the new framework under `examples/orders-api/<name>/`,
  using `shared/orders.ts` so it behaves like the others;
- add it to `FRAMEWORKS` and `start()` in `test/helpers.ts`: the shared tests
  then run against it, and they must all pass;
- teach `init` to find it (`src/cli/project.ts`), and `draft` to read its
  routes if it can (`src/draft/draft.ts`);
- add a row to the Frameworks table in the README and a section to
  `docs/dispatch.md`.

## What stays out of this repository

openapi-agentify is the MIT open core of the Latitude 10 Agentify kit. Agent
keys, OAuth, rate limits, usage metering, x402 payments, the hosted stores and
model-written drafts belong to the paid kit and attach through the hooks in
`docs/extending.md`; pull requests that add them here can't be merged. A
hook that makes one of them possible to build outside is welcome.

## Pull requests

- One logical change per pull request, with a test that fails without it.
- Keep the public API stable: `docs/extending.md` is a contract other packages
  build on. If a change alters a hook, say so in the pull request.
- Behaviour that differs between frameworks needs a test on all four
  (`test/helpers.ts` has `FRAMEWORKS` and `start()`).
- The readiness rules are scored against `test/fixtures/readiness`; a rule
  change updates those fixtures in the same pull request.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under "Unreleased".
- Commit messages: a short imperative subject (`fix: …`, `feat: …`, `docs: …`).

## Code style

TypeScript, strict, ES modules, two-space indentation, semicolons, double
quotes. Comments say why, not what.
