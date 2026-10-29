// Where tool calls go: each App Router route, loaded when first called.
// `agentify init` writes this file from app/**/route.ts; add routes you create.
export const routes = {
  "/": () => import("./app/route"),
  "/health": () => import("./app/health/route"),
  "/internal/audit": () => import("./app/internal/audit/route"),
  "/v1/orders": () => import("./app/v1/orders/route"),
  "/v1/orders/[id]": () => import("./app/v1/orders/[id]/route"),
  "/v1/orders/[id]/refund": () => import("./app/v1/orders/[id]/refund/route"),
  "/v1/reports/sales": () => import("./app/v1/reports/sales/route"),
};
