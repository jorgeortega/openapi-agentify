import { MODERN_VERSIONS, LEGACY_VERSIONS } from "../mcp/protocol.js";
import { doc, type Doc, exampleArguments, type SurfaceModel } from "./model.js";

/**
 * GET /llms.txt and /llms-full.txt, in the llmstxt.org format (checked
 * 2026-09-29): an H1 with the name, a blockquote summary, plain sections, then
 * H2 sections of link lists (`- [name](url): notes`), with secondary links
 * under "## Optional".
 *
 * llms-full.txt isn't in the llmstxt.org text; it's the common convention for
 * "everything in one file": the same header, then every operation with its
 * parameters and schemas.
 */

export function authInstructions(m: SurfaceModel): string[] {
  const a = m.auth;
  if (a.instructions?.length) return a.instructions;
  const lines: string[] = [];
  lines.push(
    `Send the credentials this API already accepts${a.headers.length ? ` (${a.headers.map((h) => `\`${h}\``).join(", ")})` : ""} with your MCP requests; tool calls pass them to the API, and the API decides.`,
  );
  if (a.anonymous === "deny") lines.push("Requests without credentials are refused.");
  return lines;
}

function header(m: SurfaceModel): string[] {
  return [
    `# ${m.name}`,
    "",
    `> ${m.description.replace(/\s+/g, " ").trim()}`,
    "",
    `Agents can call this API over MCP at ${m.mcpUrl} (Streamable HTTP; protocol versions ${[...MODERN_VERSIONS, ...LEGACY_VERSIONS].join(", ")}), with one tool per operation below, or over plain HTTP.`,
    "",
    ...authInstructions(m),
    ...(m.notes.length ? ["", ...m.notes] : []),
    "",
  ];
}

const oneLine = (s: string, max = 300) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function exampleCall(entry: SurfaceModel["tools"][number]): string {
  const args = exampleArguments(entry.op, entry.def.inputSchema as Record<string, any>);
  return `\`${entry.def.name}(${JSON.stringify(args)})\``;
}

export function llmsTxt(m: SurfaceModel): Doc {
  const ops = m.tools.map((t) => {
    const url = t.op ? `${m.origin}${t.op.path}` : m.mcpUrl;
    const price = m.showPrices && t.def.price ? ` Price: $${t.def.price} per call.` : "";
    const how = t.op ? `\`${t.op.method} ${t.op.path}\`, MCP tool \`${t.def.name}\`` : `MCP tool \`${t.def.name}\``;
    return `- [${t.def.title ?? t.def.name}](${url}): ${how}. ${oneLine(t.def.description)}${price} Example: ${exampleCall(t)}`;
  });
  const optional = [
    m.links.openapi && `- [OpenAPI spec](${m.links.openapi}): every operation with its schemas`,
    m.links.llmsFullTxt && `- [llms-full.txt](${m.links.llmsFullTxt}): this file plus parameters and schemas`,
    m.links.agentIndex && `- [Agent index](${m.links.agentIndex}): every agent-facing URL as JSON`,
    ...m.extraLinks.filter((l) => l.section !== "mcp").map((l) => `- [${l.title}](${l.url})${l.notes ? `: ${l.notes}` : ""}`),
  ].filter(Boolean) as string[];
  const lines = [
    ...header(m),
    "## MCP",
    "",
    `- [MCP endpoint](${m.mcpUrl}): Streamable HTTP, JSON responses, stateless; POST JSON-RPC here`,
    ...(m.links.serverCard ? [`- [MCP server card](${m.links.serverCard}): identity, transport and protocol versions`] : []),
    ...m.extraLinks.filter((l) => l.section === "mcp").map((l) => `- [${l.title}](${l.url})${l.notes ? `: ${l.notes}` : ""}`),
    "",
    "## Operations",
    "",
    ...(ops.length ? ops : ["- [No operations are enabled yet](" + m.mcpUrl + "): tools/list is empty"]),
    "",
    ...(optional.length ? ["## Optional", "", ...optional, ""] : []),
  ];
  return doc(lines.join("\n"), "text/markdown; charset=utf-8");
}

export function llmsFullTxt(m: SurfaceModel): Doc {
  const sections = m.tools.flatMap((t) => {
    const op = t.op;
    const lines = [`## ${t.def.title ?? t.def.name}`, ""];
    lines.push(op ? `\`${op.method} ${m.origin}${op.path}\` · MCP tool \`${t.def.name}\`` : `MCP tool \`${t.def.name}\` (not an HTTP route)`);
    if (m.showPrices && t.def.price) lines.push("", `Price: $${t.def.price} per call.`);
    const ann = t.def.annotations;
    if (ann) lines.push("", `Read-only: ${ann.readOnlyHint ? "yes" : "no"}. Destructive: ${ann.destructiveHint ? "yes" : "no"}. Idempotent: ${ann.idempotentHint ? "yes" : "no"}.`);
    lines.push("", t.def.description.trim(), "");
    const props = (t.def.inputSchema.properties ?? {}) as Record<string, any>;
    const required = new Set((t.def.inputSchema.required as string[] | undefined) ?? []);
    if (Object.keys(props).length) {
      lines.push("Parameters:", "");
      for (const [name, s] of Object.entries(props)) {
        const where = op?.params.find((p) => p.arg === name)?.in ?? (op?.body?.arg === name ? "body" : "argument");
        const desc = op?.suggestions?.accepted ? (op.suggestions.params?.[name] ?? s?.description) : s?.description;
        lines.push(`- \`${name}\` (${where}${required.has(name) ? ", required" : ""}${s?.type ? `, ${Array.isArray(s.type) ? s.type.join("|") : s.type}` : ""})${desc ? `: ${oneLine(String(desc), 400)}` : ""}`);
      }
      lines.push("");
    }
    lines.push("Input schema:", "", "```json", JSON.stringify(t.def.inputSchema, null, 2), "```", "", `Example: ${exampleCall(t)}`, "");
    return lines;
  });
  return doc([...header(m), ...sections].join("\n"), "text/markdown; charset=utf-8");
}
