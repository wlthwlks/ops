import { describe, it, expect } from "vitest";
import { ISSUE_CATEGORY_HELP } from "@/lib/ops/issue-category-help";
import { MEMBER_COLUMN_HELP } from "@/components/ops/TableColumnHelp";

describe("issue category and column help", () => {
  it("has help for every category tab", () => {
    for (const key of [
      "all",
      "critical",
      "billing",
      "slack",
      "channel",
      "identity",
      "service_access",
    ]) {
      expect(ISSUE_CATEGORY_HELP[key]?.length).toBeGreaterThan(10);
    }
  });

  it("has column help for directory columns", () => {
    expect(MEMBER_COLUMN_HELP.access).toMatch(/hasServiceAccess/);
    expect(MEMBER_COLUMN_HELP.stripe).toMatch(/Stripe Customer ID/);
    expect(MEMBER_COLUMN_HELP.slack).toMatch(/identity/i);
    expect(MEMBER_COLUMN_HELP.severity).toMatch(/Critical/i);
    expect(MEMBER_COLUMN_HELP.nextAction).toMatch(/guidance/i);
  });
});
