import { stringify } from "yaml";
import type { ManifestTool } from "../openapi/manifest.js";
import { doc, type Doc, type SurfaceModel } from "./model.js";

/**
 * GET /openapi.json and /openapi.yaml: your spec as it is, plus
 *   - `x-agentify` at the top (the MCP endpoint, auth mode, llms.txt, any hook extensions);
 *   - `x-agentify` on each operation (its tool name, whether agents may call it, its price if any);
 *   - `agentify improve` suggestions you accepted (summaries, descriptions,
 *     parameter descriptions, examples, the Idempotency-Key header).
 * Your file is never changed.
 */

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export function servedSpec(m: SurfaceModel, ops: ManifestTool[]): Record<string, any> | null {
  if (!m.spec) return null;
  const spec = mergeSuggestions(m.spec, ops, m.showPrices);
  spec["x-agentify"] = {
    mcp: m.mcpUrl,
    auth: m.auth.mode,
    llmsTxt: m.links.llmsTxt,
    serverCard: m.links.serverCard,
    ...m.extensions,
  };
  if (!Array.isArray(spec.servers) || spec.servers.length === 0) spec.servers = [{ url: m.origin }];
  return spec;
}

/** A copy of the spec with per-operation `x-agentify` and the accepted suggestions applied (also what `agentify check` scores). */
export function mergeSuggestions(original: Record<string, any>, ops: ManifestTool[], showPrices = false): Record<string, any> {
  const spec = structuredClone(original);
  const byOperation = new Map(ops.map((t) => [t.operation, t]));
  for (const [path, item] of Object.entries((spec.paths ?? {}) as Record<string, any>)) {
    if (!item || typeof item !== "object") continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!op || typeof op !== "object") continue;
      const tool = byOperation.get(`${method.toUpperCase()} ${path}`);
      if (!tool) {
        op["x-agentify"] = { agents: false };
        continue;
      }
      // Your spec lists every operation (people use it too); a disabled one is marked
      // agents: false, with no tool name or price to advertise.
      op["x-agentify"] = tool.enabled ? { tool: tool.name, agents: true, ...(showPrices && tool.price ? { price: `$${tool.price}` } : {}) } : { agents: false };
      const s = tool.suggestions;
      if (!s?.accepted) continue;
      if (s.operationId) op.operationId = s.operationId;
      if (s.title && !op.summary) op.summary = s.title;
      if (s.description) op.description = s.description;
      for (const p of (op.parameters ?? []) as any[]) {
        if (p && typeof p === "object" && !p.$ref && s.params?.[p.name] && !p.description) p.description = s.params[p.name];
      }
      if (s.idempotencyKey && !(op.parameters ?? []).some((p: any) => String(p?.name).toLowerCase() === "idempotency-key")) {
        op.parameters = [
          ...(op.parameters ?? []),
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            description: "A unique key (e.g. a UUID) per logical request. Retries with the same key and body return the first response instead of repeating the write.",
            schema: { type: "string", maxLength: 255 },
          },
        ];
      }
      if (s.examples?.length) op["x-agentify-examples"] = s.examples;
    }
  }
  return spec;
}

export function openapiJson(m: SurfaceModel, ops: ManifestTool[]): Doc | null {
  const spec = servedSpec(m, ops);
  return spec ? doc(JSON.stringify(spec, null, 2), "application/json") : null;
}

export function openapiYaml(m: SurfaceModel, ops: ManifestTool[]): Doc | null {
  const spec = servedSpec(m, ops);
  return spec ? doc(stringify(spec), "application/yaml; charset=utf-8") : null;
}
