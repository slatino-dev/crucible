/// <reference types="@cloudflare/vitest-pool-workers" />
import type { Env } from "../src/env";
import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";

declare module "cloudflare:test" {
  // The test env = the Worker's Env plus fixtures/config injected in vitest.config.ts.
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
