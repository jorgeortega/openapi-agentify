# Extending openapi-agentify

openapi-agentify is the open core: the MCP endpoint, in-process dispatch,
the adapters, the discovery documents, the readiness check and the CLI. It
decides nothing about who may call what beyond forwarding the credentials your
API already accepts. Everything a deployment adds on top (its own agent keys,
OAuth, rate limits, usage metering, payments) plugs in through **hooks**:

```ts
import { defineConfig } from "openapi-agentify";

export default defineConfig({
  name: "Acme Orders API",
  spec: "./openapi.yaml",
  hooks: { authenticate, beforeToolCall, afterToolCall, guardRoute, describe, surfaces },
});
```

`hooks` is one object or an array of them. This page is the contract: what
each hook sees, what it may return, and, at the end, exactly how the paid
Latitude 10 kit attaches its features to it.

## With no hooks

- `/mcp` authenticates nobody. A caller that sends a credential your spec
  declares (`Authorization`, an `apiKey` header, or `auth.forward`) is a
  `passthrough` principal: the credential is forwarded on every tool call
  and **your API's own auth middleware decides**. A caller with none is
  `anonymous` (refused with a 401 when `anonymous: "deny"`).
- Tool calls run in-process through your routes (see [dispatch](dispatch.md)).
- Write operations are off until you enable them in `agentify.tools.json`.
- On your own routes, Agentify strips forged `X-Agentify-*` headers, detects
  agents, refuses ambiguous paths (`..`, `//`, encoded slashes) from agents,
  and honours `Idempotency-Key` on agents' POST/PATCH to an operation
  (records in memory unless you pass `idempotency.store`).
- No rate limits, no metering, no payments. `price`, `rateLimit`, `weight`
  and `costUsd` in `agentify.tools.json` are kept as data for hooks.

## The hooks

### Lifecycle

| Hook | When | Use it to |
|---|---|---|
| `setup({ config, spec, manifest, logger })` | once, when Agentify loads (the first request or `ready()`) | open a database, read secrets (never at import: `next build` imports route modules) |
| `close()` | `agentify.close()` | close it |

If `setup` throws, the surfaces answer 500 and your routes keep working; it
is retried on the next request.

### `/mcp`

**`authenticate(request, { ip, origin, resourceMetadataUrl })`** decides who
is calling. Return:

- a `Principal`: `{ type, id, label, scopes, forward, stepUp?, data? }`.
  `forward` is the headers every tool call carries to your routes (a service
  credential, `X-Agentify-Agent`), `scopes` are checked against each tool's
  `scope` (default `api:read` for GET/HEAD operations, `api:write` otherwise
  and for code tools; `"*"` holds every scope), and `stepUp: true` lists tools
  the caller lacks the scope for so that calling one answers 403 with an
  `insufficient_scope` challenge (OAuth clients);
- a `Response` to refuse (a 401 with `WWW-Authenticate`). A JSON body is
  answered as JSON-RPC with the request's id;
- `null`/`undefined` for the built-in passthrough/anonymous behaviour.

**`toolVisible(tool, principal)`** returns `true`/`false` to override who sees
and may call a tool (`undefined`: the scope rule). An anonymous caller who
calls a tool hidden from it gets a 401 challenge, so OAuth-capable clients
discover how to sign in.

**`listTool(listing, tool, principal)`** changes one `tools/list` entry for
this caller (a price note in the description, `_meta`).

**`serverMeta()`** adds `_meta` to `server/discover` (2026-07-28).

**`mcpRequestHeaders`** lists extra request headers browsers may send to
`/mcp` (CORS), e.g. `["Payment-Signature", "X-Agent-Key"]`.

**`beforeToolCall(call)`** runs after the scope check and after the arguments
are validated, before the call is dispatched. `call` has the tool, the
validated arguments, the principal, the request id, origin, IP, user agent,
the `/mcp` request's headers, the tools/call's `params._meta`, and `state`,
an object you share with `afterToolCall`. Return:

- `{ refuse: { kind: "error", status, code, message, data?, headers?, outcome? } }`:
  a JSON-RPC error with an HTTP status (429 with `Retry-After`, say). Use
  `AppErrorCode.RateLimited` (-31029), `.Forbidden`, `.Unauthorized`;
- `{ refuse: { kind: "result", output, outcome? } }`: a tool result with
  `isError` (payment terms the client can act on);
- `{ headers }`: added to the in-process request (a service credential,
  `X-Agentify-Payer`). `X-Agentify-*` headers set here reach your routes; the
  route guard strips them from everyone else.

**`afterToolCall(call, result)`** runs after every `tools/call` that named a
tool the caller may see, whatever happened. `result.outcome` is `"ok"`,
`"error"`, `"forbidden"`, `"invalid_input"` or a refusal's own `outcome`;
`httpStatus` is your route's status; `success` is "ran and answered 2xx";
`latencyMs`; and `pending` is set when the call was cut short (timeout,
client gone): your app may still finish, and `pending` resolves with what it
answered. Return `{ output }` to replace what the agent gets (withhold a
result), `{ meta }` to add result `_meta` (a receipt). A hook that throws is
logged and ignored.

### Your own routes

**`guardRoute(request, info)`** runs on every request inside `detect.include`
(not on Agentify's own in-process calls: the tool-call hooks ran for those).
`info` has:

| Field | |
|---|---|
| `operation` | the enabled operation in `agentify.tools.json` this request is (matched like a router: case-insensitive, percent-decoded, path parameters checked against their schemas), or null |
| `disabled` | an operation it matches that agents may not call |
| `canonical` | spelled exactly as the spec spells `operation`: only then hand out a credential |
| `ambiguous` | dot segments, `//` or encoded slashes (agents are already refused) |
| `detected` | `{ agent, via, name, signatureAgent }` from User-Agent and Web Bot Auth headers |
| `hasCredentials` | sent a credential your API accepts, or a cookie |
| `ip`, `origin`, `path`, `rawPath` | |

Return `{ respond: Response }` to answer instead of your route (429, 402,
403), or any of:

- `setHeaders`, `removeHeaders`: applied to the request before your routes
  (swap an agent key for your service credential);
- `responseHeaders`: added to the response;
- `buffer: true` and `finish(res)`: hold the response until `finish` has seen
  it (`{ status, headers, body, bytes }`), then add `headers` or `replace` it
  (settle a payment only on a 2xx, else withhold the result). Without
  `buffer`, `finish` runs after the response is sent (metering);
- `idempotencyScope`: whose `Idempotency-Key` namespace the request uses (an
  agent key id, a payer). With one, idempotency also applies to callers not
  detected as agents;
- `cancel()`: called instead of `finish` when Agentify answers itself after
  all (an idempotent replay, a reused key), to release a held payment.

Next.js: only handlers wrapped with `wrap()` run the guard.

### Discovery

**`describe(model)`** returns the model every document is built from, changed:
`auth` (`mode`, `headers`, `issuer`, `scopes`, `resourceMetadataUrl`,
`instructions` to replace the "how to authenticate" text, `cardHeaders` for
the server card), `notes` (paragraphs for llms.txt), `showPrices` (show each
tool's `price` in llms.txt, `/agent` and `/openapi.json`), `extraLinks`
(listed in llms.txt and `/agent`), and `extensions` (merged into `/agent`,
the spec's top-level `x-agentify` and the server card's `_meta`).
`auth.resourceMetadataUrl` is also what `/mcp`'s 401 and 403 challenges point
at.

**`surfaces`** adds documents: `{ path, serve(request, model), methods?, cache? }`.
`serve` returns a `Doc` (from `doc(body, type, maxAge)`, cached per origin,
ETag, CORS), a `Response`, or `null` (your app's). Their paths join
`surfacePaths()`.

### Several hook sets

`hooks: [keys, limits, payments, metering]` runs them in order:
`authenticate` until one answers; `toolVisible` until one returns a boolean;
`listTool` and `describe` chained; `beforeToolCall` until one refuses, with
headers merged; `afterToolCall` in reverse order, each seeing the output the
last one left; `guardRoute` until one responds (earlier ones are cancelled),
with headers merged and `finish` run in reverse; `surfaces` and
`mcpRequestHeaders` concatenated. `composeHooks()` does this and is exported.

## A worked example

Agent keys, a per-key limit and a meter, in about forty lines (the same hooks
are exercised in `test/hooks.test.ts`):

```ts
import { AppErrorCode, bearerChallenge, defineConfig, type AgentifyHooks } from "openapi-agentify";

const keys = new Map([["ak_live_123", { id: "k1", scopes: ["api:read"] }]]);
const used = new Map<string, number>();

const hooks: AgentifyHooks = {
  mcpRequestHeaders: ["X-Agent-Key"],
  authenticate(request) {
    const raw = request.headers.get("x-agent-key");
    if (!raw) return null; // passthrough or anonymous, as built in
    const key = keys.get(raw);
    if (!key) return Response.json({ jsonrpc: "2.0", id: null, error: { code: AppErrorCode.Unauthorized, message: "Unknown agent key" } }, { status: 401, headers: { "www-authenticate": bearerChallenge(null, { error: "invalid_token" }) } });
    return { type: "agent-key", id: `key:${key.id}`, label: key.id, scopes: key.scopes, forward: { "x-api-key": process.env.SERVICE_KEY!, "x-agentify-agent": key.id } };
  },
  beforeToolCall(call) {
    const n = (used.get(call.principal.id) ?? 0) + (call.tool.weight ?? 1);
    used.set(call.principal.id, n);
    if (n > 60) return { refuse: { kind: "error", status: 429, code: AppErrorCode.RateLimited, message: "Rate limit exceeded", headers: { "Retry-After": "60" }, outcome: "rate_limited" } };
  },
  afterToolCall(call, result) {
    console.log(JSON.stringify({ tool: call.tool.name, agent: call.principal.label, outcome: result.outcome, status: result.httpStatus, ms: Math.round(result.latencyMs) }));
  },
  describe: (m) => ({ ...m, auth: { ...m.auth, mode: "agent-keys", headers: ["x-agent-key"], instructions: ["Send your agent key in `X-Agent-Key`."] } }),
};

export default defineConfig({ name: "Acme Orders API", spec: "./openapi.yaml", hooks });
```

## How the paid Latitude 10 kit attaches

The paid kit (`@latitude10/agentify`) depends on `openapi-agentify` and adds
its operational features as hooks. Its own config keeps the fields its users
know (`auth: { mode: "agent-keys" | "oauth" }`, `upstream`, `payments`,
`limits`, `store`, `adminToken`, `anonymous: "paid"`); a wrapper maps them to
an open-core config and a list of hooks, then hands the result to the same
adapters:

```ts
// in the paid kit
import { createAgentify } from "openapi-agentify";
export function createPaidAgentify(config: PaidConfig) {
  const { auth, upstream, payments, limits, store, adminToken, anonymous, ...core } = config;
  return createAgentify({
    ...core,
    auth: { mode: "passthrough", forward: auth?.mode === "passthrough" ? auth.forward : [] },
    anonymous: anonymous === "deny" ? "deny" : "allow",
    idempotency: { ...(typeof core.idempotency === "object" ? core.idempotency : {}), store: sharedStore }, // its Store has the same three methods
    hooks: [storeHooks(store), keyOrOAuthHooks(auth, upstream), limitHooks(limits), paymentHooks(payments, upstream, anonymous), meterHooks(adminToken)],
  });
}
// and: agentify(createPaidAgentify(config)) with openapi-agentify/express, /hono, /fastify, /next.
```

| Paid feature (kit module) | Hooks it uses |
|---|---|
| Postgres/SQLite store (`src/store/*`, `db/migrations`, `scripts/migrate.ts`) | `setup` opens it and starts the hourly prune, `close` closes it; `idempotency.store` is the same store (`beginIdempotent`, `completeIdempotent`, `releaseIdempotent` have the open core's signatures) |
| Agent keys (`src/auth/api-keys.ts`) | `authenticate`: verify `ak_live_…` from `Authorization` or `X-Agent-Key`, return `{ type: "agent-key", scopes, forward: { [upstream.header]: upstream.value, "x-agentify-agent": id, "x-agentify-agent-owner": owner }, data: { rateLimit } }`, or a 401 `Response` with `invalid_token`. `guardRoute`: verify a key on your routes, `removeHeaders` it, answer 403 `operation_disabled` when `info.disabled`, 403 `insufficient_scope` when the key lacks the operation's scope, `setHeaders` the service credential only when `info.operation && info.canonical`, `idempotencyScope: "key:<id>"`. `describe`: `auth.mode: "agent-keys"`, `instructions`, `cardHeaders`. `mcpRequestHeaders: ["X-Agent-Key"]` |
| OAuth resource server (`src/auth/oauth.ts`, `src/surfaces/oauth-metadata.ts`) | `authenticate`: verify the JWT, return `{ type: "oauth", stepUp: true, scopes, forward: { authorization } }` or a 401 `Response` with `bearerChallenge(resourceMetadataUrl, { error: "invalid_token" })`; with `anonymous: "deny"` the core's own 401 points at the same metadata. `describe`: `auth.mode: "oauth"`, `issuer`, `scopes`, `resourceMetadataUrl`, an `extraLinks` entry (`section: "mcp"`). `surfaces`: `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` |
| Rate limits (`store.consumeToken`, `limits.agent`, per-tool `rateLimit` and `weight`) | `beforeToolCall`: refuse `{ kind: "error", status: 429, code: AppErrorCode.RateLimited, headers: { "Retry-After" } }`. Passthrough's per-IP refusal budget: `afterToolCall` counts a 401/403 `httpStatus` against `call.ip`, `beforeToolCall` checks it. `guardRoute`: `respond` 429 for agents (`info.detected`, a key). `EventSampler` (exported) samples 429 floods for the meter |
| Usage metering (`store.recordUsage`, `agentify usage`, `GET /agentify/usage`) | `afterToolCall` writes the MCP row (`outcome`, `httpStatus`, `latencyMs`, `output.bytes`); `guardRoute`'s `finish` writes the HTTP row; `surfaces: [{ path: "/agentify/usage", cache: false, serve }]` checks the admin token |
| x402 payments (`src/payments/x402.ts`, `src/surfaces/x402-discovery.ts`) | `toolVisible`: anonymous callers see only priced tools under `anonymous: "paid"`. `listTool`: the price note and `_meta["com.latitude10/price"]`. `serverMeta`: `com.latitude10/payments`. `beforeToolCall`: read the payment from `call.meta["x402/payment"]` or the `payment-signature` header, refuse `{ kind: "result" }` with the payment requirements, else verify, keep the claim in `call.state`, return `{ headers: { [upstream.header]: upstream.value, "x-agentify-payer": payer } }`. `afterToolCall`: settle when `result.success && !result.output.replayed`, add the receipt as `meta`, replace the output when settlement fails, and settle on `pending` when the call was cut short. `guardRoute`: the charge decision (`info.hasCredentials`, `info.detected`), `respond` 402, `buffer: true` and `finish` to settle on a 2xx, `cancel` to release the claim, `idempotencyScope: "payer:<address>"`, the service credential only when `info.canonical`. `describe`: `showPrices`, `notes` (how to pay), `extraLinks` (`/.well-known/x402`), `extensions.payments`. `surfaces`: `/.well-known/x402`. `mcpRequestHeaders: ["Payment-Signature"]` |
| Live checks (`src/check/live.ts`), `improve --claude`, `keys`, `usage` | The paid CLI wraps `main` from `openapi-agentify/cli`: it handles its own commands and flags (`keys`, `usage`, `check --url`, `improve --claude`) and passes every other command to `main`. Claude-drafted text goes into the same `suggestions` object with `"source": "claude"` (the manifest format keeps that value) |
| The setup wizard, licence and order handling | Stay in the paid kit; nothing in the open core refers to them |

### What differs from the paid kit's own API

- `AgentifyConfig` has no `upstream`, `payments`, `limits`, `store`,
  `adminToken` or `usageRetentionDays`; `auth.mode` is `"passthrough"` only;
  `anonymous` is `"allow"` or `"deny"`. `hooks` is new, and
  `idempotency.store` lets you share records between instances.
- The `Agentify` object has no `store()`; it gains `surfaceModel(origin)`.
- Not exported: `createAgentKey`, `verifyAgentKey`, `JwtVerifier`,
  `openStore`, `Store`, `parseRate`, `parseSince`. New: the hook types,
  `composeHooks`, `memoryIdempotencyStore`, `bearerChallenge`, `hasScope`,
  `McpServer`, `ToolRegistry`, `doc`.
- `/mcp` runs rate limits after argument validation (a hook can't run
  before it), so a malformed call costs no rate-limit token.
- The server card's `_meta` key is `io.github.jorgeortega/openapi-agentify`,
  and `/agent` says `"generator": "openapi-agentify"`.
- `improve()` takes no `claude` option.
