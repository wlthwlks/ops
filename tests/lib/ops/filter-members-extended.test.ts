import { describe, it, expect } from "vitest";
import {
  buildMemberFilterOptions,
  filterMembers,
} from "@/lib/ops/member-health";
import type { MemberHealthRow } from "@/lib/ops/member-health-types";
import { makeIssue } from "@/lib/ops/member-issue-classifier";

function row(partial: Partial<MemberHealthRow>): MemberHealthRow {
  return {
    airtableRecordId: "rec1",
    name: "Ada",
    primaryEmail: "ada@ex.com",
    slackEmail: "",
    city: "London",
    membership: "Active",
    payment: "Paid",
    dateJoined: "2025-01-01",
    cancellationDate: "",
    serviceAccessUntil: "",
    hasCurrentServiceAccess: true,
    stripeCustomerId: "cus_1",
    stripeCustomerEmail: "",
    latestQualifyingPaidThrough: "",
    activeSlackUserId: "U1",
    activeSlackEmail: "ada@ex.com",
    activeSlackDisplayName: "Ada",
    slackIdentityState: "matched_primary_email",
    cityChannelId: "C1",
    cityChannelName: "london",
    cityChannelMembership: "member",
    allMembersChannelId: "Call",
    allMembersChannelMembership: "member",
    resolverConfidence: "high",
    issues: [],
    highestSeverity: null,
    recommendedNextAction: "No action",
    stripeOnly: false,
    ...partial,
  };
}

describe("filterMembers extended", () => {
  const members = [
    row({ airtableRecordId: "a", city: "London", name: "A" }),
    row({
      airtableRecordId: "b",
      city: "Paris",
      name: "B",
      hasCurrentServiceAccess: false,
      membership: "Cancelled",
      payment: "Unpaid",
      serviceAccessUntil: "2020-01-01",
      issues: [makeIssue("EXPIRED_MEMBER_STILL_IN_SLACK_WORKSPACE")],
      highestSeverity: "high",
    }),
    row({
      airtableRecordId: "c",
      city: "London",
      name: "C",
      highestSeverity: "critical",
      issues: [makeIssue("DUPLICATE_AIRTABLE_EMAIL")],
    }),
  ];

  it("filters expired still in slack", () => {
    const r = filterMembers(members, { expiredStillInSlack: true });
    expect(r).toHaveLength(1);
    expect(r[0].airtableRecordId).toBe("b");
  });

  it("filters critical issues", () => {
    const r = filterMembers(members, { criticalIssues: true });
    expect(r).toHaveLength(1);
    expect(r[0].airtableRecordId).toBe("c");
  });

  it("filter options include all cities not just a page", () => {
    const opts = buildMemberFilterOptions(members);
    expect(opts.cities).toEqual(["London", "Paris"]);
  });

  it("city filter is exact case-insensitive", () => {
    const r = filterMembers(members, { city: "london" });
    expect(r.every((m) => m.city.toLowerCase() === "london")).toBe(true);
    expect(r).toHaveLength(2);
  });
});
