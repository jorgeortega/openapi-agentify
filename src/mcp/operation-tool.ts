import { buildOperationRequest, toToolResult } from "../dispatch.js";
import { effectiveText, type ManifestTool } from "../openapi/manifest.js";
import { jsonSchemaValidator, type JsonSchemaObject, type ToolDefinition, ToolError } from "./tools.js";

/**
 * A ToolDefinition for one operation in agentify.tools.json: it builds the
 * request the operation describes and dispatches it into your app.
 */
/**
 * An accepted `idempotencyKey` suggestion documents the Idempotency-Key header
 * (which Agentify honours for agent POST/PATCH calls): the tool takes it as an
 * optional `idempotencyKey` argument too, so agents that retry can send one.
 */
export function withIdempotencyParam(t: ManifestTool): ManifestTool {
  if (!t.suggestions?.accepted || !t.suggestions.idempotencyKey || (t.method !== "POST" && t.method !== "PATCH")) return t;
  if (t.params.some((p) => p.in === "header" && p.name.toLowerCase() === "idempotency-key")) return t;
  const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
  if ("idempotencyKey" in props) return t;
  return {
    ...t,
    params: [...t.params, { name: "Idempotency-Key", in: "header", arg: "idempotencyKey", required: false }],
    inputSchema: {
      ...t.inputSchema,
      properties: {
        ...props,
        idempotencyKey: { type: "string", minLength: 1, maxLength: 255, description: "A unique key per logical request (e.g. a UUID). Retrying with the same key and arguments returns the first result instead of repeating the write." },
      },
    },
  };
}

/**
 * Accepted `params` suggestions describe the tool's arguments in tools/list,
 * as they do in /openapi.json and llms.txt.
 */
export function withParamDescriptions(t: ManifestTool): ManifestTool {
  const docs = t.suggestions?.accepted ? t.suggestions.params : undefined;
  const props = (t.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  if (!docs || !Object.keys(docs).some((k) => props[k])) return t;
  const next = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, docs[k] ? { ...v, description: docs[k] } : v]));
  return { ...t, inputSchema: { ...t.inputSchema, properties: next } };
}

export function operationTool(entry: ManifestTool, maxResponseBytes: number): ToolDefinition {
  const t = withParamDescriptions(withIdempotencyParam(entry));
  const text = effectiveText(t);
  return {
    name: t.name,
    ...(text.title ? { title: text.title } : {}),
    description: text.description,
    inputSchema: t.inputSchema as JsonSchemaObject,
    validate: jsonSchemaValidator(t.name, t.inputSchema as JsonSchemaObject),
    // Same default as the HTTP guard: reads need api:read, anything else api:write.
    scope: t.scope ?? (t.method === "GET" || t.method === "HEAD" ? "api:read" : "api:write"),
    price: t.price,
    timeoutMs: t.timeoutMs,
    rateLimit: t.rateLimit,
    weight: t.weight,
    annotations: t.annotations,
    source: "openapi",
    handler: async (input: Record<string, unknown>, ctx) => {
      // X-Agentify-Operation: which operation this credential was handed out for, so a route
      // that shares the path template (/v1/orders/export vs /v1/orders/{id}) can refuse it.
      const request = buildOperationRequest(t, input, {
        origin: ctx.call.origin,
        headers: { ...ctx.call.headers, "x-agentify-tool": t.name, "x-agentify-operation": t.operationId ?? t.name },
        signal: ctx.signal,
      });
      let res: Response;
      try {
        res = await ctx.call.dispatch(request);
      } catch (err) {
        if (err instanceof ToolError) throw err;
        if (ctx.signal.aborted) throw new ToolError(`${t.name} was cancelled or timed out`);
        ctx.logger.warn("dispatch_failed", { tool: t.name, err });
        throw new ToolError(`${t.name}: the API could not be reached (request ${ctx.requestId})`);
      }
      const out = await toToolResult(res, maxResponseBytes);
      // An Idempotency-Key replay: the stored answer to a call already made (and paid for).
      if (res.headers.get("idempotent-replayed") === "true") out.replayed = true;
      return out;
    },
  };
}
