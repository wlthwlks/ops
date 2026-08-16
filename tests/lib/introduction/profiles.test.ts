import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  SCORE_COMPONENTS,
  DEFAULT_WEIGHTS,
  normalizeWeights,
  defaultNormalizedWeights,
  defaultConstraints,
  weightsToJson,
  weightsFromJson,
  constraintsFromJson,
  createMatchingProfile,
  updateMatchingProfile,
  createMatchingProfileVersion,
  listVersionsForProfile,
  listMatchingProfiles,
  resolveMatchingProfile,
  getDefaultProfileAndVersion,
  MatchingProfilesError,
} from "@/lib/introduction/profiles";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

beforeAll(async () => {
  const test = await createTestDb({ introductionsV2: true });
  db = test.db;
  close = test.close;
});

afterAll(async () => {
  await close();
});

afterEach(async () => {
  process.env.INTRO_PAIR_COOLDOWN_DAYS = "";
  process.env.INTRO_MEMBER_COOLDOWN_DAYS = "";
  await resetIntroductionsV2Tables(db);
});

describe("normalizeWeights", () => {
  it("normalizes the default weights to sum to 1", () => {
    const result = defaultNormalizedWeights();
    const sum = SCORE_COMPONENTS.reduce((acc, key) => acc + result.components[key], 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(result.total).toBe(100);
    expect(result.components.proximity).toBeCloseTo(0.3, 10);
    expect(result.components.ai_correlation).toBeCloseTo(0.25, 10);
    expect(result.components.business_stage).toBeCloseTo(0.05, 10);
  });

  it("treats missing components as zero weight", () => {
    const result = normalizeWeights({ proximity: 50, industry: 50 });
    expect(result.total).toBe(100);
    expect(result.components.proximity).toBeCloseTo(0.5, 10);
    expect(result.components.industry).toBeCloseTo(0.5, 10);
    expect(result.components.ai_correlation).toBe(0);
    expect(result.enabled).toEqual(["proximity", "industry"]);
  });

  it("excludes zero-weight dimensions and keeps them out of enabled", () => {
    const result = normalizeWeights({ proximity: 30, ai_correlation: 25, help_expertise: 0 });
    expect(result.enabled).not.toContain("help_expertise");
    expect(result.components.help_expertise).toBe(0);
  });

  it("throws when no weight is positive", () => {
    expect(() => normalizeWeights({ proximity: 0, industry: 0 })).toThrow();
    expect(() => normalizeWeights({})).toThrow();
  });

  it("throws on negative or non-finite weights", () => {
    expect(() => normalizeWeights({ proximity: -1, industry: 5 })).toThrow();
    expect(() => normalizeWeights({ proximity: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe("default constraints", () => {
  it("uses target 3, min 2, max 6, non-strict by default", () => {
    const c = defaultConstraints();
    expect(c.targetGroupSize).toBe(3);
    expect(c.minGroupSize).toBe(2);
    expect(c.maxGroupSize).toBe(6);
    expect(c.strictGroupSize).toBe(false);
    expect(c.requireSameCity).toBe(true);
    expect(c.maxDistanceKm).toBeNull();
    expect(c.allowUnknownPostcode).toBe(false);
  });

  it("falls back to env cooldown defaults when set", () => {
    process.env.INTRO_PAIR_COOLDOWN_DAYS = "42";
    process.env.INTRO_MEMBER_COOLDOWN_DAYS = "7";
    const c = defaultConstraints();
    expect(c.repeatPairDays).toBe(42);
    expect(c.memberCooldownDays).toBe(7);
  });

  it("ignores invalid env cooldown values", () => {
    process.env.INTRO_PAIR_COOLDOWN_DAYS = "not-a-number";
    process.env.INTRO_MEMBER_COOLDOWN_DAYS = "-3";
    const c = defaultConstraints();
    expect(c.repeatPairDays).toBe(60);
    expect(c.memberCooldownDays).toBe(14);
  });

  it("rejects inconsistent group sizes", () => {
    const parse = (overrides: Record<string, unknown>) =>
      constraintsFromJson(JSON.stringify({ ...defaultConstraints(), ...overrides }));
    expect(() => parse({ minGroupSize: 7, maxGroupSize: 6 })).toThrow();
    expect(() => parse({ targetGroupSize: 8, maxGroupSize: 6 })).toThrow();
    expect(() => parse({ targetGroupSize: 1, minGroupSize: 2 })).toThrow();
  });
});

describe("weights json roundtrip", () => {
  it("fills missing components with zero and roundtrips", () => {
    const json = weightsToJson({ proximity: 40, industry: 60 });
    const parsed = JSON.parse(json);
    expect(parsed.ai_correlation).toBe(0);
    expect(weightsFromJson(json)).toEqual({ proximity: 40, industry: 60, ai_correlation: 0, help_expertise: 0, goal_relevance: 0, connection_type: 0, business_stage: 0 });
  });

  it("rejects invalid stored weights", () => {
    expect(() => weightsFromJson(JSON.stringify({ proximity: -5 }))).toThrow();
  });
});

describe("profile versions", () => {
  it("creates sequentially numbered immutable versions", async () => {
    const profile = await createMatchingProfile(db, { name: "Default v1" });
    const v1 = await createMatchingProfileVersion(db, {
      profileId: profile.id,
      weights: { proximity: 40, industry: 60 },
    });
    const v2 = await createMatchingProfileVersion(db, {
      profileId: profile.id,
      weights: { proximity: 10, industry: 90 },
    });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(weightsFromJson(v1.weightsJson).proximity).toBe(40);

    const versions = await listVersionsForProfile(db, profile.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it("applies default weights when none provided", async () => {
    const profile = await createMatchingProfile(db, { name: "Defaults" });
    const version = await createMatchingProfileVersion(db, { profileId: profile.id });
    expect(weightsFromJson(version.weightsJson)).toEqual(DEFAULT_WEIGHTS);
  });

  it("throws when creating a version for a missing profile", async () => {
    await expect(
      createMatchingProfileVersion(db, { profileId: "missing" })
    ).rejects.toThrow(MatchingProfilesError);
  });

  it("updateMatchingProfile never mutates existing versions", async () => {
    const profile = await createMatchingProfile(db, { name: "Mutable" });
    const v1 = await createMatchingProfileVersion(db, {
      profileId: profile.id,
      weights: { proximity: 20, industry: 80 },
    });
    await updateMatchingProfile(db, profile.id, { name: "Renamed" });
    const versions = await listVersionsForProfile(db, profile.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].id).toBe(v1.id);
    expect(weightsFromJson(versions[0].weightsJson).proximity).toBe(20);
  });
});

describe("default profile resolution", () => {
  it("resolves the default profile's latest version", async () => {
    const profile = await createMatchingProfile(db, { name: "Default", isDefault: true });
    await createMatchingProfileVersion(db, { profileId: profile.id, weights: { proximity: 55, industry: 45 } });

    const resolved = await resolveMatchingProfile(db, null);
    expect(resolved.profile?.id).toBe(profile.id);
    expect(resolved.version?.version).toBe(1);
    expect(resolved.weights.components.proximity).toBeCloseTo(0.55, 10);
  });

  it("prefers an explicit version id over the default profile", async () => {
    const a = await createMatchingProfile(db, { name: "A", isDefault: true });
    const b = await createMatchingProfile(db, { name: "B" });
    await createMatchingProfileVersion(db, { profileId: a.id, weights: { proximity: 10, industry: 90 } });
    const bv = await createMatchingProfileVersion(db, { profileId: b.id, weights: { proximity: 60, industry: 40 } });

    const resolved = await resolveMatchingProfile(db, bv.id);
    expect(resolved.profile?.id).toBe(b.id);
    expect(resolved.weights.components.proximity).toBeCloseTo(0.6, 10);
  });

  it("falls back to built-in defaults when no profile exists", async () => {
    const resolved = await resolveMatchingProfile(db, null);
    expect(resolved.profile).toBeNull();
    expect(resolved.version).toBeNull();
    expect(resolved.weightsRaw).toEqual(DEFAULT_WEIGHTS);
    expect(resolved.constraints.targetGroupSize).toBe(3);
  });

  it("throws for an unknown explicit version id", async () => {
    await expect(resolveMatchingProfile(db, "missing-version")).rejects.toThrow(
      MatchingProfilesError
    );
  });

  it("getDefaultProfileAndVersion returns null with no profiles", async () => {
    expect(await getDefaultProfileAndVersion(db)).toBeNull();
  });

  it("listMatchingProfiles attaches latest versions", async () => {
    const profile = await createMatchingProfile(db, { name: "Listed" });
    await createMatchingProfileVersion(db, { profileId: profile.id, weights: { proximity: 100 } });
    const profiles = await listMatchingProfiles(db);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].latestVersion?.version).toBe(1);
  });

  it("keeps only one default profile when a new default is created", async () => {
    const first = await createMatchingProfile(db, { name: "First default", isDefault: true });
    await createMatchingProfile(db, { name: "Second default", isDefault: true });
    const profiles = await listMatchingProfiles(db);
    expect(profiles.filter((p) => p.profile.isDefault)).toHaveLength(1);
    expect(profiles.find((p) => p.profile.id === first.id)?.profile.isDefault).toBe(false);
  });
});
