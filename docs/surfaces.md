# What agents can read

Every document is generated from your spec, `agentify.tools.json` and the
config, once per origin, and cached. Each answers with an `ETag` and honours
`If-None-Match` (304). Documents are `public` for 5 minutes (server card and
AI Catalog: an hour) when `baseUrl` is set; without it they follow each
request's `Host`, so they're only cached privately. CORS is open (`*`) on the
documents: they're public, read-only metadata.

Turn any of them off in `surfaces`. A surface that's off is your app's path
again.

```ts
surfaces: { mcp: true, openapi: true, llmsTxt: true, serverCard: true, serverCardAlias: true, aiCatalog: true, agentIndex: true, linkHeaders: true, robots: false },
```

The draft standards (the server card, the AI Catalog, llms.txt) each live in
one module under `src/surfaces/`, with the date their text was read. If a
draft changes, that module is the one edit.

## `POST /mcp`

MCP over Streamable HTTP, JSON responses, stateless (no sessions, no SSE).
Both protocol eras:

- **2026-07-28**: `server/discover`; every request carries its version and
  client capabilities in `_meta`; `Mcp-Method` and `Mcp-Name` headers must
  match the body (`-32020` otherwise); unknown methods are HTTP 404.
- **2025-11-25, 2025-06-18, 2025-03-26**: `initialize`, then stateless
  requests.

Methods: `initialize`, `server/discover`, `ping`, `tools/list`, `tools/call`.
`GET` and `DELETE` answer 405. Bodies are capped at 4 MiB, and a `tools/call`'s
arguments at `maxArgumentValues` values (default 10,000: every object, array,
string, number, boolean and null, at any depth). More is an `invalid_input`
result, `(root) must NOT have more than 10000 values, …`, before the input
schema runs. A browser `Origin`
must be `baseUrl`'s origin or in `allowedOrigins`. Without `baseUrl` (local
development) both the `Origin` and the request's `Host` must be loopback
(`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`): a DNS-rebinding page makes
its Origin and the Host agree, so the Host alone proves nothing. Clients that
send no `Origin` (agents, curl) aren't browsers and aren't affected. In
production, set `baseUrl`.

## `/llms.txt` and `/llms-full.txt`

The llmstxt.org format (read 2026-09-29): an H1 with the name, a blockquote
summary, plain paragraphs (the MCP endpoint and protocol versions, how to
authenticate, and any notes your `describe` hook adds), then H2 sections of links
(`- [name](url): notes`): `## MCP`, `## Operations` (each with its method and
path, tool name, description, price and an example call), and `## Optional`
(the spec, llms-full.txt, `/agent`, and any links your hooks add).

`llms-full.txt` isn't in the llmstxt.org text; it's the usual "everything in
one file": the same header, then a section per operation with its parameters
and input schema.

## The MCP server card: `/mcp/server-card`

SEP-2127, "MCP Server Cards - HTTP Server Discovery" (modelcontextprotocol PR
#2127, Extensions Track; it superseded SEP-1649). Its wire format lives in
`modelcontextprotocol/experimental-ext-server-card`; Agentify follows snapshot
`526201bb` (read 2026-09-29). What that says:

- the card's recommended home is `<streamable-http-url>/server-card`, so
  `/mcp/server-card`, media type `application/mcp-server-card+json`;
- fields: `$schema` (the v1 URL), `name` (reverse DNS, `com.acme.api/orders-api`),
  `version`, `description` (up to 100 characters), `title`, `websiteUrl`,
  `remotes[]` (`streamable-http`, the URL, the headers agents send, the
  supported protocol versions), and `_meta`;
- cards **don't list tools**: `tools/list` is authoritative.

`/.well-known/mcp.json` answers with the same card, for clients built on the
earlier drafts (`serverCardAlias: false` to turn it off). The SEP's own text
says `.well-known` is for site-wide metadata; domain discovery goes through
the AI Catalog.

## The AI Catalog: `/.well-known/ai-catalog.json`

The AI Catalog (github.com/Agent-Card/ai-catalog, specVersion 1.0, read
2026-09-29), which SEP-2127 uses to find server cards on a domain. Agentify
lists two entries: the server card
(`urn:air:<host>:mcp:<name>`, `application/mcp-server-card+json`) and your
spec (`urn:air:<host>:openapi:<name>`).

## `/openapi.json` and `/openapi.yaml`

Your spec as it is, plus:

- top-level `x-agentify`: the MCP URL, the auth mode, links to llms.txt and the
  server card, and any `extensions` your `describe` hook adds;
- per operation, `x-agentify`: its tool name (and its price, when a hook sets
  `showPrices`), or `agents: false` for an operation that isn't enabled. Every operation in
  your spec stays listed, because people and other clients read it too; to
  hide one from this document, remove it from the spec you serve, or turn the
  surface off (`surfaces.openapi: false`). Disabled operations appear nowhere
  else: not in `tools/list`, `llms.txt` or the server card;
- the `openapi-agentify improve` suggestions you accepted: operationIds, summaries,
  descriptions, parameter descriptions, examples (`x-agentify-examples`), and
  an optional `Idempotency-Key` header on writes.

Your file is never changed. If the spec has no `servers`, `baseUrl` is added.

## Documents your hooks add

`hooks.surfaces` serves more documents next to these (an RFC 9728
`/.well-known/oauth-protected-resource`, a pricing manifest, an admin
report). A `Doc` is cached per origin and served with an ETag and CORS like
the built-in ones; a `Response` is sent as it is. Their paths are in
`surfacePaths()`, so Fastify registers them too. See
[extending](extending.md).

## `/agent`

Agentify's own index: name, description, version, the MCP endpoint and
protocol versions, how to authenticate, every discovery URL, and the
`extensions` your hooks add. JSON by default; a small HTML page when the browser asks for
`text/html`. Both answer with `Vary: Accept`, so a CDN or proxy keeps them
apart.

## `Link:` headers and robots.txt

Responses to `/` get
`Link: </llms.txt>; rel="llms-txt", </openapi.json>; rel="service-desc", </mcp/server-card>; rel="mcp-server-card", </agent>; rel="service-meta"`
(`linkHeaders: false` to turn off). `robots: true` serves a `/robots.txt` that
allows everything and names llms.txt and `/agent`; it's off because most apps
have their own.
