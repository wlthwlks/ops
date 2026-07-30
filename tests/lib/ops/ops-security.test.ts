import { describe, it, expect } from "vitest";
import { registry } from "@/lib/registry-instance";

describe("ops registry security catalogue", () => {
  it("does not expose create-missing as a runnable dashboard op", () => {
    const all = registry.getAll();
    for (const op of all) {
      expect(op.slug).not.toMatch(/create-missing/i);
      if (op.commandEquivalent) {
        expect(op.commandEquivalent).not.toMatch(/--create-missing/);
      }
    }
  });

  it("marks donut tracker as deprecated", () => {
    const donut = registry.getBySlug("donut-tracker");
    expect(donut).toBeTruthy();
    expect(donut?.deprecated || donut?.riskLevel === "deprecated").toBe(true);
  });

  it("marks historical stripe repair as cli only", () => {
    const op = registry.getBySlug("airtable-historical-stripe-repair");
    expect(op?.cliOnly || op?.riskLevel === "cli_only").toBe(true);
  });

  it("includes safe diagnostic operations", () => {
    expect(registry.getBySlug("diag-airtable")).toBeTruthy();
    expect(registry.getBySlug("diag-slack")).toBeTruthy();
    expect(registry.getBySlug("diag-env")?.riskLevel).toBe("safe_read");
  });

  it("every op has a run function (no arbitrary shell)", () => {
    for (const op of registry.getAll()) {
      expect(typeof op.run).toBe("function");
    }
  });
});
