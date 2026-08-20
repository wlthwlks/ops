import { describe, it, expect } from "vitest";
import {
  classifyMemberHealth,
  makeIssue,
} from "@/lib/ops/member-issue-classifier";

const base = {
  airtableRecordId: "rec1",
  name: "Ada",
  primaryEmail: "ada@ex.com",
  slackEmail: "",
  city: "London",
  membership: "Active",
  payment: "Paid",
  serviceAccessUntil: "",
  stripeCustomerId: "cus_1",
  airtableEmailCount: 1,
  stripeIdAirtableCount: 1,
  slackIdentityState: "matched_primary_email" as const,
  cityChannelMembership: "member" as const,
  allMembersChannelMembership: "member" as const,
  cityChannelConfigured: true,
  referenceDate: new Date("2026-07-01T00:00:00.000Z"),
};

describe("classifyMemberHealth", () => {
  it("marks fully connected member", () => {
    const r = classifyMemberHealth(base);
    expect(r.hasCurrentServiceAccess).toBe(true);
    expect(r.issues.some((i) => i.code === "FULLY_CONNECTED")).toBe(true);
  });

  it("flags a Stripe-paused subscription as no-access with a pause issue", () => {
    const r = classifyMemberHealth({
      ...base,
      stripeSubscriptionStatus: "paused",
      billingPauseUntil: "2026-09-01",
      serviceAccessUntil: "2026-12-01T00:00:00.000Z",
    });
    expect(r.hasCurrentServiceAccess).toBe(false);
    const issue = r.issues.find((i) => i.code === "STRIPE_SUBSCRIPTION_PAUSED");
    expect(issue).toBeTruthy();
    expect(issue?.severity).toBe("medium");
    expect(issue?.explanation).toContain("2026-09-01");
  });

  it("flags indefinite Stripe pause as high severity", () => {
    const r = classifyMemberHealth({
      ...base,
      stripeSubscriptionStatus: "paused",
      billingPauseUntil: "",
    });
    const issue = r.issues.find((i) => i.code === "STRIPE_SUBSCRIPTION_PAUSED");
    expect(issue?.severity).toBe("high");
    expect(issue?.explanation).toMatch(/indefinite/i);
  });

  it("flags paused intros (info), missing pause date (medium) and expired pause (medium)", () => {
    const paused = classifyMemberHealth({
      ...base,
      recurringIntroStatus: "Paused",
      recurringPauseUntil: "2026-09-01",
    });
    expect(paused.issues.some((i) => i.code === "INTROS_PAUSED")).toBe(true);

    const missing = classifyMemberHealth({
      ...base,
      recurringIntroStatus: "Paused",
      recurringPauseUntil: "",
    });
    expect(missing.issues.some((i) => i.code === "PAUSED_WITH_MISSING_DATE")).toBe(true);
    expect(missing.issues.some((i) => i.code === "INTROS_PAUSED")).toBe(false);

    const expired = classifyMemberHealth({
      ...base,
      recurringIntroStatus: "Paused",
      recurringPauseUntil: "2026-01-01",
    });
    expect(expired.issues.some((i) => i.code === "PAUSED_PAST_RESUME_DATE")).toBe(true);
  });

  it("does not flag intro pause issues for Excluded members", () => {
    const r = classifyMemberHealth({
      ...base,
      recurringIntroStatus: "Excluded",
    });
    expect(r.issues.some((i) => i.code.startsWith("PAUSED"))).toBe(false);
    expect(r.issues.some((i) => i.code === "INTROS_PAUSED")).toBe(false);
  });

  it("flags expired cancelled member still in Slack workspace", () => {
    const r = classifyMemberHealth({
      ...base,
      membership: "Cancelled",
      payment: "Unpaid",
      serviceAccessUntil: "2026-01-01T00:00:00.000Z",
      slackIdentityState: "matched_primary_email",
      cityChannelMembership: "member",
      allMembersChannelMembership: "member",
    });
    expect(r.hasCurrentServiceAccess).toBe(false);
    const issue = r.issues.find((i) => i.code === "EXPIRED_MEMBER_STILL_IN_SLACK_WORKSPACE");
    expect(issue).toBeTruthy();
    expect(issue?.severity).toBe("high");
    expect(issue?.explanation).toMatch(/Still in workspace/i);
  });

  it("does not flag grace-period cancelled member as expired in Slack", () => {
    const r = classifyMemberHealth({
      ...base,
      membership: "Cancelled",
      payment: "Unpaid",
      serviceAccessUntil: "2026-12-01T00:00:00.000Z",
      slackIdentityState: "matched_primary_email",
    });
    expect(r.hasCurrentServiceAccess).toBe(true);
    expect(
      r.issues.some((i) => i.code === "EXPIRED_MEMBER_STILL_IN_SLACK_WORKSPACE")
    ).toBe(false);
  });

  it("does not flag Active+Paid as expired in Slack", () => {
    const r = classifyMemberHealth({
      ...base,
      serviceAccessUntil: "2020-01-01T00:00:00.000Z",
    });
    expect(r.hasCurrentServiceAccess).toBe(true);
    expect(
      r.issues.some((i) => i.code === "EXPIRED_MEMBER_STILL_IN_SLACK_WORKSPACE")
    ).toBe(false);
  });

  it("does not flag expired member with deactivated Slack as removal-ready issue", () => {
    const r = classifyMemberHealth({
      ...base,
      membership: "Cancelled",
      payment: "Unpaid",
      serviceAccessUntil: "2026-01-01T00:00:00.000Z",
      slackIdentityState: "deactivated",
    });
    expect(
      r.issues.some((i) => i.code === "EXPIRED_MEMBER_STILL_IN_SLACK_WORKSPACE")
    ).toBe(false);
  });

  it("flags paying stripe missing airtable", () => {
    const r = classifyMemberHealth({
      ...base,
      airtableRecordId: null,
      stripeOnly: true,
    });
    expect(r.issues.some((i) => i.code === "PAYING_STRIPE_CUSTOMER_MISSING_AIRTABLE")).toBe(
      true
    );
  });

  it("flags missing stripe customer id", () => {
    const r = classifyMemberHealth({ ...base, stripeCustomerId: "" });
    expect(
      r.issues.some((i) => i.code === "AIRTABLE_MEMBER_MISSING_STRIPE_CUSTOMER_ID")
    ).toBe(true);
  });

  it("flags duplicate airtable emails", () => {
    const r = classifyMemberHealth({ ...base, airtableEmailCount: 2 });
    expect(r.issues.some((i) => i.code === "DUPLICATE_AIRTABLE_EMAIL")).toBe(true);
  });

  it("flags invalid service access date", () => {
    const r = classifyMemberHealth({
      ...base,
      membership: "Cancelled",
      payment: "Unpaid",
      serviceAccessUntil: "not-a-date",
    });
    expect(r.issues.some((i) => i.code === "INVALID_SERVICE_ACCESS_DATE")).toBe(true);
  });

  it("flags access behind stripe", () => {
    const r = classifyMemberHealth({
      ...base,
      serviceAccessUntil: "2026-06-01T00:00:00.000Z",
      latestQualifyingPaidThrough: "2026-08-01T00:00:00.000Z",
    });
    expect(r.issues.some((i) => i.code === "SERVICE_ACCESS_DATE_BEHIND_STRIPE")).toBe(true);
  });

  it("treats later airtable access as info not error", () => {
    const r = classifyMemberHealth({
      ...base,
      serviceAccessUntil: "2026-12-01T00:00:00.000Z",
      latestQualifyingPaidThrough: "2026-08-01T00:00:00.000Z",
    });
    const issue = r.issues.find((i) => i.code === "SERVICE_ACCESS_LATER_THAN_STRIPE");
    expect(issue?.severity).toBe("info");
  });

  it("flags service eligible missing slack", () => {
    const r = classifyMemberHealth({
      ...base,
      slackIdentityState: "not_found",
      cityChannelMembership: "not_checked",
      allMembersChannelMembership: "not_checked",
    });
    expect(
      r.issues.some((i) => i.code === "SERVICE_ELIGIBLE_MEMBER_NOT_IN_SLACK")
    ).toBe(true);
  });

  it("flags deactivated slack", () => {
    const r = classifyMemberHealth({
      ...base,
      slackIdentityState: "deactivated",
      cityChannelMembership: "not_checked",
      allMembersChannelMembership: "not_checked",
    });
    expect(
      r.issues.some((i) => i.code === "ACTIVE_MEMBER_HAS_DEACTIVATED_SLACK_ACCOUNT")
    ).toBe(true);
  });

  it("flags missing city channel", () => {
    const r = classifyMemberHealth({
      ...base,
      cityChannelMembership: "not_member",
    });
    expect(r.issues.some((i) => i.code === "MEMBER_NOT_IN_CITY_CHANNEL")).toBe(true);
  });

  it("flags missing all-members channel", () => {
    const r = classifyMemberHealth({
      ...base,
      allMembersChannelMembership: "not_member",
    });
    expect(r.issues.some((i) => i.code === "MEMBER_NOT_IN_ALL_MEMBERS_CHANNEL")).toBe(
      true
    );
  });

  it("blank slack email with primary match is info", () => {
    const r = classifyMemberHealth({
      ...base,
      slackEmail: "",
      slackIdentityState: "matched_primary_email",
    });
    const issue = r.issues.find(
      (i) => i.code === "SLACK_EMAIL_MISSING_BUT_PRIMARY_EMAIL_MATCHES"
    );
    expect(issue?.severity).toBe("info");
  });

  it("makeIssue returns stable metadata", () => {
    expect(makeIssue("DUPLICATE_AIRTABLE_EMAIL").systems).toContain("airtable");
  });
});
