/**
 * Agent detection on your own routes. A request is "agent" traffic when it
 * came through /mcp (in-process calls are marked), names a known AI agent in
 * User-Agent, or carries Web Bot Auth headers (`Signature-Agent`; recorded,
 * not verified).
 *
 * User agents are a hint, not an identity: anyone can send one. Detection
 * decides what counts as agent traffic (Idempotency-Key handling, what a
 * `guardRoute` hook sees); it never grants access.
 */

/** The date of the list below. Extend it with `detect.userAgents` as new agents appear. */
export const AGENT_USER_AGENTS_UPDATED = "2026-09-29";

/**
 * Product tokens of AI agents and AI fetchers, matched case-insensitively as
 * whole tokens. Deliberately short: search crawlers (Googlebot, Bingbot) are
 * not agents, and generic HTTP clients (curl, python-requests) are left out
 * because people use them too.
 */
export const DEFAULT_AGENT_USER_AGENTS = [
  // Anthropic
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  // OpenAI
  "ChatGPT-User",
  "OAI-SearchBot",
  "GPTBot",
  // Perplexity
  "PerplexityBot",
  "Perplexity-User",
  // Others
  "MistralAI-User",
  "DuckAssistBot",
  "meta-externalagent",
  "Meta-ExternalFetcher",
  "cohere-ai",
  "YouBot",
  "Amazonbot",
  // Agentify's own CLI (`agentify check --url`)
  "agentify",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function userAgentMatcher(list: "default" | string[] | false | undefined): (ua: string) => string | null {
  if (list === false) return () => null;
  const tokens = list === undefined || list === "default" ? DEFAULT_AGENT_USER_AGENTS : list;
  if (tokens.length === 0) return () => null;
  // A token must stand alone: "Operator" matches "Operator/1.0", not "CooperatorBrowser".
  const re = new RegExp(`(?:^|[\\s;(/,])(${tokens.map(escape).join("|")})(?=$|[\\s;)/,])`, "i");
  return (ua) => {
    const m = re.exec(ua);
    if (!m) return null;
    const hit = m[1]!.toLowerCase();
    return tokens.find((t) => t.toLowerCase() === hit) ?? m[1]!;
  };
}

export interface Detection {
  agent: boolean;
  via: "user-agent" | "signature" | null;
  /** The agent's name when known (the user-agent token or the Signature-Agent value). */
  name: string | null;
  signatureAgent: string | null;
}

export function detectAgent(headers: Headers, matchUa: (ua: string) => string | null): Detection {
  const sigAgent = headers.get("signature-agent");
  if (sigAgent || (headers.get("signature-input") && headers.get("signature"))) {
    const name = sigAgent ? sigAgent.replace(/^"|"$/g, "").slice(0, 200) : null;
    return { agent: true, via: "signature", name: name ?? matchUa(headers.get("user-agent") ?? ""), signatureAgent: name };
  }
  const hit = matchUa(headers.get("user-agent") ?? "");
  if (hit) return { agent: true, via: "user-agent", name: hit, signatureAgent: null };
  return { agent: false, via: null, name: null, signatureAgent: null };
}

/** "/v1/*" style globs: `*` is any run of characters (including "/"). */
export function pathMatcher(include: string[] | undefined, exclude: string[] | undefined): (path: string) => boolean {
  // Case-insensitive, like the most permissive router: a path that is in scope for one spelling is in scope for all.
  const compile = (globs: string[]) => globs.map((g) => new RegExp(`^${g.split("*").map(escape).join(".*")}$`, "i"));
  const inc = include?.length ? compile(include) : null;
  const exc = exclude?.length ? compile(exclude) : [];
  return (path) => (!inc || inc.some((r) => r.test(path))) && !exc.some((r) => r.test(path));
}
