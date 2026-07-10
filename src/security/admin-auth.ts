import { argon2id } from "@noble/hashes/argon2";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";

/**
 * [SECURITY/Opus] — admin authoring auth (ARCHITECTURE "Security posture" / eval-harness.md).
 * Scoped bearer keys for CLI suite-publish / baseline-pin, hashed at rest with argon2id.
 * Uniform errors (no enumeration): an unknown key id and a wrong secret are indistinguishable,
 * and a dummy verify runs on the not-found path so timing does not leak existence.
 *
 * Key format presented by the client: `ck_<id>.<secret>`. The `<id>` is the api_keys row id
 * (indexed lookup — no full-table scan), the `<secret>` is high-entropy random. Only the
 * argon2id hash of the secret is stored; the plaintext never touches D1 or logs.
 *
 * FREE-TIER NOTE (documented tradeoff): argon2id is memory-hard and pure-JS here, so a verify
 * can exceed the 10ms free Worker CPU limit. Admin auth is a rare CLI path (not the hot
 * public surface), and Cloudflare allows brief CPU bursts, so this is acceptable for v1; the
 * params below are deliberately modest. Because the secret is high-entropy (not a human
 * password), the memory-hardness is defense-in-depth rather than the primary control. If the
 * CPU budget ever bites, the escalation is HMAC-SHA256 over the high-entropy secret (which is
 * cryptographically sufficient for 256-bit random keys) — recorded, not yet needed.
 */

const ARGON = { t: 2, m: 2048, p: 1, dkLen: 32 } as const; // m in KiB (2 MiB)

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** argon2id-hash a secret into a self-describing PHC-style string. */
export function hashSecret(secret: string): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = argon2id(secret, salt, ARGON);
  return `$argon2id$v=19$m=${ARGON.m},t=${ARGON.t},p=${ARGON.p}$${b64encode(salt)}$${b64encode(hash)}`;
}

/** Verify a secret against a PHC-style argon2id string (constant-time compare). */
export function verifySecret(secret: string, encoded: string): boolean {
  const parts = encoded.split("$"); // ["", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash]
  if (parts.length !== 6 || parts[1] !== "argon2id") return false;
  const params = Object.fromEntries(parts[3]!.split(",").map((kv) => kv.split("=")));
  const t = Number(params.t);
  const m = Number(params.m);
  const p = Number(params.p);
  if (!t || !m || !p) return false;
  const salt = b64decode(parts[4]!);
  const expected = b64decode(parts[5]!);
  const actual = argon2id(secret, salt, { t, m, p, dkLen: expected.length });
  return timingSafeEqual(actual, expected);
}

/**
 * A hash used only to equalize timing on the key-not-found path (no info leak). Computed
 * LAZILY on first use — never at module load, since hashSecret calls crypto.getRandomValues
 * which is disallowed in the Worker global scope.
 */
let _dummyHash: string | undefined;
function dummyHash(): string {
  if (_dummyHash === undefined) _dummyHash = hashSecret("dummy-secret-for-uniform-timing-only");
  return _dummyHash;
}

export interface AdminAuthResult {
  ok: boolean;
  /** The api_keys row id + its stored key hash (for audit-actor identity) when ok. */
  keyId?: string;
  keyHash?: string;
  scopes?: string[];
}

/**
 * Verify a presented `ck_<id>.<secret>` bearer key against the api_keys table. Returns a
 * uniform failure for a malformed key, an unknown id, a revoked key, or a wrong secret — and
 * always performs an argon2id verify (real or dummy) so timing does not distinguish them.
 */
export async function verifyAdminKey(
  db: DrizzleD1Database<typeof schema>,
  presented: string | null | undefined,
): Promise<AdminAuthResult> {
  const parsed = parseKey(presented);
  if (!parsed) {
    verifySecret("x", dummyHash()); // equalize timing
    return { ok: false };
  }
  const rows = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, parsed.id)).limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) {
    verifySecret(parsed.secret, dummyHash()); // equalize timing on not-found / revoked
    return { ok: false };
  }
  if (!verifySecret(parsed.secret, row.keyHash)) return { ok: false };
  return { ok: true, keyId: row.id, keyHash: row.keyHash, scopes: row.scopes };
}

function parseKey(presented: string | null | undefined): { id: string; secret: string } | null {
  if (!presented) return null;
  const bearer = presented.startsWith("Bearer ") ? presented.slice(7) : presented;
  if (!bearer.startsWith("ck_")) return null;
  const rest = bearer.slice(3);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  return { id: rest.slice(0, dot), secret: rest.slice(dot + 1) };
}
