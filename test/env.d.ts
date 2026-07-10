/// <reference types="@cloudflare/vitest-pool-workers" />
import type { Env } from "../src/env";

declare module "cloudflare:test" {
  // The test env = the Worker's Env plus any fixtures/config injected in vitest.config.ts.
  // Phase 0 injects no extra bindings, so this is a bare re-declaration of Env; it gains
  // members (TEST_MIGRATIONS, etc.) when the D1 schema lands in Phase 1.1.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}
