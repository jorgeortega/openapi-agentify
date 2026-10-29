# Orders API example

A small Orders API with its own API-key auth, and `openapi-agentify` mounted
in front of it: `/mcp` serves one tool per operation in `openapi.json`, and a
tool call runs through the API's own Express routes and auth.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/jorgeortega/openapi-agentify/tree/main/examples/orders-api)

## Try it

On StackBlitz the server starts by itself (`npm start`). Locally:

```bash
npm install
npm start          # Orders API (Express) on http://127.0.0.1:3000
```

Then, in a second terminal:

```bash
npm run try        # initialize, tools/list and one tools/call, with plain fetch
npm run inspect    # the MCP Inspector, pointed at http://localhost:3000/mcp
```

`npm run inspect` runs:

```bash
npx @modelcontextprotocol/inspector --server-url http://localhost:3000/mcp --header "x-api-key: demo-customer-key-0001"
```

Or call one tool from the command line:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp \
  --header "x-api-key: demo-customer-key-0001" \
  --method tools/call --tool-name listOrders --tool-arg limit=2
```

The Inspector needs Node.js 22.19 or newer. `npm run try` needs only what
`npm install` already installed.

The `x-api-key` header is the demo customer's key (`shared/orders.ts`).
Agentify forwards it on tool calls and the API's own middleware checks it:
without it, `tools/list` still answers and `tools/call` gets the API's 401 as
a tool error.

Also worth opening: `/agent` (an index of everything agents can read),
`/llms.txt` and `/openapi.json` (the spec, with agent hints).

## What's here

| File | What it is |
|---|---|
| `express/app.ts` | the Express app, with `app.use(agentify(config))` before the body parser |
| `agentify.config.ts` | the config `openapi-agentify init` would write |
| `openapi.json` | a deliberately thin spec: `npx openapi-agentify check openapi.json` scores it 54 |
| `shared/orders.ts` | the in-memory data and the API-key check |
| `hono/`, `fastify/`, `next/` | the same API on the other frameworks (run them from the repository root) |
| `stdio.ts` | the Express version as a stdio MCP server (`npm run demo:stdio` at the root) |

On its own (here, or on StackBlitz) the example installs `openapi-agentify`
from npm. Inside the repository, `tsconfig.json` and `vitest.config.ts` point
the same imports at `src/`, so `npm run demo:express` and the tests run the
code you're changing.
