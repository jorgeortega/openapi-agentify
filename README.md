# openapi-agentify

**Turn the API you already run into an MCP server: one middleware, from your OpenAPI spec, in-process.**

[![CI](https://github.com/jorgeortega/openapi-agentify/actions/workflows/ci.yml/badge.svg)](https://github.com/jorgeortega/openapi-agentify/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/openapi-agentify)](https://www.npmjs.com/package/openapi-agentify)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Add one middleware to your Express, Hono, Fastify or Next.js app. It reads
your OpenAPI spec (or drafts one from your routes) and serves `/mcp` with one
tool per operation. A tool call becomes the HTTP request the operation
describes and runs **in-process through your own routes**: your auth
middleware, your validation and your handlers, the ones you already test.
There is no second server, no proxy and no extra port.

It also serves what agents read before they call: `llms.txt`, an MCP server
card, the AI Catalog, your spec with agent hints, and `/agent`, an index of
all of them. And it scores how well a model will understand your spec, then
suggests the fixes.

## Quick start (30 seconds)

```bash
cd your-api
npx openapi-agentify init --write
npm install
npm run dev
```

`init` detects the framework and the file that creates your app, finds your
spec (or drafts one from your routes), scores it, writes `agentify.config.ts`
and `agentify.tools.json` (reads on, writes off), and adds two lines to your
entry file. Then point any MCP client at `http://localhost:3000/mcp`:

```bash
npx @modelcontextprotocol/inspector   # Streamable HTTP, http://localhost:3000/mcp
```

Or by hand, on Express:

```ts
import express from "express";
import { agentify } from "openapi-agentify/express";
import { defineConfig } from "openapi-agentify";

const app = express();
app.use(agentify(defineConfig({ name: "Acme Orders API", spec: "./openapi.yaml" }))); // first, before body parsers and auth
app.use(express.json());
app.get("/v1/orders/:id", requireApiKey, getOrder); // unchanged
```

## Frameworks

| Framework | Versions | Mount | Tool calls reach your app through |
|---|---|---|---|
| Express | 4 and 5 | `app.use(agentify(config))` | an in-memory `IncomingMessage`/`ServerResponse` pair, through `app` itself |
| Hono | 4 | `app.use(agentify(config, { app }))` | `app.fetch(request, env)`, with your bindings |
| Fastify | 5 | `await app.register(agentifyFastify, config)` | `app.inject()` |
| Next.js (App Router) | 15 and 16 | `agentifyNext(config, { routes })`, a catch-all route and `wrap()` | the route module's exported `GET`/`POST`/… |

Need a socket (TLS client certificates) or another language? `dispatch:
{ mode: "http", url }` sends tool calls over loopback HTTP instead.

## How it fits

```
 npx openapi-agentify init   reads package.json, finds or drafts the spec,
                             scores agent readiness, writes agentify.config.ts
          │
          ▼
 your app (Express · Hono · Fastify · Next.js)
 ┌───────────────────────────────────────────────────────────────────────┐
 │ app.use(agentify(config))                                             │
 │   POST /mcp                          MCP (2026-07-28 and 2025-xx)     │
 │   GET  /openapi.json, /openapi.yaml  your spec, with agent hints      │
 │   GET  /llms.txt, /llms-full.txt     for models reading docs          │
 │   GET  /mcp/server-card              MCP server card (SEP-2127 draft) │
 │   GET  /.well-known/ai-catalog.json  where the card is                │
 │   GET  /agent                        one index of all of the above    │
 │ on your routes: agent detection · Idempotency-Key · your hooks        │
 │                                                                       │
 │   tool call ──in-process──▶ your existing route handler + auth        │
 └───────────────────────────────────────────────────────────────────────┘
```

## What's included

- **MCP endpoint**: Streamable HTTP, JSON responses, stateless; both protocol
  eras (2026-07-28 with `server/discover` and the `Mcp-Method`/`Mcp-Name`
  header rules, and 2025-11-25/06-18/03-26 with `initialize`). Tested against
  the official MCP TypeScript client in both.
- **In-process dispatch**: path, query, header and JSON body parameters mapped
  from the spec; only declared parameters reach your app; credentials and
  `X-Agentify-*` headers can't be forged by the model; non-2xx answers become
  tool errors the model can read; timeouts and response caps.
- **Tools from your spec**: OpenAPI 3.0 and 3.1 (JSON or YAML, a file, a URL
  or read from your running app), validated with JSON Schema 2020-12 in linear
  time, plus code tools (`defineTool()` with a Zod schema) for work that isn't
  a route. `agentify.tools.json` is the reviewable list: names, descriptions,
  which writes are enabled.
- **Discovery documents**: `llms.txt` and `llms-full.txt` (llmstxt.org), the
  MCP server card (SEP-2127), the AI Catalog, `/openapi.json` and
  `/openapi.yaml` with `x-agentify` hints, `/agent`, `Link:` headers on `/`.
  Cached with ETags; each one can be switched off.
- **Agent readiness check**: `npx openapi-agentify check` scores what a model
  will get wrong about your API, 0–100, over 13 weighted rules (operationIds,
  descriptions, parameter docs, response schemas, auth, examples, errors,
  pagination, idempotency, enums, tool count). `improve` writes rule-based
  fixes into `agentify.tools.json` (never your spec); `--accept` serves them.
- **A spec drafter**: no spec? `draft` reads your Express, Hono (including
  `zValidator` and `@hono/zod-openapi`), Fastify or Next.js source with
  TypeScript's parser (your code is never run) and writes OpenAPI 3.1.
- **On your routes**: forged `X-Agentify-*` headers stripped, agents detected
  (a dated User-Agent list and Web Bot Auth), `Idempotency-Key` honoured on
  agents' writes, paths a router could resolve differently refused.
- **Hooks** for everything else: `authenticate`, `beforeToolCall`,
  `afterToolCall`, `guardRoute`, `describe`, extra `surfaces`. Bring your own
  API keys, OAuth, rate limits, metering or payments. See
  [docs/extending.md](docs/extending.md).

## The CLI

```bash
npx openapi-agentify init [dir]          # the whole setup (--yes, --write, --spec, --url, --include-writes…)
npx openapi-agentify check [spec|url]    # the readiness report (--json, --fail-under 80)
npx openapi-agentify improve [--accept]  # suggested fixes, into agentify.tools.json
npx openapi-agentify draft [dir]         # a draft OpenAPI 3.1 from your routes
npx openapi-agentify sync                # the spec changed: update tools, keep your edits
```

`npx openapi-agentify check --fail-under 80` in CI keeps the score honest.

## Configuration

```ts
// agentify.config.ts
import { defineConfig } from "openapi-agentify";

export default defineConfig({
  name: "Acme Orders API",
  description: "Look up, create and refund orders.",
  baseUrl: process.env.PUBLIC_URL,       // your canonical origin: set it in production
  spec: "./openapi.yaml",                // or a URL, or "app:/docs/json" (read from your app)
  tools: "./agentify.tools.json",
  auth: { mode: "passthrough" },         // agents send the credentials your API accepts
  anonymous: "allow",                    // | "deny"
  detect: { include: ["/v1/*"] },
  dispatch: { mode: "in-process" },      // | { mode: "http", url }
  idempotency: true,                     // | { ttlSeconds, store }
  trustProxy: false,                     // true behind one proxy you run (Vercel: true)
  hooks: [],                             // see docs/extending.md
});
```

Every option is typed and commented in [`src/config.ts`](src/config.ts).

### Security notes

- **Your auth stays in charge.** By default the MCP endpoint forwards the
  caller's own credentials and your API decides. Agentify refuses to start if
  `dispatch: http` would send them to another origin.
- **Set `baseUrl` in production.** It names your origin in every document,
  and it's the only origin whose pages may call `/mcp` from a browser (plus
  `allowedOrigins`). Without it, browser requests are accepted only from
  localhost pages on a localhost Host, which stops DNS rebinding.
- **Mount it first**, before body parsers and auth, so it can strip forged
  `X-Agentify-*` headers. It never parses a body for your routes.
- **Give id parameters a `pattern`** (or an `enum`, a `format`): a route
  outside the spec that matches a template is then not taken for the
  operation.

## Examples

`examples/orders-api` is the same small Orders API in Express, Hono, Fastify
and Next.js, with its own API-key auth and a deliberately thin spec (it scores
54; `improve --accept` brings it to 96):

```bash
git clone https://github.com/jorgeortega/openapi-agentify && cd openapi-agentify
npm install
npm run demo:hono        # or demo:express, demo:fastify, demo:next
curl -s localhost:3000/llms.txt
```

For MCP clients that start a process instead of calling a URL, `npm run
demo:stdio` serves the Express version over stdio: each message is relayed to
its `/mcp`, through the same middleware. The repo's `Dockerfile` runs it
(`docker build -t openapi-agentify-demo . && docker run -i --rm
openapi-agentify-demo`); it is how the demo is listed on Glama, and it is not
part of the npm package.

## Docs

- [Extending](docs/extending.md): the hooks, with a worked example
- [Dispatch](docs/dispatch.md): how a tool call reaches each framework
- [Surfaces](docs/surfaces.md): every discovery document and its standard
- [Readiness](docs/readiness.md): the rules, `improve`, `sync` and `draft`

## Hosted and paid

openapi-agentify is the open core, MIT-licensed, and stays that way. If you'd
rather not run it yourself, or you need the operational parts:

- **Hosted MCP** at [latitude10.tech/platform/mcp](https://latitude10.tech/platform/mcp):
  your OpenAPI document served as an MCP server, with sealed upstream
  credentials, analytics and sign-in through your identity provider.
- **The Latitude 10 Agentify kit** (paid) builds on this package with its own
  agent keys, OAuth, per-agent rate limits, usage metering and x402
  pay-per-call, all attached through the hooks in
  [docs/extending.md](docs/extending.md).

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).
Security reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 October Moon LLC
