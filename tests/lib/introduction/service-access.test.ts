import { describe, it, expect } from "vitest";
import { checkServiceAccess, hasServiceAccess } from "@/lib/introduction/service-access";

describe("hasServiceAccess", () => {
  const ref = new Date("2026-07-25");

  it("Active + Paid is accessible", () => {
    expect(hasServiceAccess("Active", "Paid", null, ref)).toBe(true);
  });

  it("Inactive + Paid is not accessible without extension", () => {
    expect(hasServiceAccess("Inactive", "Paid", null, ref)).toBe(false);
  });

  it("Active + Unpaid is not accessible without extension", () => {
    expect(hasServiceAccess("Active", "Unpaid", null, ref)).toBe(false);
  });

  it("Inactive with future Service access until is accessible", () => {
    expect(hasServiceAccess("Inactive", "Unpaid", "2026-08-01", ref)).toBe(true);
  });

  it("Inactive with past Service access until is not accessible", () => {
    expect(hasServiceAccess("Inactive", "Unpaid", "2026-07-24", ref)).toBe(false);
  });

  it("Service access until today is accessible", () => {
    expect(hasServiceAccess("Inactive", "Unpaid", "2026-07-25", ref)).toBe(true);
  });

  it("Service access until exactly the reference date is accessible", () => {
    expect(hasServiceAccess("Inactive", "Unpaid", "2026-07-25", new Date("2026-07-25"))).toBe(true);
  });

  it("Service access until yesterday is not accessible", () => {
    expect(hasServiceAccess("Inactive", "Unpaid", "2026-07-24", new Date("2026-07-25"))).toBe(false);
  });
});

describe("checkServiceAccess", () => {
  it("returns accessible true for Active+Paid", () => {
    const r = checkServiceAccess("Active", "Paid", null, new Date());
    expect(r.accessible).toBe(true);
  });

  it("returns reason when Inactive and no extension", () => {
    const result = checkServiceAccess("Inactive", "Paid", null, new Date());
    expect(result.accessible).toBe(false);
    expect((result as { message: string }).message).toContain("Not paid");
  });

  it("returns reason when extension has expired", () => {
    const result = checkServiceAccess("Inactive", "Unpaid", "2020-01-01", new Date("2026-07-25"));
    expect(result.accessible).toBe(false);
    expect((result as { message: string }).message).toContain("expired");
  });
});

describe("cancel_at_period_end access preservation", () => {
  // cancel_at_period_end=true + Service access until future = member still has access
  it("Active+Paid+cancel_at_period_end with future access → has access", () => {
    expect(hasServiceAccess("Active", "Paid", "2026-11-01", new Date("2026-08-11"))).toBe(true);
  });

  it("Cancelled+cancel_at_period_end with future access → has access", () => {
    expect(hasServiceAccess("Cancelled", "Paid", "2026-11-01", new Date("2026-08-11"))).toBe(true);
  });

  it("Cancelled with past access until → no access", () => {
    expect(hasServiceAccess("Cancelled", "Unpaid", "2026-01-01", new Date("2026-08-11"))).toBe(false);
  });

  it("Past_due with future access → has access (legacy)", () => {
    expect(hasServiceAccess("Active", "Unpaid", "2026-11-01", new Date("2026-08-11"))).toBe(true);
  });
});
