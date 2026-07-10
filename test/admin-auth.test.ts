import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../src/db/schema";
import { hashSecret, verifySecret, verifyAdminKey } from "../src/security/admin-auth";
import { ulid, nowIso } from "../src/util/ids";
import app from "../src/index";

/**
 * [SECURITY/Opus] admin auth: argon2id hash/verify + the DB-backed bearer check with uniform
 * errors, and the guarded endpoint end-to-end (rate limit + 401 + 200).
 */
describe("admin-auth — argon2id hash/verify", () => {
  it("verifies the correct secret and rejects a wrong one", () => {
    const encoded = hashSecret("s3cret-high-entropy-value");
    expect(encoded.startsWith("$argon2id$")).toBe(true);
    expect(verifySecret("s3cret-high-entropy-value", encoded)).toBe(true);
    expect(verifySecret("wrong", encoded)).toBe(false);
  });

  it("produces a distinct salt each time (no static hashes)", () => {
    expect(hashSecret("same")).not.toBe(hashSecret("same"));
  });
});

async function seedKey(secret: string): Promise<string> {
  const db = drizzle(env.DB, { schema });
  const id = ulid();
  await db.insert(schema.apiKeys).values({
    id, keyHash: hashSecret(secret), label: "test", scopes: ["suite:publish"], createdAt: nowIso(),
  });
  return `ck_${id}.${secret}`;
}

describe("admin-auth — verifyAdminKey (uniform errors)", () => {
  it("accepts a valid key and returns its scopes", async () => {
    const db = drizzle(env.DB, { schema });
    const key = await seedKey("correct-horse-battery-staple-256bit");
    const r = await verifyAdminKey(db, `Bearer ${key}`);
    expect(r.ok).toBe(true);
    expect(r.scopes).toEqual(["suite:publish"]);
  });

  it("rejects an unknown key id, a malformed key, and a wrong secret identically", async () => {
    const db = drizzle(env.DB, { schema });
    const good = await seedKey("the-right-secret");
    const badSecret = good.replace("the-right-secret", "the-wrong-secret");
    expect((await verifyAdminKey(db, "Bearer ck_nonexistent.whatever")).ok).toBe(false);
    expect((await verifyAdminKey(db, "Bearer garbage")).ok).toBe(false);
    expect((await verifyAdminKey(db, `Bearer ${badSecret}`)).ok).toBe(false);
    expect((await verifyAdminKey(db, null)).ok).toBe(false);
  });

  it("rejects a revoked key", async () => {
    const db = drizzle(env.DB, { schema });
    const id = ulid();
    const secret = "revoked-key-secret";
    await db.insert(schema.apiKeys).values({
      id, keyHash: hashSecret(secret), label: "revoked", scopes: [], createdAt: nowIso(), revokedAt: nowIso(),
    });
    expect((await verifyAdminKey(db, `Bearer ck_${id}.${secret}`)).ok).toBe(false);
  });
});

describe("admin endpoint — guarded surface end to end", () => {
  it("401s without a valid key and 200s with one", async () => {
    const key = await seedKey("endpoint-secret-256-bit-value-xyz");
    const noAuth = await app.request("/api/admin/ping", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.7" } }, env);
    expect(noAuth.status).toBe(401);

    const ok = await app.request(
      "/api/admin/ping",
      { method: "POST", headers: { Authorization: `Bearer ${key}`, "CF-Connecting-IP": "203.0.113.8" } },
      env,
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { scopes: string[] };
    expect(body.scopes).toEqual(["suite:publish"]);
  });
});

describe("run-trigger — per-IP rate limit from first deploy", () => {
  it("admits up to the limit then 429s the same IP", async () => {
    const ip = "198.51.100.42";
    const results: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await app.request("/api/run", { method: "POST", headers: { "CF-Connecting-IP": ip } }, env);
      results.push(res.status);
    }
    // First 5 accepted (202), the rest rate-limited (429). RATE_LIMITS.runTrigger.limit = 5.
    expect(results.filter((s) => s === 202).length).toBe(5);
    expect(results.filter((s) => s === 429).length).toBe(2);
  });
});
