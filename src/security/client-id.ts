/**
 * [SECURITY/Opus] — caller identification for the BudgetLedger (ARCHITECTURE "Security
 * posture"). Two derived, non-PII values:
 *   - callerBucket(ip): the per-IP counting key for rate limits. IPv6 reduced to /64 so a
 *     single host cannot rotate addresses within its own block to multiply its budget.
 *   - saltedIpHash(salt, ip): a keyed, non-reversible HMAC of the bucket — what actually
 *     keys the per-visitor daily slice, so no raw IP is ever stored or logged.
 *   - visitor cookie: a signed opaque token (HMAC) so a returning visitor keeps one budget
 *     identity across a session without us storing anything about them.
 *
 * The salted IP hash is the abuse-resistant identity; the signed cookie is a convenience
 * that a determined actor can drop (then they fall back to the salted-IP slice). Both are
 * cheap to compute and hold zero PII.
 */
import { hmacHex, timingSafeEqualHex } from "../util/ids";

/** Bucket a client address into the per-IP counting key (/64 for IPv6, whole for IPv4). */
export function callerBucket(ip: string | null | undefined): string {
  if (!ip) return "ip:unknown";
  const addr = ip.trim();
  if (addr.includes(":")) {
    const groups = expandIpv6(addr);
    if (groups) return `ip6:${groups.slice(0, 4).join(":")}::/64`;
    return `ip6:${addr}`;
  }
  return `ip4:${addr}`;
}

function expandIpv6(addr: string): string[] | null {
  const bare = addr.replace(/^\[|\]$/g, "").split("%")[0]!;
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0]!.split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1]!.split(":") : [];
  if (halves.length === 1) return head.length === 8 ? head.map(norm) : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array<string>(missing).fill("0"), ...tail].map(norm);
}
function norm(h: string): string {
  return (h || "0").toLowerCase().replace(/^0+(?=.)/, "");
}

/** Keyed, non-reversible salted hash of the per-IP bucket — the stored/counted identity. */
export async function saltedIpHash(salt: string, ip: string | null | undefined): Promise<string> {
  return hmacHex(salt, `ipslice:${callerBucket(ip)}`);
}

/**
 * Mint a signed visitor token: `${nonce}.${hmac(salt, nonce)}`. Opaque and self-verifying —
 * we store nothing. `nonce` is a ULID-like random hex so it is unguessable.
 */
export async function mintVisitorToken(salt: string, nonce: string): Promise<string> {
  const sig = await hmacHex(salt, `visitor:${nonce}`);
  return `${nonce}.${sig}`;
}

/** Verify a signed visitor token; returns the nonce if the signature holds, else null. */
export async function verifyVisitorToken(salt: string, token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const nonce = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacHex(salt, `visitor:${nonce}`);
  return timingSafeEqualHex(sig, expected) ? nonce : null;
}

/**
 * Resolve the per-visitor budget key: prefer a valid signed cookie nonce (bound to the
 * salt), else fall back to the salted IP hash. Combining both means a returning visitor
 * with a cookie keeps one slice, while a cookie-dropping actor still collapses onto their
 * salted-IP slice (so rotation is bounded by /64).
 */
export async function visitorBudgetKey(
  salt: string,
  cookieToken: string | null | undefined,
  ip: string | null | undefined,
): Promise<string> {
  const nonce = await verifyVisitorToken(salt, cookieToken);
  if (nonce) return `v:${await hmacHex(salt, `visitor:${nonce}`)}`;
  return `ip:${await saltedIpHash(salt, ip)}`;
}
