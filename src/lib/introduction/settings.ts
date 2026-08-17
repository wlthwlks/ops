import { eq, inArray } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  cityIntroductionSettings,
  introductionConfig,
  type CityIntroductionSettings,
} from "@/db/schema";
import { z } from "zod";
import {
  resolveMatchingProfile,
  type MatchingConstraints,
  type MatchingWeights,
  type NormalizedWeights,
} from "./profiles";

/**
 * City settings and global config for the unified introduction engine.
 * City rows override the defaults carried by the city's matching profile;
 * `resolveEffectiveCitySettings` merges both into a single effective config
 * that a run can be built from.
 */

export const GLOBAL_CONFIG_KEYS = {
  defaultProfileId: "intro.default_profile_id",
  defaultTemplateId: "intro.default_template_id",
  senderFrom: "intro.sender_from",
  canaryEmails: "intro.canary_emails",
  providerTestEmails: "intro.provider_test_emails",
} as const;

export const DEFAULT_SENDER_FROM = "WLTH WLKS <noreply@wlthwlks.com>";

export const cityScheduleSchema = z.object({
  dayOfMonth: z.number().int().min(1).max(31),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(64),
});

export type CitySchedule = z.infer<typeof cityScheduleSchema>;

const groupSizeOverride = z.number().int().min(2).max(12).nullable();

export const citySettingsInputSchema = z
  .object({
    cityName: z.string().trim().min(1).max(120).nullable().optional(),
    enabled: z.boolean().optional(),
    schedulingMode: z.enum(["manual", "scheduled"]).optional(),
    scheduleJson: z.string().min(1).max(2000).nullable().optional(),
    nextRunAt: z.string().datetime().nullable().optional(),
    matchingProfileVersionId: z.string().min(1).nullable().optional(),
    emailTemplateVersionId: z.string().min(1).nullable().optional(),
    targetGroupSize: groupSizeOverride.optional(),
    minGroupSize: groupSizeOverride.optional(),
    maxGroupSize: groupSizeOverride.optional(),
    strictGroupSize: z.boolean().nullable().optional(),
    requireSameCity: z.boolean().nullable().optional(),
    maxDistanceKm: z.number().positive().nullable().optional(),
    allowUnknownPostcode: z.boolean().nullable().optional(),
    repeatPairDays: z.number().int().min(1).nullable().optional(),
    memberCooldownDays: z.number().int().min(0).nullable().optional(),
    minEligibleMembers: z.number().int().min(0).max(1000).nullable().optional(),
    autoApprove: z.boolean().optional(),
    autoApproveDeliveryMode: z
      .enum(["simulation", "provider_test", "canary", "production"])
      .optional(),
    meetupTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "meetupTime must be HH:mm")
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (input.scheduleJson !== undefined && input.scheduleJson !== null) {
      try {
        cityScheduleSchema.parse(JSON.parse(input.scheduleJson));
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "scheduleJson must be a valid monthly schedule",
          path: ["scheduleJson"],
        });
      }
    }
    const min = input.minGroupSize ?? null;
    const max = input.maxGroupSize ?? null;
    const target = input.targetGroupSize ?? null;
    if (min !== null && max !== null && min > max) {
      ctx.addIssue({
        code: "custom",
        message: "minGroupSize cannot exceed maxGroupSize",
        path: ["minGroupSize"],
      });
    }
    if (target !== null) {
      if (min !== null && target < min) {
        ctx.addIssue({
          code: "custom",
          message: "targetGroupSize cannot be below minGroupSize",
          path: ["targetGroupSize"],
        });
      }
      if (max !== null && target > max) {
        ctx.addIssue({
          code: "custom",
          message: "targetGroupSize cannot exceed maxGroupSize",
          path: ["targetGroupSize"],
        });
      }
    }
  });

export type CitySettingsInput = z.infer<typeof citySettingsInputSchema>;

export class IntroductionSettingsError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "IntroductionSettingsError";
  }
}

export async function getCitySettings(
  db: AppDb,
  cityCode: string
): Promise<CityIntroductionSettings | null> {
  const rows = await db
    .select()
    .from(cityIntroductionSettings)
    .where(eq(cityIntroductionSettings.cityCode, cityCode))
    .limit(1);
  return rows[0] ?? null;
}

export async function listCitySettings(db: AppDb): Promise<CityIntroductionSettings[]> {
  return db
    .select()
    .from(cityIntroductionSettings)
    .orderBy(cityIntroductionSettings.cityName);
}

export async function upsertCitySettings(
  db: AppDb,
  cityCode: string,
  input: CitySettingsInput
): Promise<CityIntroductionSettings> {
  const parsed = citySettingsInputSchema.parse(input);
  const values = {
    cityCode,
    cityName: parsed.cityName,
    enabled: parsed.enabled,
    schedulingMode: parsed.schedulingMode,
    scheduleJson: parsed.scheduleJson,
    nextRunAt: parsed.nextRunAt != null ? new Date(parsed.nextRunAt) : undefined,
    matchingProfileVersionId: parsed.matchingProfileVersionId,
    emailTemplateVersionId: parsed.emailTemplateVersionId,
    targetGroupSize: parsed.targetGroupSize,
    minGroupSize: parsed.minGroupSize,
    maxGroupSize: parsed.maxGroupSize,
    strictGroupSize: parsed.strictGroupSize,
    requireSameCity: parsed.requireSameCity,
    maxDistanceKm: parsed.maxDistanceKm,
    allowUnknownPostcode: parsed.allowUnknownPostcode,
    repeatPairDays: parsed.repeatPairDays,
    memberCooldownDays: parsed.memberCooldownDays,
    minEligibleMembers: parsed.minEligibleMembers,
    autoApprove: parsed.autoApprove,
    autoApproveDeliveryMode: parsed.autoApproveDeliveryMode,
    meetupTime: parsed.meetupTime,
    updatedAt: new Date(),
  };
  const rows = await db
    .insert(cityIntroductionSettings)
    .values({ id: crypto.randomUUID(), ...values })
    .onConflictDoUpdate({ target: cityIntroductionSettings.cityCode, set: values })
    .returning();
  return rows[0];
}

export interface ResolvedConstraints {
  requireSameCity: boolean;
  maxDistanceKm: number | null;
  allowUnknownPostcode: boolean;
  repeatPairDays: number;
  memberCooldownDays: number;
  minEligibleMembers: number;
}

export interface EffectiveGroupSizes {
  target: number;
  min: number;
  max: number;
  strict: boolean;
}

export interface EffectiveCitySettings {
  cityCode: string;
  cityName: string | null;
  enabled: boolean;
  schedulingMode: "manual" | "scheduled";
  schedule: CitySchedule | null;
  nextRunAt: Date | null;
  autoApprove: boolean;
  /** "HH:mm" local meetup time for the {{meetup_suggestion}} placeholder. */
  meetupTime: string;
  profileId: string | null;
  profileVersionId: string | null;
  profileVersionNumber: number | null;
  weightsRaw: MatchingWeights;
  weights: NormalizedWeights;
  constraints: ResolvedConstraints;
  groupSizes: EffectiveGroupSizes;
  emailTemplateVersionId: string | null;
}

/**
 * Merge the matching profile (or built-in defaults) with city-level
 * overrides into the single effective configuration a city run uses.
 * Repeat-window resolution order: city override -> profile -> env fallback.
 */
export async function resolveEffectiveCitySettings(
  db: AppDb,
  cityCode: string
): Promise<EffectiveCitySettings> {
  const city = await getCitySettings(db, cityCode);
  const profile = await resolveMatchingProfile(db, city?.matchingProfileVersionId ?? null);
  const c: MatchingConstraints = profile.constraints;

  const constraints: ResolvedConstraints = {
    requireSameCity: city?.requireSameCity ?? c.requireSameCity,
    maxDistanceKm: city?.maxDistanceKm != null ? city.maxDistanceKm : c.maxDistanceKm,
    allowUnknownPostcode: city?.allowUnknownPostcode ?? c.allowUnknownPostcode,
    repeatPairDays: city?.repeatPairDays ?? c.repeatPairDays,
    memberCooldownDays: city?.memberCooldownDays ?? c.memberCooldownDays,
    minEligibleMembers: city?.minEligibleMembers ?? c.minEligibleMembers,
  };

  const groupSizes: EffectiveGroupSizes = {
    target: city?.targetGroupSize ?? c.targetGroupSize,
    min: city?.minGroupSize ?? c.minGroupSize,
    max: city?.maxGroupSize ?? c.maxGroupSize,
    strict: city?.strictGroupSize ?? c.strictGroupSize,
  };

  if (groupSizes.min > groupSizes.max) {
    throw new IntroductionSettingsError(
      "INVALID_CITY_SETTINGS",
      `City ${cityCode} has minGroupSize > maxGroupSize`
    );
  }
  if (groupSizes.target < groupSizes.min || groupSizes.target > groupSizes.max) {
    throw new IntroductionSettingsError(
      "INVALID_CITY_SETTINGS",
      `City ${cityCode} targetGroupSize outside [minGroupSize, maxGroupSize]`
    );
  }

  let schedule: CitySchedule | null = null;
  if (city?.scheduleJson) {
    try {
      schedule = cityScheduleSchema.parse(JSON.parse(city.scheduleJson));
    } catch {
      throw new IntroductionSettingsError(
        "INVALID_CITY_SETTINGS",
        `City ${cityCode} has an invalid scheduleJson`
      );
    }
  }

  return {
    cityCode,
    cityName: city?.cityName ?? null,
    enabled: city?.enabled ?? false,
    schedulingMode: (city?.schedulingMode ?? "manual") as "manual" | "scheduled",
    schedule,
    nextRunAt: city?.nextRunAt ?? null,
    autoApprove: city?.autoApprove ?? false,
    meetupTime: city?.meetupTime ?? "10:00",
    profileId: profile.profile?.id ?? null,
    profileVersionId: profile.version?.id ?? null,
    profileVersionNumber: profile.version?.version ?? null,
    weightsRaw: profile.weightsRaw,
    weights: profile.weights,
    constraints,
    groupSizes,
    emailTemplateVersionId: city?.emailTemplateVersionId ?? null,
  };
}

export interface GlobalIntroductionConfig {
  senderFrom: string;
  canaryEmails: string[];
  providerTestEmails: string[];
  defaultProfileId: string | null;
  defaultTemplateId: string | null;
}

function parseEmailListJson(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

export async function getGlobalIntroductionConfig(db: AppDb): Promise<GlobalIntroductionConfig> {
  const rows = await db
    .select()
    .from(introductionConfig)
    .where(inArray(introductionConfig.key, Object.values(GLOBAL_CONFIG_KEYS)));
  const map = new Map(rows.map((row) => [row.key, row.valueJson]));
  return {
    senderFrom:
      map.get(GLOBAL_CONFIG_KEYS.senderFrom) ||
      process.env.INTRO_SENDER_EMAIL?.trim() ||
      DEFAULT_SENDER_FROM,
    canaryEmails: parseEmailListJson(map.get(GLOBAL_CONFIG_KEYS.canaryEmails)),
    providerTestEmails: parseEmailListJson(map.get(GLOBAL_CONFIG_KEYS.providerTestEmails)),
    defaultProfileId: map.get(GLOBAL_CONFIG_KEYS.defaultProfileId) || null,
    defaultTemplateId: map.get(GLOBAL_CONFIG_KEYS.defaultTemplateId) || null,
  };
}

export const globalConfigPatchSchema = z.object({
  senderFrom: z.string().trim().min(3).max(120).optional(),
  canaryEmails: z.array(z.string().email()).max(50).optional(),
  providerTestEmails: z.array(z.string().email()).max(50).optional(),
  defaultProfileId: z.string().min(1).nullable().optional(),
  defaultTemplateId: z.string().min(1).nullable().optional(),
});

export type GlobalConfigPatch = z.infer<typeof globalConfigPatchSchema>;

export async function setGlobalIntroductionConfig(
  db: AppDb,
  patch: GlobalConfigPatch
): Promise<GlobalIntroductionConfig> {
  const parsed = globalConfigPatchSchema.parse(patch);
  const entries: Array<{ key: string; valueJson: string }> = [];
  if (parsed.senderFrom !== undefined) {
    entries.push({ key: GLOBAL_CONFIG_KEYS.senderFrom, valueJson: parsed.senderFrom });
  }
  if (parsed.canaryEmails !== undefined) {
    entries.push({
      key: GLOBAL_CONFIG_KEYS.canaryEmails,
      valueJson: JSON.stringify(parsed.canaryEmails),
    });
  }
  if (parsed.providerTestEmails !== undefined) {
    entries.push({
      key: GLOBAL_CONFIG_KEYS.providerTestEmails,
      valueJson: JSON.stringify(parsed.providerTestEmails),
    });
  }
  if (parsed.defaultProfileId !== undefined) {
    entries.push({
      key: GLOBAL_CONFIG_KEYS.defaultProfileId,
      valueJson: parsed.defaultProfileId ?? "",
    });
  }
  if (parsed.defaultTemplateId !== undefined) {
    entries.push({
      key: GLOBAL_CONFIG_KEYS.defaultTemplateId,
      valueJson: parsed.defaultTemplateId ?? "",
    });
  }
  for (const entry of entries) {
    await db
      .insert(introductionConfig)
      .values({ key: entry.key, valueJson: entry.valueJson, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: introductionConfig.key,
        set: { valueJson: entry.valueJson, updatedAt: new Date() },
      });
  }
  return getGlobalIntroductionConfig(db);
}
