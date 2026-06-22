import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDailyMatchMessage } from "@/lib/ops/daily-match-message";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx() {
  const logs: string[] = [];
  return { log: async (msg: string) => { logs.push(msg); }, db: {} as any, logs };
}

function makePineconeClient(opts: {
  emailLookupResult?: any[];
  fetchByIdResult?: any;
  queryResult?: any[];
} = {}) {
  return {
    queryByVector: vi
      .fn()
      .mockResolvedValueOnce(
        opts.emailLookupResult ?? [
          { id: "rec-new", score: 1, metadata: { email: "new@test.com" } },
        ]
      )
      .mockResolvedValueOnce(
        opts.queryResult ?? [
          { id: "rec-match1", score: 0.95, metadata: { name: "Alice", email: "alice@test.com", industry: "Tech", businessStage: "Growth", nearbyLocation: "Shoreditch | Old Street", postcode: "EC1V", city: "London", traction: "50k", hasBusinessDomain: true } },
          { id: "rec-match2", score: 0.90, metadata: { name: "Bob", email: "bob@test.com", industry: "Finance", businessStage: "Early", nearbyLocation: "Canary Wharf", postcode: "E14", city: "London", traction: "10k", hasBusinessDomain: false } },
        ]
      ),
    fetchById: vi.fn().mockResolvedValue(
      opts.fetchByIdResult ?? {
        id: "rec-new",
        values: new Array(1536).fill(0.1),
        metadata: { nearbyLocation: "Shoreditch | Old Street", businessStage: "Growth" },
      }
    ),
    deleteByIds: vi.fn(),
    upsertVectors: vi.fn(),
    fetchMetadataByIds: vi.fn(),
  };
}

function makeSlackClient(opts: {
  lookupResults?: (any | null)[];
  channelId?: string;
} = {}) {
  const lookupResults = opts.lookupResults ?? [
    { id: "U001" }, // new member
    { id: "U002" }, // alice
    { id: "U003" }, // bob
  ];
  let lookupIdx = 0;
  return {
    lookupByEmail: vi.fn().mockImplementation(() =>
      Promise.resolve(lookupResults[lookupIdx++] ?? null)
    ),
    conversationsOpen: vi.fn().mockResolvedValue({ channelId: opts.channelId ?? "C123" }),
    postMessage: vi.fn().mockResolvedValue({ ts: "ts-001" }),
  };
}

function makeAirtableClient(records: any[]) {
  return { listRecords: vi.fn().mockResolvedValue(records) };
}

function makeResendClient() {
  return { sendEmail: vi.fn().mockResolvedValue({ id: "email-001" }) };
}

const BASE_ENV = {
  AIRTABLE_GET_DATA_TOKEN: "at-token",
  AIRTABLE_BASE_ID: "base-id",
  PINECONE_API_KEY: "pc-key",
  PINECONE_INDEX_NAME: "pc-index",
  SLACK_BOT_TOKEN: "slack-token",
  RESEND_API_KEY: "resend-key",
};

const NEW_MEMBER_RECORD = {
  id: "rec-new",
  fields: {
    email: "new@test.com",
    Name: "New Member",
    "post code": "EC1V 9HX",
    City: "London",
    Industry: "Tech",
    Revenue: "50k",
  },
};

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@/lib/integrations/airtable");
vi.mock("@/lib/integrations/pinecone");
vi.mock("@/lib/integrations/slack");
vi.mock("@/lib/integrations/resend");
vi.mock("@/lib/messaging/generate-match-message");
// Stub the DB and recorder so importing daily-match-message doesn't try to
// connect to Neon and tracking helpers don't run for real here.
vi.mock("@/db", () => ({ db: {} as any }));
vi.mock("@/lib/matchmake/record", () => ({
  recordMatchEvent: vi.fn().mockResolvedValue({
    matchEventId: "evt-stub",
    newMemberId: "mem-stub",
    matchMemberIds: [],
    isDuplicate: false,
  }),
  recordSlackDelivery: vi.fn().mockResolvedValue(undefined),
  recordEmailDelivery: vi.fn().mockResolvedValue(undefined),
}));

const { createAirtableClient } = await import("@/lib/integrations/airtable");
const { createPineconeClient } = await import("@/lib/integrations/pinecone");
const { createSlackClient } = await import("@/lib/integrations/slack");
const { createResendClient } = await import("@/lib/integrations/resend");
const { generateMatchMessage } = await import("@/lib/messaging/generate-match-message");

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runDailyMatchMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
    delete process.env.SLACK_OVERSIGHT_EMAILS;

    vi.mocked(generateMatchMessage).mockReturnValue({ body: "generated-message", recipients: [] });
  });

  it("returns empty deliveries when no members in date range", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    vi.mocked(createSlackClient).mockReturnValue(makeSlackClient() as any);
    vi.mocked(createResendClient).mockReturnValue(makeResendClient() as any);

    const { log, db } = makeCtx();
    const result = await runDailyMatchMessage("2026-01-01", "2026-01-01", { log, db });

    expect(result.success).toBe(true);
    expect(result.deliveries).toHaveLength(0);
  });

  it("preview mode: populates slackMessage and emailPreview, no sends", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    const slack = makeSlackClient();
    vi.mocked(createSlackClient).mockReturnValue(slack as any);
    vi.mocked(createResendClient).mockReturnValue(makeResendClient() as any);

    const { log, db } = makeCtx();
    const result = await runDailyMatchMessage("2026-01-01", "2026-01-01", { log, db }, "preview");

    expect(result.success).toBe(true);
    const d = result.deliveries[0];
    expect(d.slackMessage).toBe("generated-message");
    expect(d.emailPreview).toBe("generated-message");
    expect(d.slackSent).toBe(false);
    expect(d.emailsSent).toHaveLength(0);
    expect(slack.conversationsOpen).not.toHaveBeenCalled();
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  it("send mode happy path: opens DM and sends Slack when >= 2 on Slack, sends emails", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    const slack = makeSlackClient({ lookupResults: [{ id: "U001" }, { id: "U002" }, { id: "U003" }] });
    vi.mocked(createSlackClient).mockReturnValue(slack as any);
    const resend = makeResendClient();
    vi.mocked(createResendClient).mockReturnValue(resend as any);

    const { log, db } = makeCtx();
    const result = await runDailyMatchMessage("2026-01-01", "2026-01-01", { log, db }, "send");

    expect(result.success).toBe(true);
    const d = result.deliveries[0];
    expect(d.slackSent).toBe(true);
    expect(d.slackChannelId).toBe("C123");
    expect(slack.conversationsOpen).toHaveBeenCalledOnce();
    expect(slack.postMessage).toHaveBeenCalledWith("C123", "generated-message");
    // One Resend call total — new member as To, matches as Cc, reply-to set to
    // all humans so Reply/Reply-All never lands at the donotreply From: address.
    expect(resend.sendEmail).toHaveBeenCalledTimes(1);
    const [toArg, , , optsArg] = resend.sendEmail.mock.calls[0]!;
    expect(toArg).toBe("new@test.com");
    expect(optsArg).toEqual({
      cc: ["alice@test.com", "bob@test.com"],
      replyTo: ["new@test.com", "alice@test.com", "bob@test.com"],
    });
    // But emailsSent still tracks 3 recipients (audit-friendly).
    expect(d.emailsSent).toHaveLength(3);
  });

  it("send mode <2 on Slack: skips Slack DM, email still sent", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    // Only 1 member on Slack, rest return null
    const slack = makeSlackClient({ lookupResults: [{ id: "U001" }, null, null] });
    vi.mocked(createSlackClient).mockReturnValue(slack as any);
    const resend = makeResendClient();
    vi.mocked(createResendClient).mockReturnValue(resend as any);

    const { log, db } = makeCtx();
    const result = await runDailyMatchMessage("2026-01-01", "2026-01-01", { log, db }, "send");

    expect(result.success).toBe(true);
    const d = result.deliveries[0];
    expect(d.slackSent).toBe(false);
    expect(slack.conversationsOpen).not.toHaveBeenCalled();
    expect(slack.postMessage).not.toHaveBeenCalled();
    // Email still goes out
    expect(resend.sendEmail).toHaveBeenCalled();
  });

  it("editedMessages: final Slack message body equals edited string", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    const slack = makeSlackClient({ lookupResults: [{ id: "U001" }, { id: "U002" }, { id: "U003" }] });
    vi.mocked(createSlackClient).mockReturnValue(slack as any);
    vi.mocked(createResendClient).mockReturnValue(makeResendClient() as any);

    const editedMessages = { "new@test.com": "CUSTOM SLACK MESSAGE" };
    const { log, db } = makeCtx();
    await runDailyMatchMessage("2026-01-01", "2026-01-01", { log, db }, "send", undefined, editedMessages);

    expect(slack.postMessage).toHaveBeenCalledWith("C123", "CUSTOM SLACK MESSAGE");
  });

  it("editedEmails: final email body equals edited HTML, not generated", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    const slack = makeSlackClient({ lookupResults: [{ id: "U001" }, { id: "U002" }, null] });
    vi.mocked(createSlackClient).mockReturnValue(slack as any);
    const resend = makeResendClient();
    vi.mocked(createResendClient).mockReturnValue(resend as any);

    const editedEmails = { "new@test.com": "<p>CUSTOM HTML EMAIL</p>" };
    const { log, db } = makeCtx();
    await runDailyMatchMessage("2026-01-01", "2026-01-01", { log, db }, "send", undefined, undefined, editedEmails);

    // All sendEmail calls should use the custom HTML body
    for (const call of resend.sendEmail.mock.calls) {
      expect(call[2]).toBe("<p>CUSTOM HTML EMAIL</p>");
    }
  });

  it("Cc/Bcc dedup: duplicate match emails appear only once in Cc; oversight that overlaps a match stays in Cc only (not duplicated in Bcc)", async () => {
    process.env.SLACK_OVERSIGHT_EMAILS = "alice@test.com, oversight@test.com";
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    // Pinecone returns ALICE TWICE (case-variant) plus Bob — Cc must dedupe.
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient({
      queryResult: [
        { id: "rec-a1", score: 0.95, metadata: { name: "Alice", email: "Alice@test.com", industry: "Tech", businessStage: "Growth" } },
        { id: "rec-a2", score: 0.90, metadata: { name: "Alice", email: "alice@test.com", industry: "Tech", businessStage: "Growth" } },
        { id: "rec-b",  score: 0.85, metadata: { name: "Bob",   email: "bob@test.com",   industry: "Finance", businessStage: "Early" } },
      ],
    }) as any);
    vi.mocked(createSlackClient).mockReturnValue(makeSlackClient({
      lookupResults: [{ id: "U001" }, { id: "U002" }, { id: "U003" }, { id: "U004" }, null, null],
    }) as any);
    const resend = makeResendClient();
    vi.mocked(createResendClient).mockReturnValue(resend as any);

    const { log, db } = makeCtx();
    await runDailyMatchMessage("2026-01-01", "2026-01-01", { log, db }, "send");

    const [, , , opts] = resend.sendEmail.mock.calls[0]!;
    // Cc: alice appears ONCE despite two duplicates from Pinecone, plus bob
    expect(opts.cc).toEqual(["alice@test.com", "bob@test.com"]);
    // Bcc: alice@test.com is already in Cc as a match → MUST NOT also appear in Bcc.
    //       oversight@test.com is not a match → goes to Bcc.
    expect(opts.bcc).toEqual(["oversight@test.com"]);
    // Sanity: NO recipient appears in both Cc and Bcc.
    const ccSet = new Set(opts.cc as string[]);
    for (const b of (opts.bcc as string[])) {
      expect(ccSet.has(b)).toBe(false);
    }
  });

  it("Cc/Bcc dedup: oversight email that equals the new joiner is dropped entirely (already in To)", async () => {
    // The new joiner IS the oversight email — should appear ONCE, as To.
    process.env.SLACK_OVERSIGHT_EMAILS = "new@test.com,realoversight@test.com";
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    vi.mocked(createSlackClient).mockReturnValue(makeSlackClient({
      lookupResults: [{ id: "U001" }, { id: "U002" }, { id: "U003" }, null, null],
    }) as any);
    const resend = makeResendClient();
    vi.mocked(createResendClient).mockReturnValue(resend as any);

    const { log, db } = makeCtx();
    await runDailyMatchMessage("2026-01-01", "2026-01-01", { log, db }, "send");

    const [toArg, , , opts] = resend.sendEmail.mock.calls[0]!;
    expect(toArg).toBe("new@test.com");
    expect(opts.cc).toEqual(["alice@test.com", "bob@test.com"]);
    // Only the OTHER oversight makes it to Bcc; new@test.com is in To only.
    expect(opts.bcc).toEqual(["realoversight@test.com"]);
    expect((opts.bcc as string[]).includes("new@test.com")).toBe(false);
  });

  it("SLACK_OVERSIGHT_EMAILS: oversight users BCC'd on the introduction email, not in Cc or Reply-To", async () => {
    process.env.SLACK_OVERSIGHT_EMAILS = "oversight1@test.com, oversight2@test.com";
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    const slack = makeSlackClient({
      lookupResults: [{ id: "U001" }, { id: "U002" }, { id: "U003" }, null, null],
    });
    vi.mocked(createSlackClient).mockReturnValue(slack as any);
    const resend = makeResendClient();
    vi.mocked(createResendClient).mockReturnValue(resend as any);

    const { log, db } = makeCtx();
    await runDailyMatchMessage("2026-01-01", "2026-01-01", { log, db }, "send");

    expect(resend.sendEmail).toHaveBeenCalledTimes(1);
    const [, , , opts] = resend.sendEmail.mock.calls[0]!;
    // Cc — visible, matches only
    expect(opts.cc).toEqual(["alice@test.com", "bob@test.com"]);
    // Bcc — hidden, oversight only
    expect(opts.bcc).toEqual(["oversight1@test.com", "oversight2@test.com"]);
    // Reply-To excludes oversight so they're not exposed in message headers
    expect(opts.replyTo).toEqual(["new@test.com", "alice@test.com", "bob@test.com"]);
  });

  it("SLACK_OVERSIGHT_EMAILS: oversight users added to DM and looked up via lookupByEmail", async () => {
    process.env.SLACK_OVERSIGHT_EMAILS = "oversight@test.com";
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    // 3 member lookups + 1 oversight lookup
    const slack = makeSlackClient({
      lookupResults: [{ id: "U001" }, { id: "U002" }, { id: "U003" }, { id: "U-OVERSIGHT" }],
    });
    vi.mocked(createSlackClient).mockReturnValue(slack as any);
    vi.mocked(createResendClient).mockReturnValue(makeResendClient() as any);

    const { log, db } = makeCtx();
    const result = await runDailyMatchMessage("2026-01-01", "2026-01-01", { log, db }, "send");

    expect(result.success).toBe(true);
    // oversight lookup should be called with oversight email
    const lookupCalls = slack.lookupByEmail.mock.calls.map((c: any[]) => c[0]);
    expect(lookupCalls).toContain("oversight@test.com");
    // conversationsOpen should include the oversight user ID
    const openArgs = slack.conversationsOpen.mock.calls[0][0] as string[];
    expect(openArgs).toContain("U-OVERSIGHT");
  });

  it("result shape matches MatchMessageResult contract", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    vi.mocked(createSlackClient).mockReturnValue(makeSlackClient() as any);
    vi.mocked(createResendClient).mockReturnValue(makeResendClient() as any);

    const { log, db } = makeCtx();
    const result = await runDailyMatchMessage("2026-01-01", "2026-01-01", { log, db }, "preview");

    expect(result).toMatchObject({
      success: expect.any(Boolean),
      summary: expect.any(String),
      deliveries: expect.any(Array),
    });
    const d = result.deliveries[0];
    expect(d).toMatchObject({
      newMemberEmail: "new@test.com",
      newMemberName: "New Member",
      slackSent: expect.any(Boolean),
      emailsSent: expect.any(Array),
      emailsFailed: expect.any(Array),
      matches: expect.any(Array),
    });
  });

  it("returns failure when Airtable credentials missing", async () => {
    delete process.env.AIRTABLE_GET_DATA_TOKEN;
    const { log, db } = makeCtx();
    const result = await runDailyMatchMessage("2026-01-01", "2026-01-01", { log, db });
    expect(result.success).toBe(false);
    expect(result.summary).toContain("Airtable");
  });
});
