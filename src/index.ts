import { Hono } from "hono";
import type { Env } from "./env";
import { SECURITY_HEADERS } from "./security/config";

/**
 * Crucible — public LLM evals arena with honest leaderboards (Cloudflare Worker, Hono).
 *
 * Phase 0 exposes `/healthz` only, wrapped in the site-wide [SECURITY/Opus] security
 * headers. The `/api/*` (run trigger, gate), `/badge/*`, `/methodology`, and SPA
 * surfaces land in later phases behind the full inbound stack (CORS · body cap ·
 * per-IP salted rate limits · admin bearer auth). The RunOrchestrator + BudgetLedger
 * Durable Objects are exported from this module once they land (Phase 1.3).
 */
type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();

// Site-wide security headers on every response (incl. /healthz and error bodies).
app.use("*", async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
});

app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    service: "crucible",
    version: "0.1.0",
    ts: new Date().toISOString(),
  }),
);

export default app;
