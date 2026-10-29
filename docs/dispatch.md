# In-process dispatch

A tool call becomes the HTTP request its operation describes and goes straight
into your app: no socket, no port, no second service. Your middleware, auth,
validation and handlers run as they do for any request.

## How each framework is reached

| Framework | How |
|---|---|
| Hono | `app.fetch(request, env)` with the MCP request's `env`, so `getConnInfo` and bindings work |
| Fastify | `app.inject()` |
| Express | Agentify's in-memory injector (`src/adapters/node-inject.ts`): a real `IncomingMessage` and `ServerResponse` on an in-memory socket, through `app` itself |
| Next.js | the route module's exported function (`GET`, `POST`…), found in `agentify.routes.ts`, called with `params` as a Promise |

Why not light-my-request for Express: when it sees an Express app it
re-parents Express's shared request/response prototypes onto its own classes.
That's fine in a test, and breaks every later real request in a running
server.

## The request

- **Path parameters** are percent-encoded (`a/b` → `a%2Fb`), so a value stays
  one segment; `""`, `.` and `..` are refused. The final URL must stay on your
  origin.
- **Query and header parameters**: only those your spec declares. Arrays are
  exploded unless the spec says `explode: false`; `deepObject` is supported.
  Header values can't contain CR, LF or NUL, and can never be a credential,
  a cookie, `X-Agentify-*`, `X-Request-Id`, `traceparent` or another
  transport header.
- **Body**: JSON, with the operation's content type.
- **Set by Agentify**: the caller's credentials (passthrough), or the headers
  your hooks add ([extending](extending.md)),
  `X-Agentify-Tool`, `X-Agentify-Operation`, `X-Request-Id`, `traceparent`, a
  `User-Agent`, the agent's IP in `X-Forwarded-For` (with `trustProxy`, the
  hop your proxy reported), the real socket address as the injected request's
  remote address (Express and Fastify), and an `X-Agentify-Internal` marker
  (a fresh random value per call, dead once your app has answered) saying the
  call is Agentify's own. The guard removes it before your handlers run.
- **Host**: `baseUrl`'s, or the MCP request's (with `trustProxy`, the
  proxy-added `X-Forwarded-Host`, never the one the client wrote first).
- **Hono on Node**: the call gets your `env` bindings, but not the MCP
  request's own `incoming`/`outgoing`: `env.incoming` is a stand-in for the
  tool call (its method, path, headers, and the caller's address, so
  `getConnInfo()` works).
- **Timeouts** (`timeoutMs` per tool, default 30 s): the request's `signal`
  is aborted, so handlers that watch `request.signal` can stop. Express and
  Fastify can't stop a handler that has started: the call keeps running and
  its answer is discarded (an `afterToolCall` hook gets it as `pending`).

## The response

- JSON becomes `structuredContent` (and text); anything else is text.
- Non-2xx is a tool error (`isError: true`) with the status and a short excerpt;
  a JSON error body is kept in `structuredContent.error`.
- Redirects aren't followed (the tool reports where it pointed).
- At most `maxResponseBytes` (default 1 MiB) is read.

## Your routes see the call once

In-process calls pass through Agentify's own middleware again on the way to
your route. It recognises them and skips everything the MCP layer already did
(including your `guardRoute` hook: the tool-call hooks ran instead); only
`Idempotency-Key` is applied there, and only for operations in
`agentify.tools.json`.
They never reach the agent surfaces, so a spec path like `/openapi.json` goes
to your app, not back to Agentify.

## Where to mount it

First, before body parsers and auth:

- it strips forged `X-Agentify-*` headers before anything reads them;
- `/mcp` gets the raw body (with `express.json()` in front, Agentify re-reads
  what it parsed, but its 100 KB default limit would apply to MCP messages);
- it never parses a body for your routes. For an `Idempotency-Key` on an
  operation, Express needs the body before your routes run and a Node request
  can be read once, so Agentify reads the raw bytes (up to 1 MiB) and puts
  them back at the front of the stream. Your `express.json()` then reads the
  request as sent: its `limit`, its `verify` hook (a webhook signature over
  the raw body) and its error handling all apply, whoever is calling. Past
  1 MiB it puts back what it read and the request goes on without Agentify's
  idempotency. Fastify replays the body the same way in `preParsing`; Hono
  and Next.js read a clone.

Mount it on the root app: tool paths are absolute (`/v1/orders`), and the
surfaces are served at the root.

## When in-process isn't possible

Some middleware needs a real socket (TLS client certificates, `req.socket`
tricks), or the API is another process or language. Then:

```ts
dispatch: { mode: "http", url: "http://127.0.0.1:8080" },
```

Tool calls become loopback HTTP requests (redirects not followed, 30 s
timeout). In passthrough mode the URL must be `baseUrl`'s origin or a loopback
address; otherwise Agentify refuses to start: forwarding agents' credentials
is only safe to the same API.

## Next.js specifics

- `proxy.ts` / `middleware.ts` doesn't run for tool calls (they call the route
  function directly). Keep auth in the route handlers, or use `dispatch: http`.
- Handlers get a `NextRequest` (Agentify builds one when it changes headers).
- **Wrap every handler agents may reach.** Outside requests go straight from
  Next to your handler, so only `wrap()` can strip forged `X-Agentify-*`
  headers, honour `Idempotency-Key` and run your `guardRoute` hook. The
  in-process marker never reaches a
  handler, wrapped or not.
- The catch-all `app/[...agentify]/route.ts` serves the surfaces; your own
  routes match first. Anything else that falls to it gets a JSON 404.
- `next build` imports your route modules without runtime secrets: Agentify
  loads the spec and runs your hooks' `setup` on the first request, not at
  import.
- There's no client IP in Next.js 15+: set `trustProxy: true` on Vercel or
  behind your own proxy so hooks see the client's IP from `X-Forwarded-For`.
