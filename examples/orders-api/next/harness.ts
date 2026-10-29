import { compileNextRoute, nextDispatcher } from "openapi-agentify/next";
import { routes } from "./agentify.routes";
import { surfaces } from "./lib/agentify";

/**
 * A stand-in for `next start` in tests and demos: routes requests the
 * way the App Router does for route handlers (your app/…/route.ts first, the
 * [...agentify] catch-all last) and calls the same exported functions. To
 * run the real thing: `npx next dev` in this folder.
 */
export function nextFetch() {
  const matchers = Object.keys(routes).map((p) => compileNextRoute(p).re);
  const dispatch = nextDispatcher(routes);
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (matchers.some((re) => re.test(path))) return dispatch(request, { remoteAddress: null });
    return surfaces(request);
  };
}
