import { Hono } from "hono";
import { SECURITY_HEADERS } from "./security/config";
import { rateLimit, requireAdmin, type AppEnv } from "./security/middleware";

/**
 * Crucible — public LLM evals arena with honest leaderboards (Cloudflare Worker, Hono).
 *
 * Surfaces so far: `/healthz`, a rate-limited public run-trigger stub, and an
 * admin-bearer-guarded endpoint — the [SECURITY/Opus] auth + rate limits are wired from
 * first deploy (not deferred). The full spotlight SSE run, gate API, badges, /methodology,
 * and SPA land in later phases. Durable Objects are exported at the bottom of this module.
 */
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

// ─── Public run-trigger (rate-limited per salted IP from first deploy) ───────────────
// The spotlight live-run's full SSE + BudgetLedger reservation wiring lands in Phase 2;
// this stub proves the [SECURITY/Opus] per-IP rate limit is enforced on the trigger surface.
app.post("/api/run", rateLimit("runTrigger"), (c) =>
  c.json({ status: "accepted", note: "spotlight run wiring lands in Phase 2" }, 202),
);

// ─── Admin authoring surface (argon2id bearer key + hardest rate limits) ─────────────
app.post("/api/admin/ping", requireAdmin, (c) =>
  c.json({ status: "ok", scopes: c.get("adminScopes") ?? [] }),
);

// Durable Objects must be exported from the Worker's main module.
export { BudgetLedger } from "./harness/budget/ledger";
export { RunOrchestrator } from "./harness/orchestrator/run";

export default app;
