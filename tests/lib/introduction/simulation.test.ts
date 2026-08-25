import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  buildSimulationReport,
  deliveryModeSafety,
  estimateQueueSizes,
  listRunDeliveries,
} from "@/lib/introduction/simulation";
import {
  introductionRuns,
  introductionDeliveries,
  matchEvents,
  matchEventMatches,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { runIntroductionPreview, type IntroductionPlanDeps } from "@/lib/introduction/plan";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import type { PineconeClient, VectorRecord } from "@/lib/integrations/pinecone";
import { freezeIntroductionRun } from "@/lib/introduction/freeze";
import { ensureDefaultTemplate } from "@/lib/introduction/templates";
import { setGlobalIntroductionConfig } from "@/lib/introduction/settings";
import { vi } from "vitest";

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
    },
  };
}

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
    return [memberRecord("rec_a"), memberRecord("rec_b"), memberRecord("rec_c"), memberRecord("rec_d")];
  });
  pineconeFetch.mockImplementation(async (ids: string[]) => {
    const map = new Map<string, VectorRecord>();
    for (const id of ids) map.set(id, { id, values: [1, 0, 0], metadata: {} });
    return map;
  });
});

async function makeFrozenPlan(deliveryMode: "simulation" | "canary" | "provider_test" | "production" = "simulation") {
  await ensureDefaultTemplate(db);
  if (deliveryMode === "canary") {
    await setGlobalIntroductionConfig(db, { canaryEmails: ["canary@wlthwlks.com"] });
  }
  if (deliveryMode === "provider_test") {
    await setGlobalIntroductionConfig(db, { providerTestEmails: ["test@wlthwlks.com"] });
  }
  const preview = await runIntroductionPreview(makeDeps(), {
    cityCode: "rec_city_london",
    cycleDate: "2026-08-16",
  });
  await freezeIntroductionRun(db, { runId: preview.runId!, deliveryMode });
  return preview.runId!;
}

describe("estimateQueueSizes", () => {
  it("computes batch counts and worker ticks", () => {
    expect(estimateQueueSizes(45, 135, 20)).toEqual({
      groupCount: 45,
      deliveryCount: 135,
      batchSize: 20,
      batches: 3,
      workerTicks: 3,
    });
    expect(estimateQueueSizes(0, 0, 20).batches).toBe(0);
    expect(estimateQueueSizes(5, 15, 20).batches).toBe(1);
    expect(estimateQueueSizes(10, 30, 0).batchSize).toBe(20);
  });
});

describe("deliveryModeSafety", () => {
  it("maps modes to safety levels", () => {
    expect(deliveryModeSafety("simulation").level).toBe("none");
    expect(deliveryModeSafety(null).level).toBe("none");
    expect(deliveryModeSafety("canary").level).toBe("internal");
    expect(deliveryModeSafety("provider_test").level).toBe("internal");
    expect(deliveryModeSafety("production").level).toBe("production");
  });
});

describe("buildSimulationReport", () => {
  it("reports full simulation metrics for a frozen simulation plan", async () => {
    const runId = await makeFrozenPlan("simulation");
    const report = await buildSimulationReport(db, runId);

    expect(report).not.toBeNull();
    expect(report!.deliveryMode).toBe("simulation");
    expect(report!.safety.level).toBe("none");
    expect(report!.eligibleMembers).toBe(4);
    expect(report!.matchedMembers).toBe(4);
    expect(report!.groups).toBeGreaterThanOrEqual(1);
    expect(report!.deliveries).toBe(4);
    expect(report!.renderedEmails).toBe(report!.groups);
    expect(report!.recipientCount).toBe(4);
    expect(report!.duplicateMembers).toHaveLength(0);
    expect(report!.invalidEmails).toHaveLength(0);
    expect(report!.canaryRedirectCount).toBe(0);
    expect(report!.queue.batches).toBeGreaterThanOrEqual(1);
    expect(report!.validationFailures).toHaveLength(0);
    expect(report!.groupSizes).toEqual({ target: 3, min: 2, max: 6, strict: false });
  });

  it("counts canary redirects and reports intended recipients", async () => {
    const runId = await makeFrozenPlan("canary");
    const report = await buildSimulationReport(db, runId);
    expect(report!.deliveryMode).toBe("canary");
    expect(report!.safety.level).toBe("internal");
    expect(report!.canaryRedirectCount).toBe(4);

    const deliveries = await listRunDeliveries(db, runId);
    expect(deliveries).toHaveLength(4);
    for (const delivery of deliveries) {
      expect(delivery.deliverToEmail).toBe("canary@wlthwlks.com");
      expect(delivery.originalTo).toContain(delivery.recipientEmail);
    }
  });

  it("flags invalid deliver-to emails", async () => {
    const runId = await makeFrozenPlan("simulation");
    const deliveries = await db.select().from(introductionDeliveries);
    for (const delivery of deliveries) {
      await db
        .update(introductionDeliveries)
        .set({ deliverToEmail: "not-an-email" })
        .where(eq(introductionDeliveries.id, delivery.id));
    }
    const report = await buildSimulationReport(db, runId);
    expect(report!.invalidEmails).toHaveLength(4);
    expect(report!.validationFailures.join(" ")).toContain("invalid");
  });

  it("returns null for unknown runs", async () => {
    expect(await buildSimulationReport(db, "missing")).toBeNull();
  });

  it("reports blocked runs with the min-eligible reason", async () => {
    await db.insert(introductionRuns).values({
      id: "run-blocked",
      requestId: "req-blocked",
      source: "city",
      mode: "preview",
      dryRun: true,
      status: "blocked",
      snapshotJson: JSON.stringify({
        blockedReason: "insufficient_eligible_members",
        minEligibleMembers: 3,
        members: [],
      }),
    });
    const report = await buildSimulationReport(db, "run-blocked");
    expect(report!.status).toBe("blocked");
    expect(report!.blockedReason).toBe("insufficient_eligible_members");
    expect(report!.minEligibleMembers).toBe(3);
  });
});

describe("listRunDeliveries", () => {
  it("lists deliveries for a run", async () => {
    const runId = await makeFrozenPlan("simulation");
    const deliveries = await listRunDeliveries(db, runId);
    expect(deliveries).toHaveLength(4);
    expect(deliveries[0].status).toBe("pending");
    expect(deliveries[0].originalTo).toBeNull();
  });
});
