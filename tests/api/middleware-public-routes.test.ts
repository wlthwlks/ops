import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

describe("auth edge entry public routes", () => {
  it("excludes Stripe webhook from Clerk protection", () => {
    const middlewarePath = join(process.cwd(), "src/middleware.ts");
    const proxyPath = join(process.cwd(), "src/proxy.ts");
    // Next 16 deprecates middleware→proxy; either file is valid as the edge entry.
    const path = existsSync(proxyPath)
      ? proxyPath
      : existsSync(middlewarePath)
        ? middlewarePath
        : "";
    expect(path).not.toBe("");
    const src = readFileSync(path, "utf8");
    expect(src).toContain("/api/health");
    expect(src).toContain("/api/webhooks/stripe");
    expect(src).toContain("/api/webhooks/memberstack");
    expect(src).toContain("/api/onboarding");
    expect(src).toContain("/api/member");
    expect(src).toContain("/api/reference-data");
    expect(src).toContain("/api/forms");
    expect(src).toContain("/api/cron");
  });
});

