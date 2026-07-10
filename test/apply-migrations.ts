import { applyD1Migrations, env } from "cloudflare:test";

// Apply the real versioned migrations to the test D1 before any test runs. This is the
// in-process migration check: if the migrations don't apply cleanly, the whole suite fails.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
