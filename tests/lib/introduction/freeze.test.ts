import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  computePlanHash,
  deliveryKeyFor,
  freezeIntroductionRun,
  FreezeError,
} from "@/lib/introduction/freeze";
import { runIntroductionPreview, applyPlanEdit, type IntroductionPlanDeps } from "@/lib/introduction/plan";
import { processDeliveryBatch } from "@/lib/introduction/delivery-queue";
import {
  introductionRuns,
  introductionGroups,
  introductionDeliveries,
  matchEvents,
  matchEventMatches,
} from "@/db/schema";
import { setGlobalIntroductionConfig, upsertCitySettings } from "@/lib/introduction/settings";
import { ensureDefaultTemplate, createEmailTemplate, publishEmailTemplate } from "@/lib/introduction/templates";
import { setMatchingOptionsCatalogForTests } from "@/lib/forms/reference-data/matching-options-catalog";
import { eq } from "drizzle-orm";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import type { PineconeClient, VectorRecord } from "@/lib/integrations/pinecone";

vi.mock("@/lib/geo/geocode", () => ({
  geocode: vi.fn(async (postcode: string) => ({
    lat: 51.5 + postcode.length * 0.001,
    lon: -0.12 + postcode.length * 0.001,
    displayName: `${postcode}, London, UK`,
  })),
  extractOutcode: (value: string) => value,
}));

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

const airtableList = vi.fn();
const airtableGetRecord = vi.fn();
const pineconeFetch = vi.fn();

function makeDeps(): IntroductionPlanDeps {
  return {
    db,
    log: () => {},
    airtable: {
      listRecords: airtableList,
      getRecord: airtableGetRecord,
    } as unknown as AirtableClient,
    pinecone: { fetchByIds: pineconeFetch } as unknown as PineconeClient,
    now: new Date("2026-08-16T09:00:00Z"),
  };
}

function memberRecord(id: string): AirtableRecord {
  return {
    id,
    fields: {
      email: `${id.replace(/^rec_/, "")}@example.com`,
      Name: `Name ${id}`,
      "First Name": `First${id.replace(/^rec_/, "")}`,
      "Last Name": "Last",
      City: "London",
      "post code": "SW1A 1AA",
      Membership: "Active",
      Payment: "Paid",
      "Service access until": "",
      "Recurring intro status": "",
      "Recurring pause until": "",
      Industry: "TECH_SAAS",
      "Business stage": "EARLY_TRACTION",
      "Connection type": ["SIMILAR_STAGE_PEER"],
      "Professional Headline": `Headline ${id}`,
      "Current 90-day goal": `Goal ${id}`,
      "Help wanted": ["FUNDRAISING"],
      "Help wanted context": "Context",
      Expertise: ["GROWTH_MARKETING"],
      "Expertise context": "Context",
      "phone number": "+61 400 000 000",
      "social media": "@member",
      "Business website": "www.example.com",
    },
  };
}

const records = [memberRecord("rec_a"), memberRecord("rec_b"), memberRecord("rec_c"), memberRecord("rec_d")];

beforeAll(async () => {
  const test = await createTestDb({ introductionsV2: true, matchmake: true });
  db = test.db;
  close = test.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await resetIntroductionsV2Tables(db);
  await db.delete(matchEventMatches);
  await db.delete(matchEvents);
  airtableGetRecord.mockResolvedValue({ id: "rec_city_london", fields: { City: "London" } });
  airtableList.mockImplementation(async (table: string) => {
    if (table === "MATCHING OPTIONS") return [];
    return records;
  });
  pineconeFetch.mockImplementation(async (ids: string[]) => {
    const map = new Map<string, VectorRecord>();
    for (const id of ids) {
      map.set(id, { id, values: [1, 0, 0], metadata: {} });
    }
    return map;
  });
});
async function makePlan(): Promise<string> {
  const result = await runIntroductionPreview(makeDeps(), {
    cityCode: "rec_city_london",
    cycleDate: "2026-08-16",
  });
  return result.runId!;
}

describe("computePlanHash", () => {
  it("is deterministic and order-insensitive for group/member sorting", () => {
    const base = {
      runId: "run_1",
      cityCodesJson: JSON.stringify(["rec_city"]),
      cycleDate: "2026-08-16",
      deliveryMode: "canary" as const,
      profileVersionId: "pv_1",
      templateVersionId: "tv_1",
      groups: [
        { fingerprint: "b|a", members: ["em:b@x.com", "em:a@x.com"] },
        { fingerprint: "c|d", members: ["em:d@x.com", "em:c@x.com"] },
      ],
    };
    const reversed = {
      ...base,
      groups: [
        { fingerprint: "c|d", members: ["em:c@x.com", "em:d@x.com"] },
        { fingerprint: "b|a", members: ["em:a@x.com", "em:b@x.com"] },
      ],
    };
    expect(computePlanHash(base)).toBe(computePlanHash(reversed));
    expect(computePlanHash(base)).not.toBe(computePlanHash({ ...base, deliveryMode: "production" }));
  });
});

describe("deliveryKeyFor", () => {
  it("is stable and case-insensitive for the same recipient", () => {
    const a = deliveryKeyFor("grp_1", "A@X.com");
    const b = deliveryKeyFor("grp_1", "a@x.com");
    expect(a).toBe(b);
    expect(a).not.toBe(deliveryKeyFor("grp_2", "a@x.com"));
  });
});

describe("freezeIntroductionRun", () => {
  it("freezes the plan, stores render snapshots and creates delivery jobs", async () => {
    await ensureDefaultTemplate(db);
    const runId = await makePlan();

    const result = await freezeIntroductionRun(db, { runId, deliveryMode: "production" });
    expect(result.success).toBe(true);
    expect(result.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.deliveryMode).toBe("production");
    expect(result.deliveryCount).toBe(4);

    const runs = await db.select().from(introductionRuns).where(eq(introductionRuns.id, runId));
    expect(runs[0].status).toBe("approved");
    expect(runs[0].planHash).toBe(result.planHash);
    expect(runs[0].totalDeliveries).toBe(4);

    const groups = await db.select().from(introductionGroups).where(eq(introductionGroups.runId, runId));
    for (const group of groups) {
      expect(group.status).toBe("approved");
      expect(group.emailSubjectSnapshot).not.toBeNull();
      expect(group.emailSubjectSnapshot).toContain("London");
      expect(group.emailHtmlSnapshot).toContain("reply-all");
      expect(group.emailHtmlSnapshot).not.toContain("{{");
      // Member cards carry phone/social/website.
      expect(group.emailHtmlSnapshot).toContain("Phone number:");
      expect(group.emailHtmlSnapshot).toContain("+61 400 000 000");
      expect(group.emailHtmlSnapshot).toContain("@member");
      expect(group.emailHtmlSnapshot).toContain("https://www.example.com");
    }

    const deliveries = await db.select().from(introductionDeliveries).where(eq(introductionDeliveries.runId, runId));
    expect(deliveries).toHaveLength(4);
    for (const delivery of deliveries) {
      expect(delivery.deliveryKey).toMatch(/^group:[a-f0-9-]+:[a-f0-9]+$/);
      expect(delivery.deliverToEmail).toBe(delivery.recipientEmail);
      expect(delivery.status).toBe("pending");
    }
    const keys = new Set(deliveries.map((d) => d.deliveryKey));
    expect(keys.size).toBe(4);
  });

  async function seedMeetupTemplate() {
    await ensureDefaultTemplate(db);
    const { template } = await createEmailTemplate(db, {
      name: "Meetup template",
      subject: "Meet {{city}}",
      bodyHtml: "<p>{{members}}</p><p>Second Wednesday: {{meetup_suggestion}}</p>",
    });
    await publishEmailTemplate(db, template.id);
    await setGlobalIntroductionConfig(db, { defaultTemplateId: template.id });
  }

  it("defaults the meetup time to 10 am", async () => {
    await seedMeetupTemplate();
    const runId = await makePlan();
    await freezeIntroductionRun(db, { runId, deliveryMode: "simulation" });

    const groups = await db
      .select()
      .from(introductionGroups)
      .where(eq(introductionGroups.runId, runId));
    expect(groups[0].emailHtmlSnapshot).toContain("August 12th at 10 am");
  });

  it("uses the city meetup time in the rendered snapshot", async () => {
    await seedMeetupTemplate();
    await upsertCitySettings(db, "rec_city_london", { cityName: "London", meetupTime: "14:30" });
    const runId = await makePlan();
    await freezeIntroductionRun(db, { runId, deliveryMode: "simulation" });

    const groups = await db
      .select()
      .from(introductionGroups)
      .where(eq(introductionGroups.runId, runId));
    expect(groups[0].emailHtmlSnapshot).toContain("August 12th at 2:30 pm");
  });

  it("resolves the city name from settings when the group cityName is null", async () => {
    await seedMeetupTemplate();
    await upsertCitySettings(db, "rec_city_london", { cityName: "London" });
    const runId = await makePlan();
    // Simulate the transient preview-time name-resolution failure.
    await db
      .update(introductionGroups)
      .set({ cityName: null })
      .where(eq(introductionGroups.runId, runId));

    await freezeIntroductionRun(db, { runId, deliveryMode: "simulation" });

    const groups = await db
      .select()
      .from(introductionGroups)
      .where(eq(introductionGroups.runId, runId));
    expect(groups[0].emailSubjectSnapshot).toContain("London");
    expect(groups[0].emailSubjectSnapshot).not.toContain("your city");
    expect(groups[0].emailHtmlSnapshot).not.toContain("your city");
  });

  it("renders catalog option labels for help/expertise cards (not raw record ids)", async () => {
    setMatchingOptionsCatalogForTests({
      source: "airtable",
      fetchedAt: new Date().toISOString(),
      helpWantedOptions: [
        { code: "FUNDRAISING", label: "Fundraising support", kind: "help" },
      ],
      expertiseOptions: [
        { code: "GROWTH_MARKETING", label: "Growth marketing", kind: "expertise" },
      ],
    });
    await ensureDefaultTemplate(db);
    const runId = await makePlan();
    await freezeIntroductionRun(db, { runId, deliveryMode: "simulation" });

    const groups = await db
      .select()
      .from(introductionGroups)
      .where(eq(introductionGroups.runId, runId));
    expect(groups[0].emailHtmlSnapshot).toContain("Fundraising support");
    expect(groups[0].emailHtmlSnapshot).toContain("Growth marketing");
  });

  it("rejects re-freezing an approved run", async () => {
    await ensureDefaultTemplate(db);
    const runId = await makePlan();
    await freezeIntroductionRun(db, { runId });
    await expect(freezeIntroductionRun(db, { runId })).rejects.toThrow(FreezeError);
  });

  it("blocks plan edits after freezing (immutability)", async () => {
    await ensureDefaultTemplate(db);
    const runId = await makePlan();
    await freezeIntroductionRun(db, { runId });

    await expect(applyPlanEdit(db, runId, { type: "regenerate_city" })).rejects.toThrow();
  });

  it("redirects canary deliveries and preserves original recipients", async () => {
    await ensureDefaultTemplate(db);
    await setGlobalIntroductionConfig(db, {
      canaryEmails: ["canary@wlthwlks.com"],
    });
    const runId = await makePlan();

    const result = await freezeIntroductionRun(db, { runId, deliveryMode: "canary" });
    expect(result.success).toBe(true);

    const deliveries = await db.select().from(introductionDeliveries).where(eq(introductionDeliveries.runId, runId));
    for (const delivery of deliveries) {
      expect(delivery.deliverToEmail).toBe("canary@wlthwlks.com");
      expect(delivery.originalToJson).not.toBeNull();
      const original = JSON.parse(delivery.originalToJson!) as string[];
      expect(original).toContain(delivery.recipientEmail);
    }
  });

  it("fails canary freeze when no canary addresses are configured", async () => {
    await ensureDefaultTemplate(db);
    const runId = await makePlan();

    const result = await freezeIntroductionRun(db, { runId, deliveryMode: "canary" });
    expect(result.success).toBe(false);
    expect(result.validationFailures.join(" ")).toContain("canary");

    const runs = await db.select().from(introductionRuns).where(eq(introductionRuns.id, runId));
    expect(runs[0].status).toBe("planned");

    // A failed freeze must never leave claimable groups behind.
    const groups = await db.select().from(introductionGroups).where(eq(introductionGroups.runId, runId));
    for (const group of groups) {
      expect(group.status).toBe("planned");
    }
  });

  it("frozen groups are claimable by the delivery worker (regression: freeze→claim)", async () => {
    await ensureDefaultTemplate(db);
    const runId = await makePlan();

    const freeze = await freezeIntroductionRun(db, { runId, deliveryMode: "production" });
    expect(freeze.success).toBe(true);

    const sender = { sendBatch: vi.fn() };
    sender.sendBatch.mockImplementation(async (messages: Array<{ groupId: string }>) =>
      messages.map((m) => ({ ok: true, permanent: false, id: `resend-${m.groupId}` }))
    );

    const tick = await processDeliveryBatch(
      {
        db,
        sender,
        log: () => {},
        live: true,
        now: new Date("2026-08-17T10:00:00Z"),
      },
      { batchSize: 10 }
    );
    expect(tick.claimed).toBeGreaterThan(0);
    expect(tick.sent).toBe(tick.claimed);
    expect(sender.sendBatch).toHaveBeenCalledTimes(1);
  });

  it("provider-test mode uses provider-test addresses", async () => {
    await ensureDefaultTemplate(db);
    await setGlobalIntroductionConfig(db, {
      providerTestEmails: ["test@wlthwlks.com"],
    });
    const runId = await makePlan();

    const result = await freezeIntroductionRun(db, { runId, deliveryMode: "provider_test" });
    expect(result.success).toBe(true);
    const deliveries = await db.select().from(introductionDeliveries).where(eq(introductionDeliveries.runId, runId));
    for (const delivery of deliveries) {
      expect(delivery.deliverToEmail).toBe("test@wlthwlks.com");
    }
  });

  it("snapshots the template version content into the run snapshot", async () => {
    const seeded = await ensureDefaultTemplate(db);
    const runId = await makePlan();
    await freezeIntroductionRun(db, { runId, deliveryMode: "simulation" });

    const runs = await db.select().from(introductionRuns).where(eq(introductionRuns.id, runId));
    const snapshot = JSON.parse(runs[0].snapshotJson!) as Record<string, unknown>;
    expect(snapshot.planHash).toBeTruthy();
    expect(snapshot.deliveryMode).toBe("simulation");
    expect(snapshot.templateVersionId).toBe(seeded?.id);
    expect(typeof snapshot.templateSubject).toBe("string");
    expect(typeof snapshot.templateBodyHtml).toBe("string");
  });

  it("rejects runs with no groups and unknown runs", async () => {
    const runId = crypto.randomUUID();
    await expect(freezeIntroductionRun(db, { runId })).rejects.toThrow(FreezeError);

    await db.insert(introductionRuns).values({
      id: "empty-run",
      requestId: "empty-run",
      source: "city",
      mode: "preview",
      dryRun: true,
      status: "planned",
    });
    await expect(freezeIntroductionRun(db, { runId: "empty-run" })).rejects.toThrow(FreezeError);
  });
});
