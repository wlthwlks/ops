import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/forms/memberstack/auth", () => ({
  extractMemberstackToken: vi.fn(() => "token"),
  verifyMemberstackToken: vi.fn(async () => ({ id: "ms_1", email: "a@x.com", raw: {} })),
}));

vi.mock("@/lib/forms/billing/reactivate-membership", () => ({
  reactivateMembershipForMember: vi.fn(),
}));

vi.mock("@/lib/forms/airtable/members-sync", () => ({
  findMemberByMemberstackId: vi.fn(),
}));

const syncMemberSemanticProfile = vi.fn(async () => ({
  status: "embedded",
  vectorsUpserted: 4,
  vectorsDeleted: 0,
}));

vi.mock("@/lib/introduction/member-profile-sync", () => ({
  syncMemberSemanticProfile: (record: unknown) => syncMemberSemanticProfile(record),
}));

const route = await import("@/app/api/member/reactivate/route");
const { reactivateMembershipForMember } = await import("@/lib/forms/billing/reactivate-membership");
const { findMemberByMemberstackId } = await import("@/lib/forms/airtable/members-sync");

function request(): NextRequest {
  return new NextRequest("http://localhost/api/member/reactivate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

const RECORD = { id: "rec_1", fields: { email: "a@x.com", Name: "Ada" } };

describe("POST /api/member/reactivate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(reactivateMembershipForMember).mockResolvedValue({
      success: true,
      status: "reactivated",
      reason: "Membership reactivated",
    });
    vi.mocked(findMemberByMemberstackId).mockResolvedValue([RECORD]);
  });

  it("re-embeds the member's semantic vectors after a successful reactivation", async () => {
    const response = await route.POST(request());
    expect(response.status).toBe(200);
    expect(findMemberByMemberstackId).toHaveBeenCalledWith("ms_1");
    expect(syncMemberSemanticProfile).toHaveBeenCalledWith(RECORD);
  });

  it("skips the Pinecone hook when reactivation fails", async () => {
    vi.mocked(reactivateMembershipForMember).mockResolvedValue({
      success: false,
      status: "billing_paused",
      reason: "Membership is paused",
    });
    const response = await route.POST(request());
    expect(response.status).toBe(400);
    expect(syncMemberSemanticProfile).not.toHaveBeenCalled();
  });

  it("skips the hook when no Airtable member is found", async () => {
    vi.mocked(findMemberByMemberstackId).mockResolvedValue([]);
    const response = await route.POST(request());
    expect(response.status).toBe(200);
    expect(syncMemberSemanticProfile).not.toHaveBeenCalled();
  });

  it("never fails the response when the hook throws", async () => {
    vi.mocked(findMemberByMemberstackId).mockRejectedValueOnce(new Error("airtable down"));
    const response = await route.POST(request());
    expect(response.status).toBe(200);
  });
});
