import type { Agentify, AgentifyConfig } from "openapi-agentify";
import { agentifyNext } from "openapi-agentify/next";
import config from "../agentify.config";
import { routes } from "../agentify.routes";

// One Agentify per process. Route files call wrap() and the catch-all calls
// surfaces(), both late-bound so tests can swap the config with useAgentify().
let current = agentifyNext(config, { routes });

export function useAgentify(c: AgentifyConfig | Agentify) {
  current = agentifyNext(c, { routes });
  return current;
}

export const agentify = () => current;

type Handler<C> = (req: Request, ctx: C) => Response | Promise<Response>;

/** Wraps a route handler with Agentify's guard (detection, idempotency, the guardRoute hook). */
export function wrap<C extends { params: Promise<any> }>(handler: Handler<C>): Handler<C> {
  return (req, ctx) => current.wrap(handler)(req, ctx);
}

/** For app/[...agentify]/route.ts. */
export const surfaces = (req: Request) => current.routes.GET(req);
