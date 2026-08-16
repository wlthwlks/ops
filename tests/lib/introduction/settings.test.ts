import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  GLOBAL_CONFIG_KEYS,
  DEFAULT_SENDER_FROM,
  getCitySettings,
  listCitySettings,
  upsertCitySettings,
  resolveEffectiveCitySettings,
  getGlobalIntroductionConfig,
  setGlobalIntroductionConfig,
  IntroductionSettingsError,
} from "@/lib/introduction/settings";
import { cityIntroductionSettings } from "@/db/schema";
import {
  createMatchingProfile,
  createMatchingProfileVersion,
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
  process.env.INTRO_SENDER_EMAIL = "";
  await resetIntroductionsV2Tables(db);
});

describe("upsertCitySettings", () => {
  it("inserts then updates a city row", async () => {
    const created = await upsertCitySettings(db, "rec_london", {
      cityName: "London",
      enabled: true,
      repeatPairDays: 90,
    });
    expect(created.cityCode).toBe("rec_london");
    expect(created.enabled).toBe(true);

    const updated = await upsertCitySettings(db, "rec_london", {
      repeatPairDays: 30,
    });
    expect(updated.repeatPairDays).toBe(30);
    expect(updated.enabled).toBe(true);

    const stored = await getCitySettings(db, "rec_london");
    expect(stored?.cityName).toBe("London");
    expect(stored?.repeatPairDays).toBe(30);
  });

  it("lists cities", async () => {
    await upsertCitySettings(db, "rec_a", { cityName: "Alpha" });
    await upsertCitySettings(db, "rec_b", { cityName: "Beta" });
    const cities = await listCitySettings(db);
    expect(cities.map((c) => c.cityCode).sort()).toEqual(["rec_a", "rec_b"]);
  });

  it("rejects an invalid schedule payload", async () => {
    await expect(
      upsertCitySettings(db, "rec_x", {
        scheduleJson: JSON.stringify({ dayOfMonth: 40, localTime: "25:00", timezone: "UTC" }),
      })
    ).rejects.toThrow();
  });

  it("rejects invalid group size combinations", async () => {
    await expect(
      upsertCitySettings(db, "rec_x", { minGroupSize: 5, maxGroupSize: 3 })
    ).rejects.toThrow();
    await expect(
      upsertCitySettings(db, "rec_x", { targetGroupSize: 7, maxGroupSize: 6 })
    ).rejects.toThrow();
  });
});

describe("resolveEffectiveCitySettings", () => {
  it("uses built-in defaults for a city with no settings and no profile", async () => {
    const effective = await resolveEffectiveCitySettings(db, "rec_unknown");
    expect(effective.enabled).toBe(false);
    expect(effective.schedulingMode).toBe("manual");
    expect(effective.groupSizes).toEqual({ target: 3, min: 2, max: 6, strict: false });
    expect(effective.constraints.requireSameCity).toBe(true);
    expect(effective.constraints.repeatPairDays).toBe(60);
    expect(effective.profileVersionId).toBeNull();
  });

  it("merges profile defaults with city overrides", async () => {
    const profile = await createMatchingProfile(db, { name: "Default", isDefault: true });
    await createMatchingProfileVersion(db, {
      profileId: profile.id,
      constraints: {
        requireSameCity: true,
        maxDistanceKm: 25,
        allowUnknownPostcode: false,
        repeatPairDays: 60,
        memberCooldownDays: 14,
        targetGroupSize: 3,
        minGroupSize: 2,
        maxGroupSize: 6,
        strictGroupSize: false,
      },
      weights: { proximity: 40, ai_correlation: 60 },
    });
    await upsertCitySettings(db, "rec_london", {
      cityName: "London",
      enabled: true,
      repeatPairDays: 90,
      maxGroupSize: 5,
      strictGroupSize: true,
      schedulingMode: "scheduled",
      scheduleJson: JSON.stringify({ dayOfMonth: 1, localTime: "09:00", timezone: "Europe/London" }),
    });

    const effective = await resolveEffectiveCitySettings(db, "rec_london");
    expect(effective.enabled).toBe(true);
    expect(effective.profileVersionId).not.toBeNull();
    expect(effective.weights.components.proximity).toBeCloseTo(0.4, 10);
    // city overrides win
    expect(effective.constraints.repeatPairDays).toBe(90);
    expect(effective.groupSizes.max).toBe(5);
    expect(effective.groupSizes.strict).toBe(true);
    // profile defaults still apply where the city has no override
    expect(effective.constraints.requireSameCity).toBe(true);
    expect(effective.constraints.maxDistanceKm).toBe(25);
    expect(effective.schedule).toEqual({
      dayOfMonth: 1,
      localTime: "09:00",
      timezone: "Europe/London",
    });
  });

  it("honors a city-level matching profile override", async () => {
    const defaultProfile = await createMatchingProfile(db, { name: "Default", isDefault: true });
    await createMatchingProfileVersion(db, { profileId: defaultProfile.id, weights: { proximity: 10, industry: 90 } });
    const special = await createMatchingProfile(db, { name: "Special" });
    const specialVersion = await createMatchingProfileVersion(db, {
      profileId: special.id,
      weights: { proximity: 80, industry: 20 },
    });

    await upsertCitySettings(db, "rec_london", {
      matchingProfileVersionId: specialVersion.id,
    });

    const effective = await resolveEffectiveCitySettings(db, "rec_london");
    expect(effective.profileId).toBe(special.id);
    expect(effective.weights.components.proximity).toBeCloseTo(0.8, 10);
  });

  it("uses env cooldown fallback when no profile exists", async () => {
    process.env.INTRO_PAIR_COOLDOWN_DAYS = "33";
    const effective = await resolveEffectiveCitySettings(db, "rec_unknown");
    expect(effective.constraints.repeatPairDays).toBe(33);
  });

  it("throws when an effective group size combination is invalid", async () => {
    const profile = await createMatchingProfile(db, { name: "Default", isDefault: true });
    await createMatchingProfileVersion(db, {
      profileId: profile.id,
      constraints: {
        requireSameCity: true,
        maxDistanceKm: null,
        allowUnknownPostcode: false,
        repeatPairDays: 60,
        memberCooldownDays: 14,
        targetGroupSize: 3,
        minGroupSize: 2,
        maxGroupSize: 6,
        strictGroupSize: false,
      },
    });
    // Insert directly to bypass the input validation (which also rejects
    // this combination) and exercise the effective-resolution guard.
    await db.insert(cityIntroductionSettings).values({
      id: "broken-1",
      cityCode: "rec_broken",
      minGroupSize: 6,
      maxGroupSize: 4,
    });
    await expect(resolveEffectiveCitySettings(db, "rec_broken")).rejects.toThrow(
      IntroductionSettingsError
    );
  });
});

describe("global config", () => {
  it("defaults sender to INTRO_SENDER_EMAIL then the built-in default", async () => {
    process.env.INTRO_SENDER_EMAIL = "";
    const config = await getGlobalIntroductionConfig(db);
    expect(config.senderFrom).toBe(DEFAULT_SENDER_FROM);
    expect(config.canaryEmails).toEqual([]);
    expect(config.providerTestEmails).toEqual([]);
    expect(config.defaultProfileId).toBeNull();

    process.env.INTRO_SENDER_EMAIL = "Custom <custom@example.com>";
    const custom = await getGlobalIntroductionConfig(db);
    expect(custom.senderFrom).toBe("Custom <custom@example.com>");
  });

  it("persists and reads back config values", async () => {
    const updated = await setGlobalIntroductionConfig(db, {
      senderFrom: "WLTH WLKS <noreply@wlthwlks.com>",
      canaryEmails: ["a@wlthwlks.com", "b@wlthwlks.com"],
      providerTestEmails: ["t@wlthwlks.com"],
    });
    expect(updated.canaryEmails).toEqual(["a@wlthwlks.com", "b@wlthwlks.com"]);
    expect(updated.providerTestEmails).toEqual(["t@wlthwlks.com"]);

    const again = await getGlobalIntroductionConfig(db);
    expect(again.senderFrom).toBe("WLTH WLKS <noreply@wlthwlks.com>");
    expect(again.canaryEmails).toHaveLength(2);
  });

  it("rejects invalid email lists", async () => {
    await expect(
      setGlobalIntroductionConfig(db, { canaryEmails: ["not-an-email"] })
    ).rejects.toThrow();
  });

  it("supports clearing a default profile reference", async () => {
    await setGlobalIntroductionConfig(db, { defaultProfileId: "some-id" });
    expect((await getGlobalIntroductionConfig(db)).defaultProfileId).toBe("some-id");
    await setGlobalIntroductionConfig(db, { defaultProfileId: null });
    expect((await getGlobalIntroductionConfig(db)).defaultProfileId).toBeNull();
  });
});

describe("config keys", () => {
  it("exposes stable global config keys", () => {
    expect(GLOBAL_CONFIG_KEYS.defaultProfileId).toBe("intro.default_profile_id");
    expect(GLOBAL_CONFIG_KEYS.senderFrom).toBe("intro.sender_from");
    expect(GLOBAL_CONFIG_KEYS.canaryEmails).toBe("intro.canary_emails");
    expect(GLOBAL_CONFIG_KEYS.providerTestEmails).toBe("intro.provider_test_emails");
  });
});
