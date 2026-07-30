import { describe, it, expect } from "vitest";
import {
  OVERVIEW_FUNNEL_TOOLTIPS,
  OVERVIEW_KPI_TOOLTIPS,
  OVERVIEW_SECTION_TOOLTIPS,
} from "@/lib/ops/overview-tooltips";

describe("overview tooltips", () => {
  it("defines every KPI tooltip", () => {
    const keys = [
      "serviceAccess",
      "fullyConnected",
      "payingMissingSlack",
      "payingStripeMissingAirtable",
      "missingStripeCustomerId",
      "criticalIssues",
      "channelGaps",
      "failedOps24h",
    ] as const;
    for (const k of keys) {
      expect(OVERVIEW_KPI_TOOLTIPS[k].length).toBeGreaterThan(40);
      expect(OVERVIEW_KPI_TOOLTIPS[k]).not.toMatch(/sk_live|pat[A-Za-z0-9]|xoxb-/);
    }
  });

  it("defines funnel stage tooltips", () => {
    for (const k of [
      "section",
      "serviceEligible",
      "inAirtable",
      "stripeLinked",
      "slackResolved",
      "fullyConnected",
    ] as const) {
      expect(OVERVIEW_FUNNEL_TOOLTIPS[k].length).toBeGreaterThan(20);
    }
  });

  it("integration health explains configured vs checked", () => {
    expect(OVERVIEW_SECTION_TOOLTIPS.integrationHealth.toLowerCase()).toContain(
      "configured"
    );
    expect(OVERVIEW_SECTION_TOOLTIPS.integrationHealth.toLowerCase()).toContain(
      "checked"
    );
  });
});
