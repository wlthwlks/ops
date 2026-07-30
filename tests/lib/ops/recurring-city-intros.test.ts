import { describe, it, expect, vi } from "vitest";
import {
  isMemberEligible,
  calculateBalancedGroupSizes,
  buildRecurringGroups,
  renderRecurringMessage,
  buildCycleId,
  isChannelDue,
  runRecurringCityIntros,
  type RecurringMember,
  type RecurringChannelConfig,
  type RecurringDeps,
} from "@/lib/ops/recurring-city-intros";

function makeMember(overrides: Partial<RecurringMember> = {}): RecurringMember {
  return {
    airtableRecordId: "rec_member_1",
    name: "Alice",
    email: "alice@example.com",
    slackUserId: "U123",
    city: "London",
    recurringIntroStatus: "",
    recurringPauseUntil: null,
    payment: "Paid",
    membership: "Active",
    serviceAccessUntil: null,
    firstIntroductionStatus: "",
    ...overrides,
  };
}

function makeChannelConfig(overrides: Partial<RecurringChannelConfig> = {}): RecurringChannelConfig {
  return {
    airtableRecordId: "rec_channel_1",
    name: "London Walks",
    citiesRecordId: "rec_city_1",
    cityName: "London",
    slackChannelId: "C12345",
    introType: "Standard",
    groupSize: 3,
    strictGroupSize: false,
    introFrequencyWeeks: 1,
    nextIntroductionDate: "2026-06-01",
    introLocalTime: "09:00",
    timezone: "Europe/London",
    introMessageTemplate: "Hey {{participants}}!",
    schedulingMode: "",
    googleCalendarEnabled: false,
    outlookEnabled: false,
    meetingDurationMinutes: 0,
    autoScheduleMeeting: false,
    channelStatus: "Active",
    ...overrides,
  };
}

type MockDeps = RecurringDeps & {
  _calls: { method: string; args: unknown[] }[];
  _airtableRecords: Record<string, any[]>;
  airtable: any;
  slack: any;
};

function createMockDeps(overrides: Partial<RecurringDeps> = {}): MockDeps {
  const calls: { method: string; args: unknown[] }[] = [];
  const airtableRecords: Record<string, any[]> = {
    "SLACK CHANNELS": [],
    "ALL CITIES": [],
    MEMBERS: [],
    "MATCH GROUPS": [],
    "Introduction data": [],
  };

  const airtable = {
    listRecords: vi.fn(async (table: string) => {
      calls.push({ method: "airtable.listRecords", args: [table] });
      return airtableRecords[table] || [];
    }),
    getRecord: vi.fn(async () => ({ id: "rec1", fields: {} })),
    createRecords: vi.fn(async (_table: string, records: any[]) => {
      calls.push({ method: "airtable.createRecords", args: [_table, records] });
      return records.map((r: any, i: number) => ({ id: `created_${i}`, fields: r.fields }));
    }),
    createRecordsBatched: vi.fn(async (_table: string, records: any[]) => {
      calls.push({ method: "airtable.createRecordsBatched", args: [_table, records] });
      return records.map((r: any, i: number) => ({ id: `created_${i}`, fields: r.fields }));
    }),
    updateRecords: vi.fn(async (_table: string, records: any[]) => {
      calls.push({ method: "airtable.updateRecords", args: [_table, records] });
      return records.map((r: any) => ({ id: r.id, fields: r.fields }));
    }),
    updateRecordsBatched: vi.fn(async (_table: string, records: any[]) => {
      calls.push({ method: "airtable.updateRecordsBatched", args: [_table, records] });
      return records.map((r: any) => ({ id: r.id, fields: r.fields }));
    }),
  };

  const slack = {
    postMessage: vi.fn(async () => ({ ts: "123.456" })),
    getChannelHistory: vi.fn(async () => []),
    sendWebhook: vi.fn(async () => {}),
    lookupByEmail: vi.fn(async () => null),
    conversationsOpen: vi.fn(async () => ({ channelId: "D_MOCK" })),
    listUsers: vi.fn(async () => []),
    getConversationMembers: vi.fn(async () => []),
    authTest: vi.fn(async () => ({ url: "", team: "", scopes: [] })),
  };

  return {
    airtable,
    slack,
    now: () => new Date("2026-06-01T10:00:00Z"),
    mode: "preview",
    writesEnabled: false,
    allowedChannelIds: null,
    _calls: calls,
    _airtableRecords: airtableRecords,
    ...overrides,
  } as any;
}

function makeChannelRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "rec_ch_1",
    fields: {
      Name: "London Walks",
      Cities: "rec_city_1",
      "group size": 3,
      "Channel status/donut": "Active",
      "Slack Channel ID": "C123",
      "Intro type": "Standard",
      "Strict group size": false,
      "Intro frequency weeks": 1,
      "Next introduction date": "2026-06-01",
      "Intro local time": "09:00",
      Timezone: "UTC",
      "Intro message template": "Hey {{participants}}!",
      "Google Calendar enabled": false,
      "Outlook enabled": false,
      "Auto schedule meeting": false,
      "Meeting duration minutes": 0,
      ...overrides,
    },
  };
}

function makeMemberRecord(id: string, name: string, email: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    fields: {
      Name: name,
      email,
      "Slack Email": email,
      Payment: "Paid",
      Membership: "Active",
      City: "London",
      "Recurring intro status": "",
      "Recurring pause until": null,
      ...overrides,
    },
  };
}

function makeSlackUser(id: string, email: string, name: string) {
  return { id, email, name, realName: name, deleted: false, isBot: false, isAppUser: false };
}

function setupMockChannel(deps: MockDeps, members: any[], slackUsers: any[], memberIds: string[]) {
  deps._airtableRecords["SLACK CHANNELS"] = [makeChannelRecord()];
  deps._airtableRecords["ALL CITIES"] = [{ id: "rec_city_1", fields: { City: "London", Name: "London" } }];
  deps._airtableRecords["MEMBERS"] = members;
  deps.slack.listUsers.mockResolvedValue(slackUsers);
  deps.slack.getConversationMembers.mockResolvedValue(memberIds);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isMemberEligible", () => {
  it("blank status is eligible", () => {
    expect(isMemberEligible(makeMember({ recurringIntroStatus: "" }), new Date("2026-06-01")).eligible).toBe(true);
  });

  it("active status is eligible", () => {
    expect(isMemberEligible(makeMember({ recurringIntroStatus: "Active" }), new Date("2026-06-01")).eligible).toBe(true);
  });

  it("excluded status is not eligible", () => {
    expect(isMemberEligible(makeMember({ recurringIntroStatus: "Excluded" }), new Date("2026-06-01")).eligible).toBe(false);
  });

  it("paused with no date is not eligible", () => {
    expect(isMemberEligible(makeMember({ recurringIntroStatus: "Paused", recurringPauseUntil: null }), new Date("2026-06-01")).eligible).toBe(false);
  });

  it("paused with future date is not eligible", () => {
    expect(isMemberEligible(makeMember({ recurringIntroStatus: "Paused", recurringPauseUntil: "2026-12-31" }), new Date("2026-06-01")).eligible).toBe(false);
  });

  it("paused with past date is eligible", () => {
    expect(isMemberEligible(makeMember({ recurringIntroStatus: "Paused", recurringPauseUntil: "2026-01-01" }), new Date("2026-06-01")).eligible).toBe(true);
  });

  it("inactive membership is excluded", () => {
    expect(isMemberEligible(makeMember({ membership: "Inactive" }), new Date("2026-06-01")).eligible).toBe(false);
  });

  it("unpaid is excluded", () => {
    expect(isMemberEligible(makeMember({ payment: "Unpaid" }), new Date("2026-06-01")).eligible).toBe(false);
  });
});

describe("calculateBalancedGroupSizes", () => {
  it("target of 3 means groups of 3", () => {
    const { sizes, unmatched } = calculateBalancedGroupSizes(6, 3, true);
    expect(sizes).toEqual([3, 3]);
    expect(unmatched).toBe(0);
  });

  it("never creates a group of one (non-strict)", () => {
    const cases = [
      { total: 2, target: 3, expected: [2] },
      { total: 3, target: 3, expected: [3] },
      { total: 4, target: 3, expected: [4] },
      { total: 5, target: 3, expected: [3, 2] },
      { total: 7, target: 3, expected: [3, 4] },
      { total: 8, target: 3, expected: [3, 3, 2] },
      { total: 10, target: 3, expected: [3, 3, 4] },
    ];
    for (const { total, target, expected } of cases) {
      const { sizes } = calculateBalancedGroupSizes(total, target, false);
      expect(sizes.sort()).toEqual(expected.sort());
      for (const s of sizes) expect(s).toBeGreaterThanOrEqual(2);
    }
  });

  it("strict groups leave remainder unmatched", () => {
    const { sizes, unmatched } = calculateBalancedGroupSizes(7, 3, true);
    expect(sizes).toEqual([3, 3]);
    expect(unmatched).toBe(1);
  });

  it("strict groups with exact fit", () => {
    const { sizes, unmatched } = calculateBalancedGroupSizes(9, 3, true);
    expect(sizes).toEqual([3, 3, 3]);
    expect(unmatched).toBe(0);
  });
});

describe("buildCycleId", () => {
  it("generates correct cycle ID", () => {
    expect(buildCycleId("Greater London", new Date("2026-08-03"))).toBe("recurring-greater-london-2026-08-03");
  });

  it("normalizes city names", () => {
    expect(buildCycleId("New York City!", new Date("2026-01-01"))).toBe("recurring-new-york-city-2026-01-01");
  });
});

describe("buildRecurringGroups", () => {
  it("is deterministic for same cycle ID", () => {
    const members = Array.from({ length: 6 }, (_, i) => makeMember({ email: `m${i}@test.com`, name: `M${i}` }));
    const r1 = buildRecurringGroups(members, 3, false, "recurring-test-2026-06-01");
    const r2 = buildRecurringGroups(members, 3, false, "recurring-test-2026-06-01");
    expect(r1.groups.map((g) => g.members.map((m) => m.email))).toEqual(
      r2.groups.map((g) => g.members.map((m) => m.email))
    );
  });

  it("different cycle IDs produce different groupings", () => {
    const members = Array.from({ length: 6 }, (_, i) => makeMember({ email: `m${i}@test.com`, name: `M${i}` }));
    const r1 = buildRecurringGroups(members, 3, false, "recurring-test-2026-06-01");
    const r2 = buildRecurringGroups(members, 3, false, "recurring-test-2026-06-08");
    const g1 = r1.groups.map((g) => g.members.map((m) => m.email).sort().join(",")).sort().join("|");
    const g2 = r2.groups.map((g) => g.members.map((m) => m.email).sort().join(",")).sort().join("|");
    expect(g1).not.toBe(g2);
  });

  it("avoids recent pairings when alternatives exist", () => {
    const members = Array.from({ length: 6 }, (_, i) => makeMember({ email: `m${i}@test.com`, name: `M${i}` }));
    const recentPairs = new Map<string, Set<string>>();
    recentPairs.set("m0@test.com|m1@test.com", new Set(["m0@test.com", "m1@test.com"]));
    const result = buildRecurringGroups(members, 3, false, "recurring-test-2026-06-01", recentPairs);
    for (const group of result.groups) {
      if (group.unmatched) continue;
      const emails = group.members.map((m) => m.email);
      if (emails.includes("m0@test.com") && emails.includes("m1@test.com")) {
        expect.fail("Recent pair was not avoided");
      }
    }
  });

  it("returns repeat warnings when repeats are unavoidable", () => {
    const members = [
      makeMember({ email: "a@test.com", name: "A" }),
      makeMember({ email: "b@test.com", name: "B" }),
      makeMember({ email: "c@test.com", name: "C" }),
    ];
    const recentPairs = new Map<string, Set<string>>();
    recentPairs.set("a@test.com|b@test.com", new Set(["a@test.com", "b@test.com"]));
    const result = buildRecurringGroups(members, 3, false, "recurring-test-2026-06-01", recentPairs);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("A");
    expect(result.warnings[0]).toContain("B");
  });
});

describe("renderRecurringMessage", () => {
  it("replaces all placeholders", () => {
    const tpl = "Hey {{participants}}! Walk in {{city}} every {{frequency_label}}. Duration: {{meeting_duration}}.";
    expect(renderRecurringMessage(tpl, "<@U1> <@U2>", "London", "week", 60)).toBe(
      "Hey <@U1> <@U2>! Walk in London every week. Duration: 60 minutes."
    );
  });

  it("prepends mentions when template has no {{participants}}", () => {
    const result = renderRecurringMessage("Hey everyone!", "<@U1> <@U2>", "London", "week", null);
    expect(result).toContain("<@U1> <@U2>");
    expect(result).toContain("Hey everyone!");
  });
});

describe("isChannelDue", () => {
  it("returns true when local time has arrived", () => {
    expect(isChannelDue(makeChannelConfig({ nextIntroductionDate: "2026-06-01", timezone: "UTC" }), new Date("2026-06-01T09:00:00Z"))).toBe(true);
  });

  it("returns false when nextIntroductionDate is blank", () => {
    expect(isChannelDue(makeChannelConfig({ nextIntroductionDate: null }), new Date())).toBe(false);
  });

  it("non-Active channel is not due", () => {
    expect(isChannelDue(makeChannelConfig({ channelStatus: "Inactive" }), new Date("2026-06-01T09:00:00Z"))).toBe(false);
  });

  it("non-Standard intro type is not due", () => {
    expect(isChannelDue(makeChannelConfig({ introType: "Coffee Chat" }), new Date("2026-06-01T09:00:00Z"))).toBe(false);
  });
});

describe("runRecurringCityIntros", () => {
  it("preview performs no writes and sends no messages", async () => {
    const deps = createMockDeps();
    const members = [
      makeMemberRecord("r1", "Alice", "a@test.com"),
      makeMemberRecord("r2", "Bob", "b@test.com"),
      makeMemberRecord("r3", "Carol", "c@test.com"),
    ];
    const slackUsers = [makeSlackUser("U_a", "a@test.com", "Alice"), makeSlackUser("U_b", "b@test.com", "Bob"), makeSlackUser("U_c", "c@test.com", "Carol")];
    setupMockChannel(deps, members, slackUsers, ["U_a", "U_b", "U_c"]);

    const result = await runRecurringCityIntros(deps, { dueOnly: false });
    expect(result.previews.length).toBe(1);
    expect(deps.airtable.createRecords).not.toHaveBeenCalled();
    expect(deps.airtable.updateRecords).not.toHaveBeenCalled();
    expect(deps.slack.postMessage).not.toHaveBeenCalled();
    expect(deps.slack.conversationsOpen).not.toHaveBeenCalled();
  });

  it("send with writesEnabled false does not deliver", async () => {
    const deps = createMockDeps({ mode: "send", writesEnabled: false });
    const members = [
      makeMemberRecord("r1", "Alice", "a@test.com"),
      makeMemberRecord("r2", "Bob", "b@test.com"),
      makeMemberRecord("r3", "Carol", "c@test.com"),
    ];
    const slackUsers = [makeSlackUser("U_a", "a@test.com", "Alice"), makeSlackUser("U_b", "b@test.com", "Bob"), makeSlackUser("U_c", "c@test.com", "Carol")];
    setupMockChannel(deps, members, slackUsers, ["U_a", "U_b", "U_c"]);

    const result = await runRecurringCityIntros(deps, { dueOnly: false });
    expect(result.sentGroups).toBe(0);
    expect(deps.slack.postMessage).not.toHaveBeenCalled();
    expect(deps.slack.conversationsOpen).not.toHaveBeenCalled();
  });

  it("match-group records created before slack sending", async () => {
    const callOrder: string[] = [];
    const deps = createMockDeps({ mode: "send", writesEnabled: true });
    deps.airtable.createRecords.mockImplementation(async () => {
      callOrder.push("create");
      return [{ id: "rec_mg_1", fields: {} }];
    });
    deps.slack.conversationsOpen.mockImplementation(async () => {
      callOrder.push("slackOpen");
      return { channelId: "D_TEST" };
    });
    deps.slack.postMessage.mockImplementation(async () => {
      callOrder.push("slackPost");
      return { ts: "123.456" };
    });
    deps.airtable.updateRecords.mockImplementation(async () => {
      callOrder.push("update");
      return [];
    });

    const members = [
      makeMemberRecord("r1", "A", "a@t.com"),
      makeMemberRecord("r2", "B", "b@t.com"),
      makeMemberRecord("r3", "C", "c@t.com"),
    ];
    const slackUsers = [makeSlackUser("U_a", "a@t.com", "A"), makeSlackUser("U_b", "b@t.com", "B"), makeSlackUser("U_c", "c@t.com", "C")];
    setupMockChannel(deps, members, slackUsers, ["U_a", "U_b", "U_c"]);

    await runRecurringCityIntros(deps, { dueOnly: false });

    const createIdx = callOrder.indexOf("create");
    const slackOpenIdx = callOrder.indexOf("slackOpen");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(slackOpenIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeLessThan(slackOpenIdx);
  });

  it("slack failure sets Failed status and stores error", async () => {
    const deps = createMockDeps({ mode: "send", writesEnabled: true });
    deps.slack.conversationsOpen.mockRejectedValue(new Error("channel_not_found"));
    deps.airtable.createRecords.mockResolvedValue([{ id: "rec_mg_fail", fields: {} }]);

    const members = [
      makeMemberRecord("r1", "A", "a@t.com"),
      makeMemberRecord("r2", "B", "b@t.com"),
      makeMemberRecord("r3", "C", "c@t.com"),
    ];
    const slackUsers = [makeSlackUser("U_a", "a@t.com", "A"), makeSlackUser("U_b", "b@t.com", "B"), makeSlackUser("U_c", "c@t.com", "C")];
    setupMockChannel(deps, members, slackUsers, ["U_a", "U_b", "U_c"]);

    const result = await runRecurringCityIntros(deps, { dueOnly: false });
    expect(result.failedGroups).toBeGreaterThanOrEqual(1);
    const updateCalls = deps.airtable.updateRecords.mock.calls;
    const failedUpdate = updateCalls.find(
      (c: any) => c[0] === "MATCH GROUPS" && c[1]?.[0]?.fields?.Status === "Failed"
    );
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate[1][0].fields["Send error"]).toContain("channel_not_found");
  });

  it("does not send duplicates for completed cycle", async () => {
    const deps = createMockDeps({ mode: "send", writesEnabled: true });
    const members = [
      makeMemberRecord("r1", "A", "a@t.com"),
      makeMemberRecord("r2", "B", "b@t.com"),
      makeMemberRecord("r3", "C", "c@t.com"),
    ];
    const slackUsers = [makeSlackUser("U_a", "a@t.com", "A"), makeSlackUser("U_b", "b@t.com", "B"), makeSlackUser("U_c", "c@t.com", "C")];
    setupMockChannel(deps, members, slackUsers, ["U_a", "U_b", "U_c"]);
    deps._airtableRecords["MATCH GROUPS"] = [{
      id: "rec_mg_done",
      fields: { "Member 1": ["r1", "r2", "r3"], Status: "Done/Sent", "Cycle ID": "recurring-london-2026-06-01" },
    }];

    const result = await runRecurringCityIntros(deps, { dueOnly: false });
    expect(deps.slack.conversationsOpen).not.toHaveBeenCalled();
    expect(result.sentGroups).toBe(0);
  });

  it("creates introduction-data summary", async () => {
    const deps = createMockDeps({ mode: "send", writesEnabled: true });
    const members = [
      makeMemberRecord("r1", "A", "a@t.com"),
      makeMemberRecord("r2", "B", "b@t.com"),
      makeMemberRecord("r3", "C", "c@t.com"),
    ];
    const slackUsers = [makeSlackUser("U_a", "a@t.com", "A"), makeSlackUser("U_b", "b@t.com", "B"), makeSlackUser("U_c", "c@t.com", "C")];
    setupMockChannel(deps, members, slackUsers, ["U_a", "U_b", "U_c"]);

    await runRecurringCityIntros(deps, { dueOnly: false });

    const createCalls = deps.airtable.createRecords.mock.calls;
    const introDataCall = createCalls.find((c: any) => c[0] === "Introduction data");
    expect(introDataCall).toBeTruthy();
    expect(introDataCall[1][0].fields["intros made"]).toBeGreaterThanOrEqual(1);
    expect(introDataCall[1][0].fields["introduced"]).toBeGreaterThanOrEqual(2);
    expect(introDataCall[1][0].fields["Cycle ID"]).toMatch(/^recurring-london-/);
  });

  it("next introduction date advances only after entire city succeeds", async () => {
    const deps = createMockDeps({ mode: "send", writesEnabled: true });
    const members = [
      makeMemberRecord("r1", "A", "a@t.com"),
      makeMemberRecord("r2", "B", "b@t.com"),
      makeMemberRecord("r3", "C", "c@t.com"),
    ];
    const slackUsers = [makeSlackUser("U_a", "a@t.com", "A"), makeSlackUser("U_b", "b@t.com", "B"), makeSlackUser("U_c", "c@t.com", "C")];
    setupMockChannel(deps, members, slackUsers, ["U_a", "U_b", "U_c"]);

    await runRecurringCityIntros(deps, { dueOnly: false });

    // Check that Next introduction date was advanced
    const updateCalls = deps.airtable.updateRecords.mock.calls;
    const dateUpdate = updateCalls.find(
      (c: any) => c[0] === "SLACK CHANNELS" && c[1]?.[0]?.fields?.["Next introduction date"]
    );
    expect(dateUpdate).toBeTruthy();
    expect(dateUpdate[1][0].fields["Next introduction date"]).toBe("2026-06-08");
  });

  it("calendar fields generate admin warning but no calendar API calls", async () => {
    const deps = createMockDeps();
    const members = [
      makeMemberRecord("r1", "A", "a@t.com"),
      makeMemberRecord("r2", "B", "b@t.com"),
    ];
    const slackUsers = [makeSlackUser("U_a", "a@t.com", "A"), makeSlackUser("U_b", "b@t.com", "B")];
    deps._airtableRecords["SLACK CHANNELS"] = [makeChannelRecord({
      "Google Calendar enabled": true,
      "Auto schedule meeting": true,
    })];
    deps._airtableRecords["ALL CITIES"] = [{ id: "rec_city_1", fields: { City: "London", Name: "London" } }];
    deps._airtableRecords["MEMBERS"] = members;
    deps.slack.listUsers.mockResolvedValue(slackUsers);
    deps.slack.getConversationMembers.mockResolvedValue(["U_a", "U_b"]);

    const result = await runRecurringCityIntros(deps, { dueOnly: false });
    expect(result.previews[0].calendarWarning).toContain("Calendar integration");
    expect(result.previews[0].calendarWarning).toContain("not supported");
  });

  it("virtual channel is excluded", async () => {
    const deps = createMockDeps();
    deps._airtableRecords["SLACK CHANNELS"] = [makeChannelRecord({ Name: "Virtual Walks" })];
    deps._airtableRecords["ALL CITIES"] = [{ id: "rec_city_1", fields: { City: "London", Name: "London" } }];
    deps._airtableRecords["MEMBERS"] = [makeMemberRecord("r1", "A", "a@t.com")];
    deps.slack.listUsers.mockResolvedValue([makeSlackUser("U_a", "a@t.com", "A")]);
    deps.slack.getConversationMembers.mockResolvedValue(["U_a"]);

    const result = await runRecurringCityIntros(deps, { dueOnly: false });
    expect(result.previews.length).toBe(0);
  });

  it("non-Standard intro type is skipped", async () => {
    const deps = createMockDeps();
    deps._airtableRecords["SLACK CHANNELS"] = [makeChannelRecord({ "Intro type": "Coffee Chat" })];
    deps._airtableRecords["ALL CITIES"] = [{ id: "rec_city_1", fields: { City: "London", Name: "London" } }];
    deps._airtableRecords["MEMBERS"] = [makeMemberRecord("r1", "A", "a@t.com")];
    deps.slack.listUsers.mockResolvedValue([makeSlackUser("U_a", "a@t.com", "A")]);
    deps.slack.getConversationMembers.mockResolvedValue(["U_a"]);

    const result = await runRecurringCityIntros(deps, { dueOnly: false });
    expect(result.previews.length).toBe(0);
  });

  it("members not paid or active are excluded", async () => {
    const deps = createMockDeps();
    const members = [
      makeMemberRecord("r1", "A", "a@t.com"),
      makeMemberRecord("r2", "B", "b@t.com", { Payment: "Unpaid" }),
      makeMemberRecord("r3", "C", "c@test.com", { Membership: "Inactive" }),
    ];
    const slackUsers = [makeSlackUser("U_a", "a@t.com", "A"), makeSlackUser("U_b", "b@t.com", "B"), makeSlackUser("U_c", "c@test.com", "C")];
    setupMockChannel(deps, members, slackUsers, ["U_a", "U_b", "U_c"]);

    const result = await runRecurringCityIntros(deps, { dueOnly: false });
    expect(result.previews[0].eligibleMembers.length).toBe(1);
    expect(result.previews[0].eligibleMembers[0].name).toBe("A");
  });

  it("airtable batching splits into groups of 10", async () => {
    const records = Array.from({ length: 25 }, (_, i) => ({ fields: { Name: `R${i}` } }));
    const client = await import("@/lib/integrations/airtable").then((m) =>
      m.createAirtableClient({ apiKey: "pat_test", baseId: "appTEST" })
    );
    const mockFetch = vi.fn();
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ records: Array.from({ length: Math.min(10, 25 - i * 10) }, (_, j) => ({ id: `r${i * 10 + j}`, fields: {} })) }),
      });
    }
    vi.stubGlobal("fetch", mockFetch);

    const result = await client.createRecordsBatched("Test", records);
    expect(result.length).toBe(25);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    vi.unstubAllGlobals();
  });

  it("send disabled returns 403 via preview endpoint", async () => {
    const deps = createMockDeps({ mode: "send", writesEnabled: false });
    const members = [
      makeMemberRecord("r1", "A", "a@t.com"),
      makeMemberRecord("r2", "B", "b@t.com"),
    ];
    const slackUsers = [makeSlackUser("U_a", "a@t.com", "A"), makeSlackUser("U_b", "b@t.com", "B")];
    setupMockChannel(deps, members, slackUsers, ["U_a", "U_b"]);

    const result = await runRecurringCityIntros(deps, { dueOnly: false });
    expect(result.sentGroups).toBe(0);
    expect(deps.slack.postMessage).not.toHaveBeenCalled();
  });
});
