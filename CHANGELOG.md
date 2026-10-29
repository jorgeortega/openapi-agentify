# Changelog

All notable changes to openapi-agentify are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

- `examples/orders-api/stdio.ts` (`npm run demo:stdio`): the Express demo as a
  stdio MCP server, and a `Dockerfile` that runs it, for Glama. Neither ships
  in the npm package.
- tools/list now carries the parameter descriptions from accepted `improve`
  suggestions, as /openapi.json and llms.txt already did.
- The stdio demo serves the reviewed tool definitions
  (`examples/orders-api/stdio.tools.json`).
- `examples/orders-api` opens on StackBlitz: its own `package.json` installs
  the published package, the Express version imports `openapi-agentify` by
  name (in the repository that's still `src/`), and `npm run try` and
  `npm run inspect` talk to its `/mcp`.

## 0.1.0 — 2026-10-29

The first open-source release: the core of the Latitude 10 Agentify kit,
under the MIT License.

- The middleware for Express 4 and 5, Hono 4, Fastify 5 and Next.js 15 and 16
  (App Router).
- `/mcp`: Streamable HTTP, stateless, both protocol eras (2026-07-28 and
  2025-11-25, 2025-06-18, 2025-03-26).
- In-process dispatch of tool calls through your own routes, or
  `dispatch: { mode: "http" }`.
- Discovery documents: `llms.txt`, `llms-full.txt`, the MCP server card
  (SEP-2127), the AI Catalog, `/openapi.json` and `/openapi.yaml` with agent
  hints, `/agent`.
- On your routes: forged `X-Agentify-*` headers stripped, agent detection,
  `Idempotency-Key` on agents' writes (in memory, or your own store).
- Hooks: `authenticate`, `toolVisible`, `listTool`, `serverMeta`,
  `beforeToolCall`, `afterToolCall`, `guardRoute`, `describe`, `surfaces`,
  `setup` and `close` (see `docs/extending.md`).
- The CLI: `init`, `check`, `improve` (rules only), `draft` and `sync`.

Compared with the paid kit, agent keys, OAuth, rate limits, usage metering,
x402 payments, the Postgres store, live checks (`check --url`) and Claude
drafting (`improve --claude`) are not included; they attach through the hooks.
