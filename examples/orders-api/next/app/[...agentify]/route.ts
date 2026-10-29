import { surfaces } from "../../lib/agentify";

// Agentify's surfaces: /mcp, /llms.txt, /openapi.json, /agent, /.well-known/… .
// Your own routes (app/v1/…) match first; everything else 404s here.
export const GET = surfaces;
export const HEAD = surfaces;
export const POST = surfaces;
export const OPTIONS = surfaces;
export const DELETE = surfaces;
