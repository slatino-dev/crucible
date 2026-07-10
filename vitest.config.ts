import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Tests run inside the REAL Cloudflare runtime (workerd) via vitest-pool-workers, with
 * miniflare-backed D1/R2/KV as the real data layer — Crucible's stand-in for
 * Testcontainers (ARCHITECTURE stack commitments; PORTFOLIO-V2 platform overrides:
 * "miniflare D1 IS the real database"). Bindings come from wrangler.toml.
 *
 * SCAFFOLD STATE (Phase 0): no migrations yet. Once the D1 schema lands (Phase 1.1) this
 * config reads the real versioned migrations from ./migrations and applies them to the
 * test D1 in a setup file, so a broken migration fails the suite (the migration check,
 * in-process). The pure stats module (Phase 1.2) is tested as plain functions and needs
 * no runtime binding.
 */
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        miniflare: {
          bindings: {
            // [SECURITY/Opus] test-only: a real (non-secret) HMAC salt so salted-IP
            // hashing and cursor integrity run under test. NEVER in wrangler.toml.
            HASH_SALT: "test-hmac-salt-not-a-real-secret-0123456789",
          },
        },
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
