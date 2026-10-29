import { LEGACY_VERSIONS, MODERN_VERSIONS } from "../mcp/protocol.js";
import { authInstructions } from "./llms-txt.js";
import { doc, type Doc, type SurfaceModel } from "./model.js";

/**
 * GET /agent: one index of every agent-facing URL, so an agent that finds one
 * URL finds everything. JSON by default; a small HTML page for people
 * (Accept: text/html). Agentify's own format.
 */

export const AGENT_INDEX_PATH = "/agent";

export function agentIndex(m: SurfaceModel): Record<string, unknown> {
  const drop = (o: Record<string, string | null>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
  return {
    name: m.name,
    description: m.description,
    version: m.version,
    mcp: {
      url: m.mcpUrl,
      transport: "streamable-http",
      protocolVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
      tools: m.tools.length,
    },
    auth: {
      mode: m.auth.mode,
      how: authInstructions(m).join(" "),
      ...(m.auth.headers.length ? { headers: m.auth.headers } : {}),
      ...(m.auth.resourceMetadataUrl ? { resourceMetadata: m.auth.resourceMetadataUrl } : {}),
    },
    discovery: drop({
      openapi: m.links.openapi,
      openapiYaml: m.links.openapiYaml,
      llmsTxt: m.links.llmsTxt,
      llmsFullTxt: m.links.llmsFullTxt,
      serverCard: m.links.serverCard,
      aiCatalog: m.links.aiCatalog,
      ...Object.fromEntries(m.extraLinks.map((l) => [l.key, l.url])),
    }),
    ...m.extensions,
    generator: "openapi-agentify",
  };
}

/** Accept picks JSON or HTML at one URL: say so, or a shared cache hands the page to an agent. */
const byAccept = (d: Doc): Doc => ({ ...d, vary: "Accept" });

export function agentIndexDoc(m: SurfaceModel): Doc {
  return byAccept(doc(JSON.stringify(agentIndex(m), null, 2), "application/json"));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function agentIndexHtml(m: SurfaceModel): Doc {
  const links = Object.entries(agentIndex(m).discovery as Record<string, string>)
    .map(([k, v]) => `<li><a href="${esc(v)}">${esc(k)}</a> <code>${esc(v)}</code></li>`)
    .join("\n      ");
  const tools = m.tools
    .map((t) => `<li><code>${esc(t.def.name)}</code>${t.op ? ` <small>${esc(t.op.method)} ${esc(t.op.path)}</small>` : ""}${m.showPrices && t.def.price ? ` <strong>$${esc(t.def.price)}</strong>` : ""}<br>${esc(t.def.description.split("\n")[0]!)}</li>`)
    .join("\n      ");
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(m.name)}: for agents</title>
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #1b1b1b; background: #fff; }
      code { background: #f2f2f2; padding: 0 .25rem; border-radius: 3px; }
      li { margin: .4rem 0; }
      @media (prefers-color-scheme: dark) { body { color: #eee; background: #111; } code { background: #222; } a { color: #8ab4ff; } }
    </style>
  </head>
  <body>
    <h1>${esc(m.name)}</h1>
    <p>${esc(m.description)}</p>
    <h2>Connect an agent</h2>
    <p>MCP endpoint: <code>${esc(m.mcpUrl)}</code> (Streamable HTTP).</p>
    <p>${esc(authInstructions(m).join(" "))}</p>
    <h2>Discovery</h2>
    <ul>
      ${links}
    </ul>
    <h2>Tools (${m.tools.length})</h2>
    <ul>
      ${tools}
    </ul>
  </body>
</html>
`;
  return byAccept(doc(body, "text/html; charset=utf-8", 300, false));
}
