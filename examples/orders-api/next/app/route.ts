import { wrap } from "../lib/agentify";

export const GET = wrap(async () => Response.json({ name: "Orders API", docs: "/llms.txt" }));
