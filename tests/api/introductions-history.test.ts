import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createTestDb, resetIntroductionsV2Tables } from "../helpers/test-db";
import {
  introductionRuns,
  introductionGroups,
  introductionGroupMembers,
  introductionDeliveries,
  introductionDeliveryEvents,
  introductionPairScores,
  matchEvents,
  matchEventMatches,
} from "@/db/schema";

const test = await createTestDb({ introductionsV2: true, matchmake: true });
const { db } = test;

vi.mock("@/db", () => ({ db }));

vi.mock("@/lib/ops/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/auth")>();
  return {
    ...actual,
    requireOpsViewer: vi.fn().mockResolvedValue({
      userId: "user_viewer",
      role: "viewer",
      mode: "read_only",
    }),
  };
});

const route = await import("@/app/api/introductions/history/route");

afterAll(async () => {
  await test.close();
});

function snapshot(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    key: "at:rec_a",
    email: "nelson@example.com",
    airtableRecordId: "rec_a",
    name: "Nelson test",
    firstName: "Nelson",
    city: "Etobicoke",
    postcode: "M8V 1A1",
    industry: "HEALTH_WELLNESS",
    businessStage: "VALIDATING",
    professionalHeadline: "Wellness coach",
    phone: "4165550199",
    socialMedia: "linkedin|https://www.linkedin.com/in/nelson",
    website: "www.nelson.example",
    helpWanted: ["FUNDRAISING"],
    expertise: ["GROWTH_MARKETING"],
    connectionTypes: ["SIMILAR_STAGE_PEER"],
    ...overrides,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetIntroductionsV2Tables(db);
  await db.delete(matchEventMatches);
  await db.delete(matchEvents);

  await db.insert(introductionRuns).values([
    {
      id: "run_etobicoke",
      requestId: "req-run-etobicoke",
      source: "city",
      mode: "send",
      dryRun: false,
      status: "approved",
      deliveryMode: "production",
      cycleDate: "2026-08-24",
      cityCodesJson: JSON.stringify(["rec_etobicoke"]),
      totalGroups: 1,
      totalDeliveries: 2,
    },
    {
      id: "run_melbourne",
      requestId: "req-run-melbourne",
      source: "city",
      mode: "preview",
      dryRun: true,
      status: "planned",
      deliveryMode: "simulation",
      cycleDate: "2026-09-24",
      cityCodesJson: JSON.stringify(["rec_melbourne"]),
      totalGroups: 1,
    },
  ]);

  await db.insert(introductionGroups).values([
    {
      id: "grp_eto",
      runId: "run_etobicoke",
      source: "city",
      groupFingerprint: "fp-eto",
      status: "sent",
      cityName: "Etobicoke",
      overallScore: 0.79,
      scoreBreakdownJson: JSON.stringify({ proximity: 0.9, help_expertise: 0.5 }),
      emailSubjectSnapshot: "Your Etobicoke WLTH WLK crew is here",
      emailHtmlSnapshot: "<p>hi</p>",
      sentAt: new Date("2026-08-24T12:00:00Z"),
    },
    {
      id: "grp_mel",
      runId: "run_melbourne",
      source: "city",
      groupFingerprint: "fp-mel",
      status: "planned",
      cityName: "Melbourne",
      overallScore: 0.5,
      scoreBreakdownJson: JSON.stringify({ proximity: 0.5 }),
    },
  ]);

  await db.insert(introductionGroupMembers).values([
    {
      id: "gm_eto_1",
      groupId: "grp_eto",
      emailSnapshot: "nelson@example.com",
      airtableRecordId: "rec_a",
      role: "recurring",
      memberSnapshotJson: snapshot({}),
    },
    {
      id: "gm_eto_2",
      groupId: "grp_eto",
      emailSnapshot: "sota@example.com",
      airtableRecordId: "rec_b",
      role: "recurring",
      memberSnapshotJson: snapshot({
        key: "at:rec_b",
        email: "sota@example.com",
        airtableRecordId: "rec_b",
        name: "Sota one",
        firstName: "Sota",
      }),
    },
    {
      id: "gm_mel_1",
      groupId: "grp_mel",
      emailSnapshot: "mel@example.com",
      airtableRecordId: "rec_c",
      role: "recurring",
      memberSnapshotJson: snapshot({
        key: "at:rec_c",
        email: "mel@example.com",
        airtableRecordId: "rec_c",
        name: "Mel Member",
        city: "Melbourne",
      }),
    },
  ]);

  await db.insert(introductionDeliveries).values([
    {
      id: "dl_eto_1",
      runId: "run_etobicoke",
      groupId: "grp_eto",
      recipientEmail: "nelson@example.com",
      recipientName: "Nelson test",
      airtableRecordId: "rec_a",
      deliverToEmail: "demo@wlthwlks.com",
      originalToJson: JSON.stringify(["nelson@example.com", "sota@example.com"]),
      deliveryKey: "group:grp_eto:nelson@example.com",
      status: "delivered",
      resendMessageId: "resend_msg_1",
      attemptCount: 1,
      sentAt: new Date("2026-08-24T12:01:00Z"),
    },
    {
      id: "dl_eto_2",
      runId: "run_etobicoke",
      groupId: "grp_eto",
      recipientEmail: "sota@example.com",
      recipientName: "Sota one",
      airtableRecordId: "rec_b",
      deliverToEmail: "demo@wlthwlks.com",
      originalToJson: JSON.stringify(["nelson@example.com", "sota@example.com"]),
      deliveryKey: "group:grp_eto:sota@example.com",
      status: "sent",
      resendMessageId: "resend_msg_1",
      attemptCount: 1,
    },
  ]);

  await db.insert(introductionDeliveryEvents).values([
    {
      id: "ev_1",
      deliveryId: "dl_eto_1",
      eventType: "opened",
      providerEventId: "resend_msg_1",
      providerTs: new Date("2026-08-24T13:00:00Z"),
    },
  ]);

  await db.insert(introductionPairScores).values([
    {
      id: "ps_1",
      runId: "run_etobicoke",
      memberAKey: "at:rec_a",
      memberBKey: "at:rec_b",
      pairKey: "at:rec_a|at:rec_b",
      scoresJson: JSON.stringify({ proximity: 0.9 }),
      overall: 0.79,
    },
  ]);

  await db.insert(matchEvents).values([
    {
      id: "legacy_1",
      requestId: "req-legacy-1",
      createdAt: new Date("2026-07-01T10:00:00Z"),
      mode: "get-matched",
      dryRun: false,
      newMemberEmail: "nelson@example.com",
      newMemberCity: "Etobicoke",
      summary: "Matched 3 members",
      slackSentAt: new Date("2026-07-01T10:05:00Z"),
      slackRecipientCount: 3,
    },
    {
      id: "legacy_dry",
      requestId: "req-legacy-dry",
      createdAt: new Date("2026-07-02T10:00:00Z"),
      mode: "get-matched",
      dryRun: true,
      newMemberEmail: "ghost@example.com",
      newMemberCity: "Etobicoke",
    },
  ]);

  await db.insert(matchEventMatches).values([
    {
      id: "lm_1",
      matchEventId: "legacy_1",
      rank: 1,
      matchEmail: "sota@example.com",
      matchCity: "Etobicoke",
      similarityScore: 0.8,
      wasOnSlack: false,
    },
  ]);
});

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

async function runSearch(query: string) {
  const res = await route.GET(makeRequest(`http://localhost/api/introductions/history${query}`));
  const body = (await res.json()) as {
    success: boolean;
    results?: Array<{ source: string }>;
    message?: string;
  };
  return { status: res.status, body };
}

describe("GET /api/introductions/history", () => {
  it("requires ops auth", async () => {
    const { requireOpsViewer, OpsAuthError } = await import("@/lib/ops/auth");
    vi.mocked(requireOpsViewer).mockRejectedValueOnce(
      new OpsAuthError("UNAUTHENTICATED", "unauthenticated", 401)
    );
    const { status } = await runSearch("");
    expect(status).toBe(401);
  });

  it("returns every unified run and legacy event without filters", async () => {
    const { body } = await runSearch("");
    expect(body.success).toBe(true);
    const unified = body.results?.filter((r) => r.source === "unified") ?? [];
    const legacy = body.results?.filter((r) => r.source === "legacy") ?? [];
    expect(unified).toHaveLength(2);
    expect(legacy).toHaveLength(1);
  });

  it("filters by person email and keeps the whole group context", async () => {
    const { body } = await runSearch("?person=nelson@example.com");
    const unified = body.results?.find((r) => r.source === "unified") as
      | {
          run: { id: string };
          groups: Array<{ members: Array<{ email: string }>; deliveries: unknown[]; cityName: string }>;
          pairScores: unknown[];
        }
      | undefined;
    expect(unified).toBeDefined();
    expect(unified?.run.id).toBe("run_etobicoke");
    expect(unified?.groups).toHaveLength(1);
    const emails = unified?.groups[0].members.map((m) => m.email).sort();
    expect(emails).toEqual(["nelson@example.com", "sota@example.com"]);
    expect(unified?.groups[0].deliveries).toHaveLength(2);
    expect(unified?.pairScores).toHaveLength(1);
  });

  it("filters by person name via the member snapshot", async () => {
    const { body } = await runSearch("?person=Sota one");
    const unified = body.results?.filter((r) => r.source === "unified") ?? [];
    expect(unified).toHaveLength(1);
    expect((unified[0] as unknown as { run: { id: string } }).run.id).toBe("run_etobicoke");
  });

  it("filters by Airtable record id", async () => {
    const { body } = await runSearch("?person=rec_b");
    const unified = body.results?.filter((r) => r.source === "unified") ?? [];
    expect(unified).toHaveLength(1);
    expect((unified[0] as unknown as { run: { id: string } }).run.id).toBe("run_etobicoke");
  });

  it("filters by city code", async () => {
    const { body } = await runSearch("?city=rec_melbourne");
    const unified = body.results?.filter((r) => r.source === "unified") ?? [];
    expect(unified).toHaveLength(1);
    expect((unified[0] as unknown as { run: { id: string } }).run.id).toBe("run_melbourne");
  });

  it("combines person and city filters", async () => {
    const { body } = await runSearch("?person=nelson@example.com&city=rec_melbourne");
    const unified = body.results?.filter((r) => r.source === "unified") ?? [];
    expect(unified).toHaveLength(0);
  });

  it("includes legacy events matching the person and skips dry runs", async () => {
    const { body } = await runSearch("?person=sota@example.com");
    const legacy = body.results?.filter((r) => r.source === "legacy") as unknown as Array<{
      event: { id: string };
      matches: Array<{ email: string; similarityScore: number | null }>;
    }>;
    expect(legacy).toHaveLength(1);
    expect(legacy[0].event.id).toBe("legacy_1");
    expect(legacy[0].matches[0]).toMatchObject({ email: "sota@example.com", similarityScore: 0.8 });
  });

  it("resolves help/expertise codes to labels and keeps the redirect audit", async () => {
    const { body } = await runSearch("?person=nelson@example.com");
    const unified = body.results?.find((r) => r.source === "unified") as
      | {
          groups: Array<{
            members: Array<{ helpWanted: string[]; expertise: string[] }>;
            deliveries: Array<{ originalTo: string[] | null; status: string; events: Array<{ eventType: string }> }>;
          }>;
        }
      | undefined;
    const member = unified?.groups[0].members[0];
    expect(member?.helpWanted).toEqual(["Fundraising"]);
    expect(member?.expertise).toEqual(["Growth & marketing"]);
    const delivery = unified?.groups[0].deliveries[0];
    expect(delivery?.status).toBe("delivered");
    expect(delivery?.originalTo).toEqual(["nelson@example.com", "sota@example.com"]);
    expect(delivery?.events[0].eventType).toBe("opened");
  });
});
