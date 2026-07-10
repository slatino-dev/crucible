/**
 * ULID (ARCHITECTURE invariant: all IDs ULID) + content hashing (fingerprints,
 * suite content hashes, judge-config hashes).
 *
 * ULID = 48-bit millisecond timestamp + 80 bits of randomness, Crockford base32 —
 * lexicographically sortable by creation time, which suits time-ordered tables
 * (runs, audit_log, regressions). Uses `crypto.getRandomValues` (workerd + Node >= 19).
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32]! + ts;
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  let r = "";
  let acc = 0;
  let bits = 0;
  for (const b of rand) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      r += CROCKFORD[(acc >> bits) & 31];
    }
  }
  return ts + r.slice(0, 16);
}

/** Current instant as a UTC ISO-8601 string (ARCHITECTURE invariant: times UTC ISO-8601). */
export function nowIso(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

/**
 * Deterministic SHA-256 hex of a canonicalized value. Object keys are sorted recursively
 * so the hash is stable regardless of key order — the primitive behind `content_hash`
 * (suite versions), `fingerprint` (target = model_id + params), and `judge_config_hash`.
 * Immutability of these entities is enforced by pinning runs to the hash, so the hash MUST
 * be order-independent or two logically-identical configs would diverge.
 */
export async function canonicalHash(value: unknown): Promise<string> {
  const canonical = canonicalize(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable JSON: object keys sorted recursively; arrays keep order (order is significant). */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/**
 * Keyed HMAC-SHA256 of `msg` as lowercase hex — the general signing primitive
 * (salted-IP hashing in the BudgetLedger, opaque cursor/badge integrity). Never store
 * the message, only this digest.
 */
export async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time equality for two equal-length hex strings. Short-circuits ONLY on a
 * length mismatch (safe: our signatures are fixed 64-hex); otherwise compares every
 * character so a forged signature cannot be probed byte-by-byte via timing.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
