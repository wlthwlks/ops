import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildSlackJoinEmailPreview,
  escapeHtml,
  getOutreachCooldownDays,
} from "@/lib/ops/slack-outreach";
import type { MemberHealthRow } from "@/lib/ops/member-health-types";

function member(partial: Partial<MemberHealthRow> = {}): MemberHealthRow {
  return {
    airtableRecordId: "rec1",
    name: "Ada <script>",
    primaryEmail: "ada@ex.com",
    slackEmail: "",
    city: "London",
    membership: "Active",
    payment: "Paid",
    dateJoined: "",
    cancellationDate: "",
    serviceAccessUntil: "2026-12-01T00:00:00.000Z",
    hasCurrentServiceAccess: true,
    stripeCustomerId: "cus_1",
    stripeCustomerEmail: "",
    latestQualifyingPaidThrough: "",
    recurringIntroStatus: "",
    recurringPauseUntil: "",
    introPauseState: "active",
    stripeSubscriptionStatus: "",
    billingPauseUntil: "",
    activeSlackUserId: "",
    activeSlackEmail: "",
    activeSlackDisplayName: "",
    slackIdentityState: "not_found",
    cityChannelId: "C123",
    cityChannelName: "london",
    cityChannelMembership: "not_checked",
    allMembersChannelId: "C_ALL",
    allMembersChannelMembership: "not_checked",
    resolverConfidence: "none",
    issues: [],
    highestSeverity: "high",
    recommendedNextAction: "Send email",
    stripeOnly: false,
    ...partial,
  };
}

describe("escapeHtml", () => {
  it("escapes tags", () => {
    expect(escapeHtml(`a<b>"c"`)).toContain("&lt;");
    expect(escapeHtml(`a<b>"c"`)).not.toContain("<b>");
  });
});

describe("buildSlackJoinEmailPreview", () => {
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [
      "SLACK_WORKSPACE_INVITE_URL",
      "SLACK_JOIN_URL",
      "SLACK_WORKSPACE_URL",
      "SLACK_ALL_MEMBERS_CHANNEL_ID",
      "RESEND_API_KEY",
      "RESEND_FROM_EMAIL",
    ]) {
      prev[k] = process.env[k];
    }
    process.env.SLACK_WORKSPACE_INVITE_URL = "https://join.slack.com/t/example";
    process.env.SLACK_WORKSPACE_URL = "https://example.slack.com";
    process.env.SLACK_ALL_MEMBERS_CHANNEL_ID = "C_ALL";
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_FROM_EMAIL = "ops@example.com";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("escapes member name in html", () => {
    const p = buildSlackJoinEmailPreview(member());
    expect(p.html).not.toContain("<script>");
    expect(p.html).toContain("&lt;script&gt;");
    expect(p.subject).toContain("Slack");
  });

  it("blocks already-on-slack members", () => {
    const p = buildSlackJoinEmailPreview(
      member({ slackIdentityState: "matched_primary_email" })
    );
    expect(p.eligible).toBe(false);
    expect(p.eligibilityReasons.some((r) => /already matched/i.test(r))).toBe(true);
  });

  it("blocks missing city", () => {
    const p = buildSlackJoinEmailPreview(member({ city: "", cityChannelId: "" }));
    expect(p.eligible).toBe(false);
  });

  it("blocks stripe-only (no airtable)", () => {
    const p = buildSlackJoinEmailPreview(member({ airtableRecordId: null }));
    expect(p.eligible).toBe(false);
  });

  it("reports missing config", () => {
    delete process.env.SLACK_WORKSPACE_INVITE_URL;
    delete process.env.SLACK_JOIN_URL;
    const p = buildSlackJoinEmailPreview(member());
    expect(p.missingConfig.length).toBeGreaterThan(0);
    expect(p.eligible).toBe(false);
  });
});

describe("getOutreachCooldownDays", () => {
  it("defaults to 7", () => {
    const prev = process.env.SLACK_OUTREACH_COOLDOWN_DAYS;
    delete process.env.SLACK_OUTREACH_COOLDOWN_DAYS;
    expect(getOutreachCooldownDays()).toBe(7);
    if (prev !== undefined) process.env.SLACK_OUTREACH_COOLDOWN_DAYS = prev;
  });
});
