import { describe, it, expect } from "vitest";
import {
  sortByDateJoinedDesc,
  pickSlackProfileFields,
  isInviteCandidateIdentityState,
} from "@/lib/ops/slack-community";
import type { SlackUser } from "@/lib/integrations/slack";

describe("sortByDateJoinedDesc", () => {
  const rows = [
    { name: "old", dateJoined: "2024-01-10" },
    { name: "newest", dateJoined: "2026-05-02" },
    { name: "missing", dateJoined: "" },
    { name: "mid", dateJoined: "2025-11-20" },
  ];

  it("orders latest first and sinks missing dates", () => {
    const sorted = sortByDateJoinedDesc(rows, (r) => r.dateJoined);
    expect(sorted.map((r) => r.name)).toEqual([
      "newest",
      "mid",
      "old",
      "missing",
    ]);
  });

  it("does not mutate the input", () => {
    const input = [...rows];
    sortByDateJoinedDesc(input, (r) => r.dateJoined);
    expect(input.map((r) => r.name)).toEqual([
      "old",
      "newest",
      "missing",
      "mid",
    ]);
  });
});

describe("pickSlackProfileFields", () => {
  it("builds comparison fields with fallbacks", () => {
    const user: SlackUser = {
      id: "U1",
      email: "ada@ex.com",
      name: "ada",
      realName: "Ada Lovelace",
      deleted: false,
      isBot: false,
      isAppUser: false,
      displayName: "Ada",
      title: "Engineer",
      statusText: "on a walk",
      statusEmoji: ":walk:",
      isOwner: true,
    };
    const fields = pickSlackProfileFields(user);
    const byLabel = Object.fromEntries(fields.map((f) => [f.label, f.value]));
    expect(byLabel["Display name"]).toBe("Ada");
    expect(byLabel["Email"]).toBe("ada@ex.com");
    expect(byLabel["Status"]).toBe(":walk: on a walk");
    expect(byLabel["Role"]).toContain("Owner");
    expect(byLabel["Slack ID"]).toBe("U1");
  });
});

describe("isInviteCandidateIdentityState", () => {
  it("accepts not_found and stale_slack_email", () => {
    expect(isInviteCandidateIdentityState("not_found")).toBe(true);
    expect(isInviteCandidateIdentityState("stale_slack_email")).toBe(true);
  });

  it("accepts deactivated accounts (reactivate flow)", () => {
    expect(isInviteCandidateIdentityState("deactivated")).toBe(true);
  });

  it("rejects matched, name-suggested and ambiguous identities", () => {
    expect(isInviteCandidateIdentityState("matched_primary_email")).toBe(false);
    expect(isInviteCandidateIdentityState("matched_slack_email")).toBe(false);
    expect(isInviteCandidateIdentityState("suggested_name")).toBe(false);
    expect(isInviteCandidateIdentityState("ambiguous")).toBe(false);
    expect(isInviteCandidateIdentityState("not_checked")).toBe(false);
  });
});
