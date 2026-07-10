import { describe, it, expect } from "vitest";
import app from "../src/index";

/**
 * Smoke test: the Worker boots and /healthz responds, exercised inside the real
 * workerd runtime (vitest-pool-workers). This is the "app boots" green baseline
 * the Phase 0 gate requires.
 */
describe("crucible worker boot", () => {
  it("responds to GET /healthz with ok JSON", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("crucible");
  });

  it("emits site-wide security headers on every response", async () => {
    const res = await app.request("/healthz");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("returns 404 for an unmounted route", async () => {
    const res = await app.request("/no-such-route");
    expect(res.status).toBe(404);
  });
});
