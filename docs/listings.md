# Where to list openapi-agentify

Prepared on 2026-10-29, nothing submitted. Each entry has the exact text to
submit and how. "Checked" means the submission rules were read on that date;
"unverified" means they couldn't be read and are from the directory's
existing entries or general knowledge.

openapi-agentify is a **library that turns an existing API into an MCP
server**, not a server itself. Directories built for servers fit it badly; the
"Frameworks" sections and developer-tool lists fit it well.

## No `server.json`

The official MCP Registry (registry.modelcontextprotocol.io) lists
**servers**: each `server.json` names one package or remote endpoint that an
MCP client can install or connect to, with its transport and arguments.
openapi-agentify has no endpoint and nothing a client can run: it's a
dependency your API imports, and the MCP server it creates is yours (with your
own name, URL and tools). A `server.json` would describe nothing a client can
use, so the repo has none. An API that uses openapi-agentify can publish its
own `server.json` for its own `/mcp`.

## Shared text

- **Name:** openapi-agentify
- **One line (≤ 100 characters):** Turn the API you already run into an MCP server: one middleware, from your OpenAPI spec.
- **Short (≤ 260 characters):** Add one middleware to an Express, Hono, Fastify or Next.js app: it reads your OpenAPI spec and serves /mcp with one tool per operation. Tool calls run in-process through your own routes and auth. Plus llms.txt, a server card and a readiness check. MIT.
- **Repository:** https://github.com/jorgeortega/openapi-agentify
- **Homepage:** https://latitude10.tech/platform/mcp
- **Language / licence:** TypeScript, MIT

## Summary

| Where | Fits | How | Rules |
|---|---|---|---|
| npm | yes | `npm publish` (owner) | checked (standard) |
| GitHub topics | yes | repo settings or `gh repo edit` | checked (standard) |
| punkpeye/awesome-mcp-servers, "Frameworks" | yes | PR to `README.md` | checked |
| punkpeye/awesome-mcp-devtools, "Frameworks" | yes (better fit) | PR to `README.md` | checked (no written guide) |
| appcypher/awesome-mcp-servers | weak (no frameworks section) | PR, one per addition | checked |
| wong2/awesome-mcp-servers, "Frameworks" | yes | form at mcpservers.org/submit (no PRs) | checked |
| modelcontextprotocol/servers, `ADDITIONAL.md` → "Frameworks / For servers" | yes | PR to `ADDITIONAL.md` | partly checked: no contribution note found |
| mcp.so | weak (types: server, remote server, client, AI product) | form at mcp.so/submit | checked |
| Glama | unclear (a server directory) | "Add Server" on glama.ai/mcp/servers | unverified (requirements not on the page) |
| PulseMCP | not now | submissions paused | checked |
| HOL (hol.org/plugins) | poor (plugins for coding agents) | "Submit Plugin": connect GitHub, HOL opens a PR | checked, not recommended |
| Product Hunt | yes, at launch | post from a personal account | checked |
| Show HN | yes, at launch | news.ycombinator.com/submit | checked |

## npm

How: from a clean `main`, `npm run build && npm test`, then
`npm publish --access public` (the owner runs it). `package.json` already has
the name, description, keywords, repository, homepage, licence and `files`.

Text: from `package.json` (description is the short text above).

## GitHub topics

How: after the repository exists,
`gh repo edit jorgeortega/openapi-agentify --add-topic mcp,model-context-protocol,mcp-server,openapi,ai-agents,llm,express,hono,fastify,nextjs,middleware,typescript --description "Turn the API you already run into an MCP server: one middleware, from your OpenAPI spec, in-process." --homepage https://latitude10.tech/platform/mcp`

## punkpeye/awesome-mcp-servers

Rules (CONTRIBUTING.md, checked): fork, edit `README.md`, open a pull request;
name linked to the repository, a brief description, one line per entry, the
existing style. The **Frameworks** section (`## Frameworks`, near the end)
takes frameworks; entries carry the language emoji from the legend (📇
TypeScript, ☁️ cloud, 🏠 local) and most carry a Glama score badge (not a
written requirement; add it once Glama lists the repo).

Line to add under `## Frameworks`:

```markdown
- [jorgeortega/openapi-agentify](https://github.com/jorgeortega/openapi-agentify) 📇 🏠 - Turn an existing Express, Hono, Fastify or Next.js API into an MCP server from its OpenAPI spec: one middleware, tool calls run in-process through your own routes and auth.
```

PR title: `Add openapi-agentify to Frameworks`

## punkpeye/awesome-mcp-devtools

Rules (checked, no CONTRIBUTING file): sections include SDKs, **Frameworks**,
Libraries and Templates; SDK entries are ordered by stars. The Frameworks
section of awesome-mcp-servers points here for "more frameworks, utilities,
and other developer tools".

Line to add under `Frameworks`:

```markdown
- [openapi-agentify](https://github.com/jorgeortega/openapi-agentify) 📇 - Middleware that turns an existing Express, Hono, Fastify or Next.js API into an MCP server from its OpenAPI spec, with in-process tool calls, llms.txt, a server card and a readiness check.
```

## appcypher/awesome-mcp-servers

Rules (CONTRIBUTING.md, checked): "Link additions should be added to the
bottom of the relevant category", "Make an individual pull request for each
suggestion", "Make sure your list is ordered alphabetically". There's no
frameworks section; the nearest is "Tools & Utilities" ("Tools that help
manage, configure, and work with MCP servers"). Low priority: a maintainer may
judge it out of scope.

Line, if submitted under Tools & Utilities:

```markdown
- [openapi-agentify](https://github.com/jorgeortega/openapi-agentify) - Middleware that turns an existing Express, Hono, Fastify or Next.js API into an MCP server from its OpenAPI spec.
```

## wong2/awesome-mcp-servers

Rules (README, checked): "We do not accept PRs. Please submit your MCP on the
website: https://mcpservers.org/submit". The list has a `## Frameworks`
section (create-mcp-ts, LiteMCP). The form asks for Server Name, Category,
Short Description, a repository/website/docs link, an optional MCP Registry
name, whether it supports remote connections, a contact email and a plan
(free: review up to two weeks; $39 one-time: 24 h review). There is no
Frameworks category in the form: pick **Development** and say "framework" in
the description.

- Server Name: `openapi-agentify`
- Category: Development
- Short Description: `Framework: turn an existing Express, Hono, Fastify or Next.js API into an MCP server from its OpenAPI spec, in-process.`
- Link: `https://github.com/jorgeortega/openapi-agentify`
- Registry name: leave empty
- Remote connections: no (it makes servers; it isn't one)
- Contact: the owner's choice
- Plan: free

## modelcontextprotocol/servers (the community lists)

The README no longer keeps a community servers list: servers go to the MCP
Registry, and "See ADDITIONAL.md for a curated list of frameworks and
resources". `ADDITIONAL.md` has `## 📚 Frameworks` → `### For servers`
(e.g. ModelFetch). No contribution note was found in the file, so check the
repository's CONTRIBUTING.md before opening the PR (unverified whether
framework PRs are still accepted).

Line to add under `### For servers`, in the file's existing format:

```markdown
- **[openapi-agentify](https://github.com/jorgeortega/openapi-agentify)** - Turn an existing Express, Hono, Fastify or Next.js API into an MCP server from its OpenAPI spec (TypeScript)
```

## mcp.so

Rules (mcp.so/submit, checked): Repository URL (required) and Name, and a
type: MCP Server, Remote Server, MCP Client or AI Product; a $39 option skips
review. Whether sign-in is required isn't stated. No type fits a library; MCP
Server is the nearest and may be refused. Low priority.

- Repository URL: `https://github.com/jorgeortega/openapi-agentify`
- Name: `openapi-agentify`
- Type: MCP Server

## Glama

Rules: unverified. glama.ai/mcp/servers has an "Add Server" button; the page
doesn't say what it needs, and there's no frameworks directory. Glama indexes
GitHub repositories and scores them, which the punkpeye list uses for its
badges. Worth adding once the repository is public, so the badge exists.

- Repository: `https://github.com/jorgeortega/openapi-agentify`
- Description: the short text above.

## PulseMCP

Rules (pulsemcp.com/submit, checked): "We are not accepting new MCP server or
client submissions right now". It recommends the official MCP Registry and
will pick listings up from there when it reopens; openapi-agentify has no
registry entry (see "No server.json"). Nothing to do now; revisit later.

## HOL (hol.org/plugins)

Rules (checked): a registry of plugins for AI coding agents (Claude Code,
Codex, Cursor…), with trust scores and install commands. "Submit Plugin":
connect GitHub, list a public repository, and HOL opens a pull request on the
"awesome-ai-plugins" list it ingests (the repository name isn't given).
openapi-agentify isn't a plugin an agent runtime installs, so it would be
mis-filed. Not recommended; if the owner wants it anyway, submit the
repository URL with the short text.

## Product Hunt

Rules (help center, checked): a personal account (company accounts can't
post), "Post" → the product's URL; name only; a very short tagline (60
characters is the usual limit: unverified in the article); a description up
to 260 characters; a few topics; 2+ gallery images (1270×760); a 240×240
thumbnail; makers; a first comment. Launches run 12:01 AM PST; save a draft
until the date.

- Name: `openapi-agentify`
- Tagline: `Your existing API, as an MCP server, in one middleware` (54 characters)
- Description: the short text above (252 characters).
- Topics: Developer Tools, Open Source, Artificial Intelligence, APIs
- Gallery: the architecture diagram from the README; `init` in a terminal; the MCP Inspector listing the Orders API's tools; `llms.txt` in a browser
- First comment:

  > I kept seeing teams build a second server to give agents MCP access to an API they already had, then re-implement its auth and validation there. openapi-agentify skips that: one middleware reads your OpenAPI spec and every tool call runs in-process through the routes and auth middleware you already test. It also serves llms.txt and an MCP server card, and scores how well a model will understand your spec. MIT. I'd love to hear which framework or spec feature breaks it.

## Show HN

Rules (news.ycombinator.com/showhn.html, checked): something people can try
(it is: `npx openapi-agentify init`, no sign-up), that you made and will
discuss; title starts with "Show HN"; say how and why you made it; no
fundraisers or landing pages; don't ask for votes. Submit at
https://news.ycombinator.com/submit with the repository URL.

- Title: `Show HN: openapi-agentify – turn your existing API into an MCP server, in-process`
- URL: `https://github.com/jorgeortega/openapi-agentify`
- Text (first comment):

  > openapi-agentify is a middleware for Express, Hono, Fastify and Next.js. It reads your OpenAPI spec and serves /mcp with one tool per operation; a tool call becomes the HTTP request the operation describes and goes straight into your app (no socket, no second service), so your own auth, validation and handlers run. Writes stay off until you enable them.
  >
  > Why: every "API to MCP" approach I tried was a separate proxy that needed its own credentials and re-checked what my API already checks. In-process meant solving a few odd problems: Express can't be re-entered with a fake request without breaking later real ones, so it uses its own in-memory IncomingMessage/ServerResponse; agents' Idempotency-Key retries need the raw body without taking it from express.json(); and path parameters are matched the way routers match them, so /v1/orders/export isn't mistaken for /v1/orders/{id}.
  >
  > It also serves llms.txt, an MCP server card and an AI Catalog entry, and `npx openapi-agentify check` scores your spec for agents (0–100) with rule-based fixes. Both MCP protocol eras (2026-07-28 and 2025-xx) are tested against the official client. MIT. Hosted and paid options exist, but everything above is in the open package.
