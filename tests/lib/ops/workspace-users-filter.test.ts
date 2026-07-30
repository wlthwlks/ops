import { describe, it, expect } from "vitest";
import { filterWorkspaceUsers, type WorkspaceUserRow } from "@/lib/ops/workspace-users";

function user(partial: Partial<WorkspaceUserRow>): WorkspaceUserRow {
  return {
    slackUserId: "U1",
    name: "Ada",
    email: "ada@ex.com",
    slackAccountStatus: "active",
    airtableRecordId: "rec1",
    airtableMatch: "matched",
    memberName: "Ada",
    city: "London",
    membership: "Active",
    payment: "Paid",
    serviceAccessUntil: "",
    serviceAccessState: "current",
    channels: [{ id: "C1", name: "london", membership: "member" }],
    channelCount: 1,
    recommendedAction: "No action",
    ...partial,
  };
}

describe("filterWorkspaceUsers", () => {
  const users = [
    user({ slackUserId: "U1", name: "Ada" }),
    user({
      slackUserId: "U2",
      name: "Bob",
      serviceAccessState: "expired",
      airtableMatch: "matched",
    }),
    user({
      slackUserId: "U3",
      name: "Carl",
      airtableMatch: "none",
      channels: [],
      channelCount: 0,
      serviceAccessState: "no_member",
    }),
  ];

  it("filters expired only", () => {
    expect(filterWorkspaceUsers(users, { expiredOnly: true })).toHaveLength(1);
  });

  it("filters no airtable match", () => {
    expect(filterWorkspaceUsers(users, { noAirtableMatch: true })).toHaveLength(1);
  });

  it("filters no configured channel", () => {
    expect(filterWorkspaceUsers(users, { noConfiguredChannel: true })).toHaveLength(1);
  });

  it("filters by channel id", () => {
    expect(filterWorkspaceUsers(users, { channelId: "C1" })).toHaveLength(2);
  });
});
