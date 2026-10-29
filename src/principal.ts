import { createHash } from "node:crypto";

/**
 * Who is calling. Every request that reaches /mcp resolves to one principal.
 * Out of the box there are two:
 *
 *   anonymous    no credentials
 *   passthrough  credentials your API accepts; forwarded to your routes unread
 *
 * An `authenticate` hook (see `AgentifyHooks`) can return any other type, for
 * example your own API keys or OAuth tokens, with scopes and the headers the
 * in-process call carries to your routes.
 */
export interface Principal {
  /** "anonymous" and "passthrough" are built in; hooks may use their own names ("api-key", "oauth"…). */
  type: "anonymous" | "passthrough" | (string & {});
  /** Stable id for rate limits and usage: a key id, a token subject, a credential hash, an IP. */
  id: string;
  /** For logs and usage reports: a key's name, a token's client, or the id. */
  label: string;
  /** Scopes this caller holds. "*" means "your API decides" (passthrough, anonymous). */
  scopes: string[];
  /** Headers the in-process call carries to your routes (the credentials to forward). */
  forward: Record<string, string>;
  /**
   * List tools this caller lacks the scope for too, so that calling one answers
   * 403 with an `insufficient_scope` challenge to step up (OAuth clients).
   */
  stepUp?: boolean;
  /** Anything a hook wants to carry from `authenticate` to the tool-call hooks. */
  data?: Record<string, unknown>;
}

/** "api:read" is held with "api:read", "api:*" or "*". */
export const hasScope = (scopes: string[], needed: string) => scopes.includes("*") || scopes.includes(needed) || scopes.includes(`${needed.split(":")[0]}:*`);

/** A short, non-reversible id for a credential, so callers can be told apart without storing it. */
export const credentialId = (value: string) => `cred:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;

export function anonymousPrincipal(ip: string | null): Principal {
  const id = ip ? `ip:${ip}` : "anonymous";
  return { type: "anonymous", id, label: id, scopes: ["*"], forward: {} };
}

const quote = (v: string) => `"${v.replace(/["\\\r\n]/g, "")}"`;

/**
 * A `WWW-Authenticate: Bearer …` value (RFC 6750), with `resource_metadata`
 * (RFC 9728) when there is a protected-resource metadata URL to point at.
 */
export function bearerChallenge(
  resourceMetadataUrl: string | null,
  opts: { error?: "invalid_token" | "insufficient_scope"; scope?: string; description?: string } = {},
): string {
  const params = [`realm=${quote("agentify")}`];
  if (resourceMetadataUrl) params.push(`resource_metadata=${quote(resourceMetadataUrl)}`);
  if (opts.error) params.push(`error=${quote(opts.error)}`);
  if (opts.scope) params.push(`scope=${quote(opts.scope)}`);
  if (opts.description) params.push(`error_description=${quote(opts.description)}`);
  return `Bearer ${params.join(", ")}`;
}
