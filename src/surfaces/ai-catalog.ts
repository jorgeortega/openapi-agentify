import { doc, type Doc, slug, type SurfaceModel } from "./model.js";
import { SERVER_CARD_TYPE } from "./server-card.js";

/**
 * GET /.well-known/ai-catalog.json: the AI Catalog (github.com/Agent-Card/ai-catalog,
 * specVersion 1.0, read 2026-09-29), which SEP-2127 uses for domain-level
 * discovery of MCP server cards. Required: `specVersion` and `entries`; each
 * entry has an `identifier` (urn:air:{publisher}:{namespace}:{name}), a
 * media `type`, and exactly one of `url` or `data`.
 */

export const AI_CATALOG_PATH = "/.well-known/ai-catalog.json";
export const AI_CATALOG_TYPE = "application/ai-catalog+json";

export function aiCatalog(m: SurfaceModel): Record<string, unknown> {
  const host = new URL(m.origin).hostname;
  const entries: Array<Record<string, unknown>> = [];
  if (m.links.serverCard) {
    entries.push({ identifier: `urn:air:${host}:mcp:${slug(m.name)}`, type: SERVER_CARD_TYPE, url: m.links.serverCard, displayName: m.name });
  }
  if (m.links.openapi) {
    entries.push({ identifier: `urn:air:${host}:openapi:${slug(m.name)}`, type: "application/vnd.oai.openapi+json", url: m.links.openapi, displayName: `${m.name} (OpenAPI)` });
  }
  return {
    specVersion: "1.0",
    host: { displayName: m.name, identifier: host, ...(m.links.llmsTxt ? { documentationUrl: m.links.llmsTxt } : {}) },
    entries,
  };
}

export function aiCatalogDoc(m: SurfaceModel): Doc {
  return doc(JSON.stringify(aiCatalog(m), null, 2), AI_CATALOG_TYPE, 3600);
}
