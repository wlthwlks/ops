import { describe, it, expect } from "vitest";
import { classifyRemovalReadiness } from "@/lib/ops/slack-removal";
import type { MemberHealthRow } from "@/lib/ops/member-health-types";
import { makeIssue } from "@/lib/ops/member-issue-classifier";

function row(partial: Partial<MemberHealthRow>): MemberHealthRow {
  return {
    airtableRecordId: "rec1",
    name: "Ada",
    primaryEmail: "ada@ex.com",
    slackEmail: "",
    city: "London",
    membership: "Cancelled",
    payment: "Unpaid",
    dateJoined: "",
    cancellationDate: "2026-01-01",
    serviceAccessUntil: "2026-01-15",
    hasCurrentServiceAccess: false,
    stripeCustomerId: "",
    stripeCustomerEmail: "",
    latestQualifyingPaidThrough: "",
    recurringIntroStatus: "",
    recurringPauseUntil: "",
    introPauseState: "active",
    stripeSubscriptionStatus: "",
    billingPauseUntil: "",
    activeSlackUserId: "U1",
    activeSlackEmail: "",
    activeSlackDisplayName: "Ada",
    slackIdentityState: "matched_primary_email",
    cityChannelId: "C1",
    cityChannelName: "london",
    cityChannelMembership: "member",
    allMembersChannelId: "Call",
    allMembersChannelMembership: "member",
    resolverConfidence: "high",
    issues: [makeIssue("EXPIRED_MEMBER_STILL_IN_SLACK_WORKSPACE")],
    highestSeverity: "high",
    recommendedNextAction: "Review",
    stripeOnly: false,
    ...partial,
  };
}

describe("classifyRemovalReadiness", () => {
  it("ready when expired with matched slack", () => {
    expect(classifyRemovalReadiness(row({}))).toBe("ready_for_review");
  });

  it("blocks when still has access", () => {
    expect(
      classifyRemovalReadiness(row({ hasCurrentServiceAccess: true }))
    ).toBe("still_has_access");
  });

  it("flags invalid access date", () => {
    expect(
      classifyRemovalReadiness(
        row({
          serviceAccessUntil: "bad",
          issues: [makeIssue("INVALID_SERVICE_ACCESS_DATE")],
        })
      )
    ).toBe("access_date_invalid");
  });

  it("flags unresolved slack identity", () => {
    expect(
      classifyRemovalReadiness(row({ slackIdentityState: "not_found" }))
    ).toBe("slack_identity_unresolved");
  });

  it("flags already deactivated", () => {
    expect(
      classifyRemovalReadiness(row({ slackIdentityState: "deactivated" }))
    ).toBe("already_deactivated");
  });
});
