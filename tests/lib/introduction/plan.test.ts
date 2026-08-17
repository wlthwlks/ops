import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  buildPlanMember,
  computePairMatrix,
  resolveCategoryCodes,
  runIntroductionPreview,
  applyPlanEdit,
  getRunDetail,
  getAlternativesForMember,
  PlanEditError,
  type IntroductionPlanDeps,
} from "@/lib/introduction/plan";
import {
  introductionRuns,
  introductionGroups,
  introductionGroupMembers,
  introductionPairScores,
  cityIntroductionSettings,
} from "@/db/schema";
import * as schema from "@/db/schema";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import type { PineconeClient, VectorRecord } from "@/lib/integrations/pinecone";
import type { MatchingOptionsCatalog } from "@/lib/forms/reference-data/matching-options-catalog";
import { loadPairHistory } from "@/lib/introduction/pair-history";
import { normalizeWeights, createMatchingProfile, createMatchingProfileVersion } from "@/lib/introduction/profiles";
import { eq } from "drizzle-orm";

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
const logs: string[] = [];

function makeDeps(): IntroductionPlanDeps {
  return {
    db,
    log: (m) => logs.push(m),
    airtable: {
      listRecords: airtableList,
      getRecord: airtableGetRecord,
    } as unknown as AirtableClient,
    pinecone: { fetchByIds: pineconeFetch } as unknown as PineconeClient,
    now: new Date("2026-08-16T09:00:00Z"),
  };
}

function memberRecord(id: string, overrides: Record<string, unknown> = {}): AirtableRecord {
  return {
    id,
    fields: {
      email: `${id.replace(/^rec_/, "")}@example.com`,
      Name: `Name ${id}`,
      "First Name": "First",
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
      "Help wanted context": `Help context ${id}`,
      Expertise: ["GROWTH_MARKETING"],
      "Expertise context": `Exp context ${id}`,
      "phone number": "+61 400 000 000",
      "social media": "@member",
      "Business website": "www.example.com",
      ...overrides,
    },
  };
}

const memberRecords = [
  memberRecord("rec_a", {}),
  memberRecord("rec_b", {}),
  memberRecord("rec_c", {}),
  memberRecord("rec_d", {}),
];

function makeVectors(ids: string[]): Map<string, VectorRecord> {
  const map = new Map<string, VectorRecord>();
  for (const id of ids) {
    const kind = id.split(":")[1];
    const values =
      kind === "profile" ? [1, 0, 0] :
      kind === "help" ? [0, 1, 0] :
      kind === "expertise" ? [0, 0, 1] :
      [1, 1, 0];
    map.set(id, { id, values, metadata: { kind } });
  }
  return map;
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
  logs.length = 0;
  await resetIntroductionsV2Tables(db);
  await db.delete(schema.matchEventMatches);
  await db.delete(schema.matchEvents);
  airtableGetRecord.mockResolvedValue({ id: "rec_city_london", fields: { City: "London" } });
  airtableList.mockImplementation(async (table: string) => {
    if (table === "MATCHING OPTIONS") return [];
    return memberRecords;
  });
  pineconeFetch.mockImplementation(async (ids: string[]) => makeVectors(ids));
});

describe("resolveCategoryCodes", () => {
  const catalogOptions = [
    { code: "rec_opt_fund", label: "Fundraising", kind: "help" as const },
    { code: "rec_opt_sales", label: "Sales", kind: "help" as const },
    { code: "FUNDRAISING", label: "Fundraising", kind: "help" as const },
  ];

  it("maps linked record ids and static codes", () => {
    expect(resolveCategoryCodes(["rec_opt_fund"], catalogOptions)).toEqual(["rec_opt_fund"]);
    expect(resolveCategoryCodes(["FUNDRAISING"], catalogOptions)).toEqual(["FUNDRAISING"]);
    expect(resolveCategoryCodes([{ id: "rec_opt_sales" }], catalogOptions)).toEqual(["rec_opt_sales"]);
  });

  it("drops unknown ids and dedupes", () => {
    expect(resolveCategoryCodes(["rec_unknown_xyz", "rec_opt_fund", "rec_opt_fund"], catalogOptions)).toEqual([
      "rec_opt_fund",
    ]);
  });
});

describe("buildPlanMember", () => {
  const catalog: MatchingOptionsCatalog = {
    helpWantedOptions: [
      { code: "rec_opt_fund", label: "Fundraising", kind: "help" },
      { code: "FUNDRAISING", label: "Fundraising", kind: "help" },
    ],
    expertiseOptions: [
      { code: "rec_opt_growth", label: "Growth", kind: "expertise" },
      { code: "GROWTH_MARKETING", label: "Growth", kind: "expertise" },
    ],
    source: "static",
    fetchedAt: "",
  };

  it("maps fields, categories and vectors onto a PlanMember", () => {
    const record = memberRecord("rec_x", {
      "Help wanted": ["rec_opt_fund"],
      Expertise: ["rec_opt_growth"],
    });
    const vectors = makeVectors([
      "rec_x:profile",
      "rec_x:help",
      "rec_x:expertise",
      "rec_x:goal",
    ]);
    const member = buildPlanMember(record, {
      catalog,
      vectors,
      geo: { lat: 51.5, lon: -0.12, displayName: "X", source: "google", unknown: false },
    });

    expect(member.key).toBe("at:rec_x");
    expect(member.email).toBe("x@example.com");
    expect(member.helpWanted).toEqual(["rec_opt_fund"]);
    expect(member.expertise).toEqual(["rec_opt_growth"]);
    expect(member.industry).toBe("TECH_SAAS");
    expect(member.businessStage).toBe("EARLY_TRACTION");
    expect(member.connectionTypes).toEqual(["SIMILAR_STAGE_PEER"]);
    expect(member.phone).toBe("+61 400 000 000");
    expect(member.socialMedia).toBe("@member");
    expect(member.website).toBe("www.example.com");
    expect(member.profileVector).toEqual([1, 0, 0]);
    expect(member.helpVector).toEqual([0, 1, 0]);
    expect(member.goalText).toBe("Goal rec_x");
    expect(member.lat).toBe(51.5);
  });

  it("tolerates missing vectors", () => {
    const member = buildPlanMember(memberRecord("rec_y"), {
      catalog,
      vectors: new Map(),
      geo: { lat: null, lon: null, displayName: null, source: "none", unknown: true },
    });
    expect(member.profileVector).toBeNull();
    expect(member.goalVector).toBeNull();
    expect(member.lat).toBeNull();
  });

  it("normalizes industry labels into codes", () => {
    const record = memberRecord("rec_z", { Industry: "Tech / SaaS" });
    const member = buildPlanMember(record, {
      catalog,
      vectors: new Map(),
      geo: { lat: null, lon: null, displayName: null, source: "none", unknown: true },
    });
    expect(member.industry).toBe("TECH_SAAS");
  });
});

describe("computePairMatrix", () => {
  it("scores allowed pairs and counts blocked reasons", async () => {
    const catalog: MatchingOptionsCatalog = {
      helpWantedOptions: [],
      expertiseOptions: [],
      source: "static",
      fetchedAt: "",
    };
    const a = buildPlanMember(memberRecord("rec_a"), {
      catalog,
      vectors: makeVectors(["rec_a:profile", "rec_a:help", "rec_a:expertise", "rec_a:goal"]),
      geo: { lat: 51.5, lon: -0.12, displayName: null, source: "google", unknown: false },
    });
    const b = buildPlanMember(memberRecord("rec_b"), {
      catalog,
      vectors: makeVectors(["rec_b:profile", "rec_b:help", "rec_b:expertise", "rec_b:goal"]),
      geo: { lat: 51.51, lon: -0.1, displayName: null, source: "google", unknown: false },
    });
    const c = buildPlanMember(memberRecord("rec_c", { City: "Paris" }), {
      catalog,
      vectors: new Map(),
      geo: { lat: 48.85, lon: 2.35, displayName: null, source: "google", unknown: false },
    });

    const history = await loadPairHistory(db, { pairDays: 60, memberDays: 14 });
    const constraints = {
      requireSameCity: true,
      maxDistanceKm: null as number | null,
      allowUnknownPostcode: false,
      repeatPairDays: 60,
      memberCooldownDays: 14,
      minEligibleMembers: 0,
    };
    const weights = normalizeWeights({ proximity: 100 });

    const result = computePairMatrix([a, b, c], {
      cycleDate: new Date("2026-08-16T00:00:00Z"),
      constraints,
      weights,
      pairHistory: history,
    });

    expect(result.allowedPairs).toBe(1);
    expect(result.notSameCityBlocked).toBeGreaterThanOrEqual(2);
    const ab = result.matrix.get(a.key, b.key);
    expect(ab?.allowed).toBe(true);
    expect(ab?.score.overall).toBeGreaterThan(0);
    const ac = result.matrix.get(a.key, c.key);
    expect(ac?.allowed).toBe(false);
    expect(ac?.blockedReason).toBe("not_same_city");
  });
});

describe("runIntroductionPreview", () => {
  it("builds a persisted plan with groups, pair scores and member rows", async () => {
    const result = await runIntroductionPreview(makeDeps(), {
      cityCode: "rec_city_london",
      cycleDate: "2026-08-16",
    });

    expect(result.success).toBe(true);
    expect(result.runId).not.toBeNull();
    expect(result.cityName).toBe("London");
    expect(result.cycleId).toBe("intro-rec_city_london-2026-08-16");
    expect(result.report.eligibleMembers).toBe(4);
    expect(result.report.matchedMembers).toBe(4);
    expect(result.report.groups).toBeGreaterThanOrEqual(1);
    expect(result.report.unmatched).toBe(0);
    expect(result.report.renderedEmailCount).toBe(result.report.groups);
    expect(result.report.recipientCount).toBe(4);

    const runs = await db.select().from(introductionRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("planned");
    expect(runs[0].source).toBe("city");
    expect(runs[0].deliveryMode).toBe("simulation");
    expect(runs[0].totalGroups).toBe(result.report.groups);

    const groups = await db.select().from(introductionGroups);
    expect(groups).toHaveLength(result.report.groups);
    for (const group of groups) {
      expect(group.overallScore).not.toBeNull();
      expect(group.scoreBreakdownJson).not.toBeNull();
      expect(group.locked).toBe(false);
    }

    const members = await db.select().from(introductionGroupMembers);
    expect(members).toHaveLength(4);
    for (const member of members) {
      expect(member.memberSnapshotJson).not.toBeNull();
      const snapshot = JSON.parse(member.memberSnapshotJson!) as Record<string, unknown>;
      expect(snapshot.phone).toBe("+61 400 000 000");
      expect(snapshot.socialMedia).toBe("@member");
      expect(snapshot.website).toBe("www.example.com");
    }

    const pairScores = await db.select().from(introductionPairScores);
    expect(pairScores.length).toBeGreaterThan(0);

    // Preview auto-creates the city settings row (sync-by-use).
    const cityRows = await db.select().from(cityIntroductionSettings);
    expect(
      cityRows.some((c) => c.cityCode === "rec_city_london" && c.cityName === "London")
    ).toBe(true);
  });

  it("is deterministic for the same input and cycle date", async () => {
    const first = await runIntroductionPreview(makeDeps(), {
      cityCode: "rec_city_london",
      cycleDate: "2026-08-16",
    });
    const firstGroups = await db
      .select()
      .from(introductionGroups)
      .where(eq(introductionGroups.runId, first.runId!));
    const firstFingerprints = firstGroups
      .map((g) => g.groupFingerprint)
      .sort();

    await resetIntroductionsV2Tables(db);
    const second = await runIntroductionPreview(makeDeps(), {
      cityCode: "rec_city_london",
      cycleDate: "2026-08-16",
    });
    const secondGroups = await db
      .select()
      .from(introductionGroups)
      .where(eq(introductionGroups.runId, second.runId!));
    expect(secondGroups.map((g) => g.groupFingerprint).sort()).toEqual(firstFingerprints);
  });

  it("excludes ineligible members and reports reasons", async () => {
    airtableList.mockImplementation(async (table: string) => {
      if (table === "MATCHING OPTIONS") return [];
      return [
        memberRecords[0],
        memberRecords[1],
        memberRecord("rec_unpaid", {
          Membership: "Inactive",
          Payment: "Unpaid",
        }),
        memberRecord("rec_excluded", {
          "Recurring intro status": "Excluded",
        }),
      ];
    });

    const result = await runIntroductionPreview(makeDeps(), {
      cityCode: "rec_city_london",
      cycleDate: "2026-08-16",
    });
    expect(result.report.eligibleMembers).toBe(2);
    const reasons = Object.fromEntries(result.report.excluded.map((e) => [e.email, e.reason]));
    expect(reasons["unpaid@example.com"]).toBe("no_service_access");
    expect(reasons["excluded@example.com"]).toBe("excluded");
  });

  it("blocks the city when eligible members are below the configured minimum", async () => {
    const profile = await createMatchingProfile(db, { name: "Gate", isDefault: true });
    await createMatchingProfileVersion(db, {
      profileId: profile.id,
      constraints: {
        requireSameCity: true,
        maxDistanceKm: null,
        allowUnknownPostcode: true,
        repeatPairDays: 60,
        memberCooldownDays: 14,
        minEligibleMembers: 3,
        targetGroupSize: 3,
        minGroupSize: 2,
        maxGroupSize: 6,
        strictGroupSize: false,
      },
    });
    airtableList.mockImplementation(async (table: string) => {
      if (table === "MATCHING OPTIONS") return [];
      return [memberRecords[0], memberRecords[1]];
    });

    const result = await runIntroductionPreview(makeDeps(), {
      cityCode: "rec_city_london",
      cycleDate: "2026-08-16",
    });
    expect(result.success).toBe(true);
    expect(result.report.blockedReason).toBe("insufficient_eligible_members");
    expect(result.report.minEligibleMembers).toBe(3);
    expect(result.report.eligibleMembers).toBe(2);
    expect(result.report.groups).toBe(0);
    expect(result.report.renderedEmailCount).toBe(0);

    const runs = await db.select().from(introductionRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("blocked");
    expect(runs[0].totalGroups).toBe(0);

    const groups = await db.select().from(introductionGroups);
    expect(groups).toHaveLength(0);
    const pairs = await db.select().from(introductionPairScores);
    expect(pairs).toHaveLength(0);
  });

  it("runs normally when eligible members meet the configured minimum", async () => {
    const profile = await createMatchingProfile(db, { name: "Gate", isDefault: true });
    await createMatchingProfileVersion(db, {
      profileId: profile.id,
      constraints: {
        requireSameCity: true,
        maxDistanceKm: null,
        allowUnknownPostcode: true,
        repeatPairDays: 60,
        memberCooldownDays: 14,
        minEligibleMembers: 3,
        targetGroupSize: 3,
        minGroupSize: 2,
        maxGroupSize: 6,
        strictGroupSize: false,
      },
    });

    const result = await runIntroductionPreview(makeDeps(), {
      cityCode: "rec_city_london",
      cycleDate: "2026-08-16",
    });
    expect(result.report.blockedReason).toBeNull();
    expect(result.report.eligibleMembers).toBe(4);
    expect(result.report.groups).toBeGreaterThanOrEqual(1);
  });

  it("includes members without a postcode under the lenient default", async () => {
    airtableList.mockImplementation(async (table: string) => {
      if (table === "MATCHING OPTIONS") return [];
      return [
        memberRecords[0],
        memberRecords[1],
        memberRecord("rec_nopc", { "post code": "" }),
      ];
    });

    const result = await runIntroductionPreview(makeDeps(), {
      cityCode: "rec_city_london",
      cycleDate: "2026-08-16",
    });
    expect(result.report.eligibleMembers).toBe(3);
    expect(result.report.missingPostcode).toBe(1);
    expect(result.report.excluded.find((e) => e.email === "nopc@example.com")).toBeUndefined();
  });

  it("blocks recent pairs and reports them", async () => {
    // Seed a sent introduction between rec_a and rec_b inside the window.
    const runId = "run-history";
    await db.insert(introductionRuns).values({
      id: runId,
      requestId: "req-history",
      source: "city",
      mode: "send",
      dryRun: false,
      status: "completed",
    });
    const groupId = "grp-history";
    await db.insert(introductionGroups).values({
      id: groupId,
      runId,
      source: "city",
      groupFingerprint: "fp-history",
      status: "sent",
    });
    for (const email of ["a@example.com", "b@example.com"]) {
      await db.insert(introductionGroupMembers).values({
        id: `gm-${email}`,
        groupId,
        emailSnapshot: email,
        role: "recurring",
      });
    }

    const result = await runIntroductionPreview(makeDeps(), {
      cityCode: "rec_city_london",
      cycleDate: "2026-08-16",
    });
    expect(result.report.repeatedPairsBlocked).toBeGreaterThan(0);
  });
});

describe("plan edits", () => {
  async function makePlan() {
    const result = await runIntroductionPreview(makeDeps(), {
      cityCode: "rec_city_london",
      cycleDate: "2026-08-16",
    });
    return result.runId!;
  }

  it("lock_group locks a group and regenerate_city preserves it", async () => {
    const runId = await makePlan();
    const detailBefore = await getRunDetail(db, runId);
    const target = detailBefore!.groups[0];
    const targetMembers = target.members.map((m) => m.key).sort();

    await applyPlanEdit(db, runId, { type: "lock_group", groupId: target.id, locked: true });
    await applyPlanEdit(db, runId, { type: "regenerate_city" });

    const detailAfter = await getRunDetail(db, runId);
    const locked = detailAfter!.groups.find((g) => g.id === target.id);
    expect(locked?.locked).toBe(true);
    expect(locked?.members.map((m) => m.key).sort()).toEqual(targetMembers);

    const flat = detailAfter!.groups.flatMap((g) => g.members.map((m) => m.key));
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat.sort()).toEqual(
      detailBefore!.groups.flatMap((g) => g.members.map((m) => m.key)).sort()
    );
  });

  it("remove_member removes a member from the plan entirely", async () => {
    const runId = await makePlan();
    const detail = await getRunDetail(db, runId);
    const group = detail!.groups[0];
    const member = group.members[0];

    await applyPlanEdit(db, runId, { type: "remove_member", groupId: group.id, memberKey: member.key });

    const after = await getRunDetail(db, runId);
    const flat = after!.groups.flatMap((g) => g.members.map((m) => m.key));
    expect(flat).not.toContain(member.key);

    const pairRows = await db
      .select()
      .from(introductionPairScores)
      .where(eq(introductionPairScores.runId, runId));
    for (const row of pairRows) {
      expect(row.memberAKey).not.toBe(member.key);
      expect(row.memberBKey).not.toBe(member.key);
    }
  });

  it("replace_member swaps a member for an available alternative", async () => {
    const runId = await makePlan();
    const detail = await getRunDetail(db, runId);
    const group = detail!.groups[0];
    const member = group.members[0];
    const alternatives = await getAlternativesForMember(db, runId, member.key);
    expect(alternatives.length).toBeGreaterThan(0);
    const replacement = alternatives[0].key;

    await applyPlanEdit(db, runId, {
      type: "replace_member",
      groupId: group.id,
      memberKey: member.key,
      replacementKey: replacement,
    });

    const after = await getRunDetail(db, runId);
    const flat = after!.groups.flatMap((g) => g.members.map((m) => m.key));
    expect(flat).toContain(replacement);
    expect(flat).not.toContain(member.key);
  });

  it("regenerate_group rebuilds without that group id", async () => {
    const runId = await makePlan();
    const detail = await getRunDetail(db, runId);
    const group = detail!.groups[0];

    await applyPlanEdit(db, runId, { type: "regenerate_group", groupId: group.id });

    const after = await getRunDetail(db, runId);
    expect(after!.groups.find((g) => g.id === group.id)).toBeUndefined();
    expect(after!.groups.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects edits on frozen plans", async () => {
    const runId = await makePlan();
    await db
      .update(introductionRuns)
      .set({ status: "sending" })
      .where(eq(introductionRuns.id, runId));

    await expect(
      applyPlanEdit(db, runId, { type: "regenerate_city" })
    ).rejects.toThrow(PlanEditError);
  });

  it("rejects edits on locked groups", async () => {
    const runId = await makePlan();
    const detail = await getRunDetail(db, runId);
    const group = detail!.groups[0];
    await applyPlanEdit(db, runId, { type: "lock_group", groupId: group.id, locked: true });

    await expect(
      applyPlanEdit(db, runId, { type: "remove_member", groupId: group.id, memberKey: group.members[0].key })
    ).rejects.toThrow(PlanEditError);
  });

  it("rejects unknown runs and unknown replacement members", async () => {
    await expect(applyPlanEdit(db, "missing", { type: "regenerate_city" })).rejects.toThrow(
      PlanEditError
    );

    const runId = await makePlan();
    await expect(
      applyPlanEdit(db, runId, {
        type: "replace_member",
        groupId: "nope",
        memberKey: "m",
        replacementKey: "r",
      })
    ).rejects.toThrow(PlanEditError);
  });
});

describe("getAlternativesForMember", () => {
  it("returns candidates ordered by overall score", async () => {
    const result = await runIntroductionPreview(makeDeps(), {
      cityCode: "rec_city_london",
      cycleDate: "2026-08-16",
    });
    const detail = await getRunDetail(db, result.runId!);
    const member = detail!.groups[0].members[0];

    const alternatives = await getAlternativesForMember(db, result.runId!, member.key);
    expect(alternatives.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < alternatives.length; i++) {
      expect(alternatives[i - 1].overall).toBeGreaterThanOrEqual(alternatives[i].overall);
    }
    for (const alternative of alternatives) {
      expect(alternative.key).not.toBe(member.key);
    }
  });
});
