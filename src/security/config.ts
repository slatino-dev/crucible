/**
 * [SECURITY/Opus] — security-posture constants (ARCHITECTURE "Security posture").
 *
 * Every value here is a security control's tuning knob. Production defaults are baked
 * in; the HMAC salt is the one true secret and is NEVER defaulted (see resolveHashSalt):
 * a missing salt fails closed. Rate-limit / budget knobs land with the BudgetLedger DO
 * (Phase 1.3); this Phase-0 file carries the site-wide headers and the salt resolver.
 */
import { z } from "zod";
import type { Env } from "../env";

/**
 * Site-wide security headers (ARCHITECTURE "Render-boundary hardening"). Conservative
 * defaults for a JSON API with no first-party browser origin yet. The SPA + embeddable
 * badge (Phase 2) layer their own CSP: a nonce/hash script policy on the app surface and
 * a scoped `frame-ancestors` for the badge. Until then `default-src 'none'` is correct
 * for every response and `frame-ancestors 'none'` blocks clickjacking on the API.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  // Harmless over plain HTTP (local dev); meaningful once served over HTTPS.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
});

/**
 * The HMAC salt for salted-IP hashing + cursor/badge integrity (ARCHITECTURE
 * "Security posture" + "Secrets"). A real Worker secret in production
 * (`wrangler secret put HASH_SALT`); a local value in `.dev.vars`. There is NO default:
 * a missing salt is a misconfiguration and MUST fail closed rather than silently hashing
 * with an empty/guessable salt.
 */
const saltSchema = z.string().trim().min(16, "HASH_SALT must be >=16 chars of entropy");
export function resolveHashSalt(env: Env): string {
  return saltSchema.parse(env.HASH_SALT);
}
