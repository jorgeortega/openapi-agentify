/**
 * openapi-agentify: turn the API you already run into an MCP server, in-process.
 *
 *   import { defineConfig, defineTool } from "openapi-agentify";
 *   import { agentify } from "openapi-agentify/express";   // or /hono, /next, /fastify
 */
export { type AgentifyConfig, type AuthConfig, defineConfig, type SurfacesConfig } from "./config.js";
export { type Agentify, ambiguousPath, compilePath, createAgentify, type GuardResult, normalizePath, type RequestContext } from "./core.js";
export {
  type AfterToolCallResult,
  type AgentifyHooks,
  type AuthenticateInfo,
  type BeforeToolCallResult,
  composeHooks,
  type FinishInput,
  type FinishOutput,
  type RouteGuardResult,
  type RouteInfo,
  type SetupContext,
  type SurfaceExtension,
  type ToolCall,
  type ToolCallResult,
  type ToolListing,
  type ToolRefusal,
} from "./hooks.js";
export { type IdempotencyBegin, type IdempotencyStore, memoryIdempotencyStore, type StoredResponse } from "./idempotency.js";
export { buildOperationRequest, type Dispatcher, httpDispatcher, INTERNAL_HEADER } from "./dispatch.js";
export { defineTool, type ToolContext, type ToolDefinition, ToolError, type ToolOutput, ToolRegistry } from "./mcp/tools.js";
export { AppErrorCode, McpServer, requiredScope } from "./mcp/server.js";
export { anonymousPrincipal, bearerChallenge, credentialId, hasScope, type Principal } from "./principal.js";
export { type Manifest, type ManifestTool, mergeManifest, parseManifest, readManifest } from "./openapi/manifest.js";
export { importOpenApi } from "./openapi/convert.js";
export { fetchSpec, parseSpecText, readSpecFile } from "./openapi/load.js";
export { doc, type Doc, type SurfaceModel } from "./surfaces/model.js";
export { formatReport, readiness } from "./check/rules.js";
export { acceptAll, improve } from "./check/improve.js";
export { draftSpec } from "./draft/draft.js";
export { createLogger, type Logger } from "./util/log.js";
export { EventSampler } from "./util/sample.js";
export { AGENT_USER_AGENTS_UPDATED, DEFAULT_AGENT_USER_AGENTS, detectAgent, type Detection } from "./detect.js";
export { VERSION } from "./version.js";
