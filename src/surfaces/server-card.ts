import { LEGACY_VERSIONS, MODERN_VERSIONS } from "../mcp/protocol.js";
import { doc, type Doc, reverseDns, slug, type SurfaceModel } from "./model.js";

/**
 * The MCP Server Card: SEP-2127 ("MCP Server Cards - HTTP Server Discovery",
 * modelcontextprotocol PR #2127, Extensions Track, which superseded SEP-1649),
 * whose wire format lives in modelcontextprotocol/experimental-ext-server-card.
 * Read on 2026-09-29 at snapshot 526201bb (schema.ts and docs/discovery.md).
 * The SEP is still a draft: this module is the one place to change.
 *
 * What that text says, and what we do:
 *   - The card's recommended home is `<streamable-http-url>/server-card`,
 *     so /mcp/server-card. Media type application/mcp-server-card+json.
 *   - `.well-known` is for site-wide metadata, so domain discovery goes
 *     through an AI Catalog at /.well-known/ai-catalog.json (ai-catalog.ts).
 *     We also answer /.well-known/mcp.json with the same card, for clients
 *     written against the earlier drafts; switch it off with
 *     surfaces.serverCardAlias: false.
 *   - Fields: $schema (required, the v1 URL), name (reverse DNS
 *     "namespace/name"), version, description (≤ 100 chars), title,
 *     websiteUrl, remotes[] (type, url, headers, supportedProtocolVersions),
 *     _meta. Cards do NOT list tools: tools/list stays authoritative.
 *   - CORS open to all origins, Cache-Control public max-age=3600, an ETag.
 */

export const SERVER_CARD_SEP = { sep: 2127, snapshot: "526201bb", checked: "2026-09-29" } as const;
export const SERVER_CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
export const SERVER_CARD_TYPE = "application/mcp-server-card+json";
export const SERVER_CARD_SUFFIX = "/server-card";
/** The server card's `_meta` key for Agentify's own fields (reverse DNS of the project's home). */
export const CARD_META_KEY = "io.github.jorgeortega/openapi-agentify";

export const SERVER_CARD_ALIAS = "/.well-known/mcp.json";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function serverCardName(m: Pick<SurfaceModel, "origin" | "name">): string {
  return `${reverseDns(new URL(m.origin).host)}/${slug(m.name)}`;
}

export function serverCard(m: SurfaceModel): Record<string, unknown> {
  const headers =
    m.auth.cardHeaders ??
    (m.auth.mode === "passthrough"
      ? m.auth.headers.map((h) => ({ name: h, description: "The credential this API already accepts, if the operation needs one", isRequired: m.auth.anonymous === "deny", isSecret: true }))
      : []); // e.g. OAuth: clients discover the authorization server from the 401 challenge
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: serverCardName(m),
    version: m.version,
    description: clip(m.description.replace(/\s+/g, " ").trim() || m.name, 100),
    title: clip(m.name, 100),
    websiteUrl: m.links.llmsTxt ?? m.origin,
    remotes: [
      {
        type: "streamable-http",
        url: m.mcpUrl,
        ...(headers.length ? { headers } : {}),
        supportedProtocolVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
      },
    ],
    _meta: {
      [CARD_META_KEY]: {
        auth: m.auth.mode,
        ...(m.links.llmsTxt ? { llmsTxt: m.links.llmsTxt } : {}),
        ...(m.links.openapi ? { openapi: m.links.openapi } : {}),
        ...m.extensions,
      },
    },
  };
}

export function serverCardDoc(m: SurfaceModel): Doc {
  return doc(JSON.stringify(serverCard(m), null, 2), SERVER_CARD_TYPE, 3600);
}

/** Checks a card against the fields the SEP's schema requires; used by tests and `agentify check`. */
export function validateServerCard(card: unknown): string[] {
  const problems: string[] = [];
  const c = card as Record<string, any>;
  if (!c || typeof c !== "object") return ["not a JSON object"];
  if (c.$schema !== SERVER_CARD_SCHEMA) problems.push(`$schema must be ${SERVER_CARD_SCHEMA}`);
  if (typeof c.name !== "string" || !/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(c.name) || c.name.length < 3 || c.name.length > 200) problems.push("name must be reverse-DNS 'namespace/name'");
  if (typeof c.version !== "string" || !c.version || c.version.length > 255 || /^[\^~><=]|\.x$|\*/.test(c.version)) problems.push("version must be a plain version string");
  if (typeof c.description !== "string" || c.description.length < 1 || c.description.length > 100) problems.push("description must be 1–100 characters");
  if (c.title !== undefined && (typeof c.title !== "string" || c.title.length < 1 || c.title.length > 100)) problems.push("title must be 1–100 characters");
  if (c.remotes !== undefined) {
    if (!Array.isArray(c.remotes)) problems.push("remotes must be an array");
    else
      for (const r of c.remotes) {
        if (r?.type !== "streamable-http" && r?.type !== "sse") problems.push("remotes[].type must be streamable-http or sse");
        if (typeof r?.url !== "string" || !/^(https?:\/\/[^\s]+|\{[a-zA-Z_][a-zA-Z0-9_]*\}[^\s]*)$/.test(r.url)) problems.push("remotes[].url must be an http(s) URL");
      }
  }
  if ("tools" in c) problems.push("cards must not list tools (tools/list is authoritative)");
  return problems;
}
