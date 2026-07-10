import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

/**
 * Tests run inside the REAL Cloudflare runtime (workerd) via vitest-pool-workers, with
 * miniflare-backed D1/R2/KV as the real data layer — Crucible's stand-in for
 * Testcontainers (ARCHITECTURE stack commitments; PORTFOLIO-V2 platform overrides:
 * "miniflare D1 IS the real database"). Bindings come from wrangler.toml.
 *
 * The real versioned migrations from ./migrations are injected as a binding and applied
 * to the test D1 in test/apply-migrations.ts before any test runs — so the suite exercises
 * the SAME schema that ships and a broken migration fails the suite (the migration check,
 * in-process). The pure stats module is tested as plain functions and needs no binding.
 */
const migrations = await readD1Migrations("./migrations");

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
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
