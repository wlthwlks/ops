import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────
// These must be declared BEFORE the module under test is imported so vitest
// hoists them ahead of the runtime require.

vi.mock("@/lib/integrations/airtable");
vi.mock("@/lib/integrations/pinecone");
vi.mock("@/lib/integrations/slack");
vi.mock("@/lib/integrations/resend");
vi.mock("@/lib/messaging/generate-match-message");

// Mock the DB module so importing daily-match-message doesn't try to connect
// to Neon (db/index.ts throws on import when POSTGRES_URL is unset).
vi.mock("@/db", () => ({ db: {} as any }));

// Mock the recorder helpers so we can assert call counts/args.
vi.mock("@/lib/matchmake/record", () => ({
  recordMatchEvent: vi.fn(),
  recordSlackDelivery: vi.fn(),
  recordEmailDelivery: vi.fn(),
}));

const { runDailyMatchMessage } = await import("@/lib/ops/daily-match-message");
const { createAirtableClient } = await import("@/lib/integrations/airtable");
const { createPineconeClient } = await import("@/lib/integrations/pinecone");
const { createSlackClient } = await import("@/lib/integrations/slack");
const { createResendClient } = await import("@/lib/integrations/resend");
const { generateMatchMessage } = await import("@/lib/messaging/generate-match-message");
const recordMod = await import("@/lib/matchmake/record");

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx() {
  const logs: string[] = [];
  return { log: async (msg: string) => { logs.push(msg); }, db: {} as any, logs };
}

function makePineconeClient() {
  return {
    queryByVector: vi
      .fn()
      .mockResolvedValueOnce([
        { id: "rec-new", score: 1, metadata: { email: "new@test.com" } },
      ])
      .mockResolvedValueOnce([
        { id: "rec-match1", score: 0.95, metadata: { name: "Alice", email: "alice@test.com", industry: "Tech", businessStage: "Growth", nearbyLocation: "Shoreditch", postcode: "EC1V", city: "London", traction: "50k", hasBusinessDomain: true } },
        { id: "rec-match2", score: 0.90, metadata: { name: "Bob", email: "bob@test.com", industry: "Finance", businessStage: "Early", nearbyLocation: "Canary", postcode: "E14", city: "London", traction: "10k", hasBusinessDomain: false } },
      ]),
    fetchById: vi.fn().mockResolvedValue({
      id: "rec-new",
      values: new Array(1536).fill(0.1),
      metadata: { nearbyLocation: "Shoreditch", businessStage: "Growth" },
    }),
    deleteByIds: vi.fn(),
    upsertVectors: vi.fn(),
    fetchMetadataByIds: vi.fn(),
  };
}

function makeSlackClient(opts: { lookupResults?: (any | null)[] } = {}) {
  const lookupResults = opts.lookupResults ?? [
    { id: "U001" },
    { id: "U002" },
    { id: "U003" },
  ];
  let lookupIdx = 0;
  return {
    lookupByEmail: vi.fn().mockImplementation(() =>
      Promise.resolve(lookupResults[lookupIdx++] ?? null)
    ),
    conversationsOpen: vi.fn().mockResolvedValue({ channelId: "C123" }),
    postMessage: vi.fn().mockResolvedValue({ ts: "ts-001" }),
  };
}

function makeAirtableClient(records: any[]) {
  return { listRecords: vi.fn().mockResolvedValue(records) };
}

function makeResendClient(opts: { sendResult?: any } = {}) {
  return {
    sendEmail: vi.fn().mockResolvedValue(opts.sendResult ?? { id: "email-001" }),
  };
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runDailyMatchMessage — DB tracking wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
    delete process.env.SLACK_OVERSIGHT_EMAILS;

    vi.mocked(generateMatchMessage).mockReturnValue({ body: "generated-message", recipients: [] });
    vi.mocked(recordMod.recordMatchEvent).mockResolvedValue({
      matchEventId: "evt-001",
      newMemberId: "mem-new",
      matchMemberIds: ["mem-a", "mem-b"],
      isDuplicate: false,
    });
    vi.mocked(recordMod.recordSlackDelivery).mockResolvedValue(undefined);
    vi.mocked(recordMod.recordEmailDelivery).mockResolvedValue(undefined);
  });

  it("send mode: recordMatchEvent is called once per delivery with the right shape", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    vi.mocked(createSlackClient).mockReturnValue(makeSlackClient() as any);
    vi.mocked(createResendClient).mockReturnValue(makeResendClient() as any);

    const { log, db } = makeCtx();
    await runDailyMatchMessage(
      "2026-01-01",
      "2026-01-01",
      { log, db },
      "send",
      undefined,
      undefined,
      undefined,
      "req-master-1"
    );

    expect(recordMod.recordMatchEvent).toHaveBeenCalledTimes(1);
    const call = vi.mocked(recordMod.recordMatchEvent).mock.calls[0]![0];
    expect(call.mode).toBe("send");
    expect(call.dryRun).toBe(false);
    // Per-event idempotency key composes the master requestId + new member email.
    expect(call.requestId).toBe("req-master-1:new@test.com");
    expect(call.newMember).toMatchObject({
      email: "new@test.com",
      postcode: "EC1V 9HX",
      city: "London",
      industry: "Tech",
    });
    expect(call.matches).toHaveLength(2);
    expect(call.matches[0]).toMatchObject({
      email: "alice@test.com",
      rank: 1,
      similarityScore: 0.95,
      wasOnSlack: true,
    });
    expect(call.matches[1]).toMatchObject({
      email: "bob@test.com",
      rank: 2,
      similarityScore: 0.9,
      wasOnSlack: true,
    });
  });

  it("send mode: recordSlackDelivery is called after a successful Slack send", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    vi.mocked(createSlackClient).mockReturnValue(makeSlackClient() as any);
    vi.mocked(createResendClient).mockReturnValue(makeResendClient() as any);

    const { log, db } = makeCtx();
    await runDailyMatchMessage(
      "2026-01-01",
      "2026-01-01",
      { log, db },
      "send",
      undefined,
      undefined,
      undefined,
      "req-2"
    );

    expect(recordMod.recordSlackDelivery).toHaveBeenCalledTimes(1);
    const [, eventId, payload] = vi.mocked(recordMod.recordSlackDelivery).mock.calls[0]!;
    expect(eventId).toBe("evt-001");
    expect(payload).toMatchObject({
      slackChannelId: "C123",
      slackMessageTs: expect.stringMatching(/.+/),
      slackRecipientCount: 3,
    });
  });

  it("send mode: recordSlackDelivery NOT called when <2 members on Slack", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    // Only 1 member on Slack (rest return null)
    vi.mocked(createSlackClient).mockReturnValue(
      makeSlackClient({ lookupResults: [{ id: "U001" }, null, null] }) as any
    );
    vi.mocked(createResendClient).mockReturnValue(makeResendClient() as any);

    const { log, db } = makeCtx();
    await runDailyMatchMessage(
      "2026-01-01",
      "2026-01-01",
      { log, db },
      "send",
      undefined,
      undefined,
      undefined,
      "req-3"
    );

    // recordMatchEvent still runs (we track the intent regardless of slack outcome)
    expect(recordMod.recordMatchEvent).toHaveBeenCalledTimes(1);
    // But Slack delivery is NOT recorded because nothing was actually sent.
    expect(recordMod.recordSlackDelivery).not.toHaveBeenCalled();
  });

  it("send mode: single CC'd send → one Resend call, one recordEmailDelivery per recipient, all share message_id", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    vi.mocked(createSlackClient).mockReturnValue(makeSlackClient() as any);

    const sendEmail = vi.fn().mockResolvedValue({ id: "rid-shared" });
    vi.mocked(createResendClient).mockReturnValue({ sendEmail } as any);

    const { log, db } = makeCtx();
    await runDailyMatchMessage(
      "2026-01-01",
      "2026-01-01",
      { log, db },
      "send",
      undefined,
      undefined,
      undefined,
      "req-4"
    );

    // Exactly one Resend invocation — new member as To, matches as Cc.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0]).toBe("new@test.com");
    expect(sendEmail.mock.calls[0]![3]).toEqual({
      cc: ["alice@test.com", "bob@test.com"],
      replyTo: ["new@test.com", "alice@test.com", "bob@test.com"],
    });

    // Three audit rows (new + alice + bob), all sharing the same message id.
    expect(recordMod.recordEmailDelivery).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(recordMod.recordEmailDelivery).mock.calls;
    for (const c of calls) {
      expect(c[2].status).toBe("sent");
      expect(c[2].resendMessageId).toBe("rid-shared");
    }
    const newMemberCall = calls.find((c) => c[2].recipientEmail === "new@test.com");
    expect(newMemberCall?.[2].recipientRole).toBe("new_member");
    const matchCalls = calls.filter((c) => c[2].recipientRole === "match");
    expect(matchCalls).toHaveLength(2);
  });

  it("send mode: single send failure → all recipients tracked as failed with no message_id", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    vi.mocked(createSlackClient).mockReturnValue(makeSlackClient() as any);
    const sendEmail = vi.fn().mockResolvedValue(null);
    vi.mocked(createResendClient).mockReturnValue({ sendEmail } as any);

    const { log, db } = makeCtx();
    await runDailyMatchMessage(
      "2026-01-01",
      "2026-01-01",
      { log, db },
      "send",
      undefined,
      undefined,
      undefined,
      "req-4b"
    );

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(recordMod.recordEmailDelivery).toHaveBeenCalledTimes(3);
    for (const c of vi.mocked(recordMod.recordEmailDelivery).mock.calls) {
      expect(c[2].status).toBe("failed");
      expect(c[2].error).toBe("Resend returned no id");
      expect(c[2].resendMessageId).toBeUndefined();
    }
  });

  it("preview mode: NONE of the recorders are called", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    vi.mocked(createSlackClient).mockReturnValue(makeSlackClient() as any);
    vi.mocked(createResendClient).mockReturnValue(makeResendClient() as any);

    const { log, db } = makeCtx();
    await runDailyMatchMessage(
      "2026-01-01",
      "2026-01-01",
      { log, db },
      "preview"
    );

    expect(recordMod.recordMatchEvent).not.toHaveBeenCalled();
    expect(recordMod.recordSlackDelivery).not.toHaveBeenCalled();
    expect(recordMod.recordEmailDelivery).not.toHaveBeenCalled();
  });

  it("a failure in recordMatchEvent does NOT prevent Slack or email sends", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtableClient([NEW_MEMBER_RECORD]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePineconeClient() as any);
    const slack = makeSlackClient();
    vi.mocked(createSlackClient).mockReturnValue(slack as any);
    const resend = makeResendClient();
    vi.mocked(createResendClient).mockReturnValue(resend as any);

    vi.mocked(recordMod.recordMatchEvent).mockRejectedValueOnce(new Error("DB exploded"));

    const { log, db } = makeCtx();
    const result = await runDailyMatchMessage(
      "2026-01-01",
      "2026-01-01",
      { log, db },
      "send",
      undefined,
      undefined,
      undefined,
      "req-5"
    );

    expect(result.success).toBe(true);
    // Slack STILL sent
    expect(slack.postMessage).toHaveBeenCalledOnce();
    // Email STILL sent
    expect(resend.sendEmail).toHaveBeenCalled();
    // Subsequent recorder calls are skipped because matchEventId was never set,
    // which is the safe path — we don't want to try writing children when the
    // parent insert failed.
    expect(recordMod.recordSlackDelivery).not.toHaveBeenCalled();
    expect(recordMod.recordEmailDelivery).not.toHaveBeenCalled();
  });
});
