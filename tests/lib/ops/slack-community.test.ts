import { describe, it, expect } from "vitest";
import {
  sortByDateJoinedDesc,
  pickSlackProfileFields,
  isInviteCandidateIdentityState,
  primaryEmailMatchesActiveSlackUser,
  suggestLinkByName,
} from "@/lib/ops/slack-community";
import { buildSlackMaps } from "@/lib/ops/member-health";
import type { SlackUser } from "@/lib/integrations/slack";

function slackUser(
  id: string,
  email: string,
  realName: string,
  deleted = false
): SlackUser {
  return {
    id,
    email,
    name: realName.toLowerCase().replace(/\s+/g, "."),
    realName,
    deleted,
    isBot: false,
    isAppUser: false,
  };
}

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

describe("primaryEmailMatchesActiveSlackUser", () => {
  const maps = buildSlackMaps([
    slackUser("U1", "ada@ex.com", "Ada Lovelace"),
    slackUser("U2", "grace@ex.com", "Grace Hopper"),
  ]);

  it("matches a unique active user by email (case/space insensitive)", () => {
    expect(primaryEmailMatchesActiveSlackUser(" ADA@EX.COM ", maps)).toBe(true);
  });

  it("is false when the email is not in the workspace", () => {
    expect(primaryEmailMatchesActiveSlackUser("nobody@ex.com", maps)).toBe(false);
  });

  it("is false when the email belongs to a deactivated account", () => {
    const deletedMaps = buildSlackMaps([
      slackUser("U3", "gone@ex.com", "Gone User", true),
    ]);
    expect(primaryEmailMatchesActiveSlackUser("gone@ex.com", deletedMaps)).toBe(false);
  });

  it("is false when two active users share the email", () => {
    const dupMaps = buildSlackMaps([
      slackUser("U4", "shared@ex.com", "First Shared"),
      slackUser("U5", "shared@ex.com", "Second Shared"),
    ]);
    expect(primaryEmailMatchesActiveSlackUser("shared@ex.com", dupMaps)).toBe(false);
  });
});

describe("suggestLinkByName", () => {
  const maps = buildSlackMaps([
    slackUser("U1", "ada@ex.com", "Ada Lovelace"),
    slackUser("U2", "grace@ex.com", "Grace Hopper"),
  ]);

  it("high confidence for a single exact name match", () => {
    expect(suggestLinkByName("Ada Lovelace", maps)).toEqual({
      slackUserId: "U1",
      slackEmail: "ada@ex.com",
      slackName: "Ada Lovelace",
      confidence: "high",
      kind: "exact_name",
    });
  });

  it("low confidence for multiple same-name users", () => {
    const dupMaps = buildSlackMaps([
      slackUser("U4", "first@ex.com", "Sam Smith"),
      slackUser("U5", "second@ex.com", "Sam Smith"),
    ]);
    expect(suggestLinkByName("Sam Smith", dupMaps)).toEqual({
      slackUserId: "U4",
      slackEmail: "first@ex.com",
      slackName: "Sam Smith",
      confidence: "low",
      kind: "ambiguous_name",
    });
  });

  it("null when no name matches", () => {
    expect(suggestLinkByName("Zed Unknown", maps)).toBeNull();
  });

  it("null for empty names", () => {
    expect(suggestLinkByName("", maps)).toBeNull();
  });
});
