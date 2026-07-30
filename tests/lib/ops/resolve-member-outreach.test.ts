import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [],
          }),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/integrations/airtable", () => ({
  createAirtableClient: vi.fn(),
}));

vi.mock("@/lib/integrations/slack", () => ({
  createSlackClient: vi.fn(),
}));

describe("resolveMemberForOutreach", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.AIRTABLE_GET_DATA_TOKEN = "tok";
    process.env.AIRTABLE_BASE_ID = "base";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_ALL_MEMBERS_CHANNEL_ID = "Call";
    process.env.SLACK_WORKSPACE_INVITE_URL = "https://join.example";
  });

  it("loads a single Airtable record via getRecord (not full list)", async () => {
    const getRecord = vi.fn().mockResolvedValue({
      id: "recABC",
      fields: {
        Name: "Ada",
        email: "ada@ex.com",
        "Slack Email": "",
        City: "London",
        Membership: "Active",
        Payment: "Paid",
        "Service access until": "",
        "Stripe Customer ID": "cus_1",
        "Date joined": "",
        "Cancellation date": "",
      },
    });
    const listRecords = vi.fn().mockResolvedValue([]);
    const lookupByEmail = vi.fn().mockResolvedValue({ id: "U1", name: "Ada" });

    const { createAirtableClient } = await import("@/lib/integrations/airtable");
    const { createSlackClient } = await import("@/lib/integrations/slack");
    vi.mocked(createAirtableClient).mockReturnValue({
      getRecord,
      listRecords,
    } as never);
    vi.mocked(createSlackClient).mockReturnValue({
      lookupByEmail,
      listUsers: vi.fn(),
    } as never);

    const { resolveMemberForOutreach } = await import(
      "@/lib/ops/resolve-member-for-outreach"
    );
    const result = await resolveMemberForOutreach("recABC");

    expect(getRecord).toHaveBeenCalledTimes(1);
    expect(getRecord.mock.calls[0][1]).toBe("recABC");
    // listRecords only for city/channel config — never full members list
    for (const call of listRecords.mock.calls) {
      expect(String(call[0]).toUpperCase()).not.toBe("MEMBERS");
    }
    expect(lookupByEmail).toHaveBeenCalled();
    expect(result.member.airtableRecordId).toBe("recABC");
    expect(result.timings.airtableMemberMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
  });
});
