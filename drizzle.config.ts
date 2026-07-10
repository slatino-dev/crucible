import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config. `generate` emits versioned SQL into ./migrations, which
 * `wrangler d1 migrations apply` then applies. We NEVER use `drizzle-kit push`
 * (ARCHITECTURE anti-list: no db push).
 */
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
