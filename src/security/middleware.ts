import { createMiddleware } from "hono/factory";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import type { Env } from "../env";
import * as schema from "../db/schema";
import { eq } from "drizzle-orm";
import { nowIso } from "../util/ids";
import { resolveHashSalt } from "./config";
import { saltedIpHash } from "./client-id";
import { verifyAdminKey } from "./admin-auth";
import { RATE_LIMITS } from "../harness/budget/config";

/**
 * [SECURITY/Opus] — inbound middleware: salted-IP + per-key rate limits and admin bearer
 * auth, both anchored on the BudgetLedger DO. The hardest limits sit on the auth +
 * run-trigger surfaces and apply from first deploy (not deferred to a later public-surface
 * pass). Uniform RFC 9457 problem+json; stack traces never leave the Worker.
 */
export type AppEnv = {
  Bindings: Env;
  Variables: { adminKeyHash?: string; adminScopes?: string[] };
};

function ledger(env: Env) {
  return env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName("global"));
}

function problem(c: Context, status: 401 | 413 | 429, code: string, detail: string): Response {
  c.header("Content-Type", "application/problem+json");
  return c.body(
    JSON.stringify({ type: `https://crucible.samlatino.dev/errors/${code}`, title: code, status, code, detail }),
    status,
  );
}

/** Per-salted-IP sliding-window rate limit for a named public surface (e.g. run-trigger). */
export function rateLimit(kind: keyof typeof RATE_LIMITS) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const salt = resolveHashSalt(c.env); // fail closed if unset
    const ipHash = await saltedIpHash(salt, c.req.header("CF-Connecting-IP"));
    const { limit, windowMs } = RATE_LIMITS[kind];
    const d = await ledger(c.env).rateCheck({ bucket: `${kind}:${ipHash}`, limit, windowMs });
    c.header("RateLimit-Limit", String(d.limit));
    c.header("RateLimit-Remaining", String(d.remaining));
    c.header("RateLimit-Reset", String(d.resetSeconds));
    if (!d.ok) {
      c.header("Retry-After", String(d.retryAfterSeconds));
      return problem(c, 429, "RateLimited", "request rate limit exceeded");
    }
    await next();
  });
}

/**
 * Admin bearer-auth gate. Rate-limits per salted IP AND per presented key id (hardest limits
 * on the auth surface — brute-force friction on both axes), then verifies the argon2id-hashed
 * key with uniform errors. On success stashes the actor's key hash + scopes for the handler
 * and best-effort updates last_used_at.
 */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const salt = resolveHashSalt(c.env);
  const ipHash = await saltedIpHash(salt, c.req.header("CF-Connecting-IP"));
  const authHeader = c.req.header("Authorization") ?? "";
  // Rate-limit BEFORE the (expensive) argon2 verify so an attacker cannot spin CPU.
  const ipRl = RATE_LIMITS.adminAuthPerIp;
  const ipDecision = await ledger(c.env).rateCheck({ bucket: `adminAuthIp:${ipHash}`, limit: ipRl.limit, windowMs: ipRl.windowMs });
  if (!ipDecision.ok) {
    c.header("Retry-After", String(ipDecision.retryAfterSeconds));
    return problem(c, 429, "RateLimited", "auth rate limit exceeded");
  }
  // Per-key-id limit (bucket on the presented id, if any) so one key cannot be hammered.
  const keyId = extractKeyId(authHeader);
  if (keyId) {
    const keyRl = RATE_LIMITS.adminAuthPerKey;
    const keyDecision = await ledger(c.env).rateCheck({ bucket: `adminAuthKey:${keyId}`, limit: keyRl.limit, windowMs: keyRl.windowMs });
    if (!keyDecision.ok) {
      c.header("Retry-After", String(keyDecision.retryAfterSeconds));
      return problem(c, 429, "RateLimited", "auth rate limit exceeded");
    }
  }

  const db = drizzle(c.env.DB, { schema });
  const auth = await verifyAdminKey(db, authHeader);
  if (!auth.ok) return problem(c, 401, "Unauthorized", "invalid credentials");

  c.set("adminKeyHash", auth.keyHash);
  c.set("adminScopes", auth.scopes);
  // Best-effort last_used_at bump. Use waitUntil when an execution context exists (prod),
  // else detach (tests) — never let a timestamp write fail the request.
  const bump = db.update(schema.apiKeys).set({ lastUsedAt: nowIso() }).where(eq(schema.apiKeys.id, auth.keyId!)).then(() => undefined).catch(() => undefined);
  try {
    c.executionCtx.waitUntil(bump);
  } catch {
    // No execution context (tests): await so the write completes before teardown rather
    // than dangling into storage isolation.
    await bump;
  }
  await next();
});

function extractKeyId(authHeader: string): string | null {
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  if (!bearer.startsWith("ck_")) return null;
  const rest = bearer.slice(3);
  const dot = rest.indexOf(".");
  return dot > 0 ? rest.slice(0, dot) : null;
}
