import { desc, eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  matchingProfiles,
  matchingProfileVersions,
  type MatchingProfile,
  type MatchingProfileVersion,
} from "@/db/schema";
import { z } from "zod";

/**
 * Matching profiles and their immutable versions for the unified
 * introduction engine. Weights are stored raw (relative numbers) and
 * normalized to sum to 1 at scoring time so admins can edit them freely
 * without recalculating percentages by hand.
 */

export const SCORE_COMPONENTS = [
  "proximity",
  "ai_correlation",
  "help_expertise",
  "goal_relevance",
  "connection_type",
  "industry",
  "business_stage",
] as const;

export type ScoreComponent = (typeof SCORE_COMPONENTS)[number];

export type MatchingWeights = Partial<Record<ScoreComponent, number>>;

export const DEFAULT_WEIGHTS: Required<MatchingWeights> = {
  proximity: 30,
  ai_correlation: 25,
  help_expertise: 20,
  goal_relevance: 10,
  connection_type: 5,
  industry: 5,
  business_stage: 5,
};

const weightValue = z.number().min(0).max(1_000_000);

export const matchingWeightsSchema = z
  .object({
    proximity: weightValue.optional(),
    ai_correlation: weightValue.optional(),
    help_expertise: weightValue.optional(),
    goal_relevance: weightValue.optional(),
    connection_type: weightValue.optional(),
    industry: weightValue.optional(),
    business_stage: weightValue.optional(),
  })
  .refine(
    (w) => Object.values(w).some((v) => v !== undefined && v > 0),
    { message: "At least one score weight must be greater than zero" }
  );

const groupSizeValue = z.number().int().min(2).max(12);

export function envPairCooldownDays(): number {
  const parsed = Number.parseInt(process.env.INTRO_PAIR_COOLDOWN_DAYS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

export function envMemberCooldownDays(): number {
  const parsed = Number.parseInt(process.env.INTRO_MEMBER_COOLDOWN_DAYS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 14;
}

export const matchingConstraintsSchema = z
  .object({
    requireSameCity: z.boolean().default(true),
    maxDistanceKm: z.number().positive().nullable().default(null),
    // Lenient by default: members without a (geocodable) postcode stay in the
    // pool with proximity 0 rather than being excluded. Set false for strict.
    allowUnknownPostcode: z.boolean().default(true),
    repeatPairDays: z.number().int().min(1).default(envPairCooldownDays),
    memberCooldownDays: z.number().int().min(0).default(envMemberCooldownDays),
    targetGroupSize: groupSizeValue.default(3),
    minGroupSize: groupSizeValue.default(2),
    maxGroupSize: groupSizeValue.default(6),
    strictGroupSize: z.boolean().default(false),
  })
  .superRefine((c, ctx) => {
    if (c.minGroupSize > c.maxGroupSize) {
      ctx.addIssue({
        code: "custom",
        message: "minGroupSize cannot exceed maxGroupSize",
        path: ["minGroupSize"],
      });
    }
    if (c.targetGroupSize < c.minGroupSize || c.targetGroupSize > c.maxGroupSize) {
      ctx.addIssue({
        code: "custom",
        message: "targetGroupSize must be between minGroupSize and maxGroupSize",
        path: ["targetGroupSize"],
      });
    }
  });

export type MatchingConstraints = z.infer<typeof matchingConstraintsSchema>;

export function defaultConstraints(): MatchingConstraints {
  return matchingConstraintsSchema.parse({});
}

export interface NormalizedWeights {
  /** Per-component normalized weight, each in 0-1, summing to 1 (0 when total is 0). */
  components: Record<ScoreComponent, number>;
  /** Sum of the raw weights. */
  total: number;
  /** Components with a non-zero normalized weight. */
  enabled: ScoreComponent[];
}

export function normalizeWeights(weights: MatchingWeights): NormalizedWeights {
  const parsed = matchingWeightsSchema.parse(weights);
  let total = 0;
  const raw: Record<ScoreComponent, number> = {} as Record<ScoreComponent, number>;
  for (const key of SCORE_COMPONENTS) {
    const value = parsed[key] ?? 0;
    raw[key] = value;
    total += value;
  }
  const components = {} as Record<ScoreComponent, number>;
  const enabled: ScoreComponent[] = [];
  for (const key of SCORE_COMPONENTS) {
    const normalized = total > 0 ? raw[key] / total : 0;
    components[key] = normalized;
    if (normalized > 0) enabled.push(key);
  }
  return { components, total, enabled };
}

export function defaultNormalizedWeights(): NormalizedWeights {
  return normalizeWeights(DEFAULT_WEIGHTS);
}

export function weightsToJson(weights: MatchingWeights): string {
  const parsed = matchingWeightsSchema.parse(weights);
  const full: Required<MatchingWeights> = {} as Required<MatchingWeights>;
  for (const key of SCORE_COMPONENTS) {
    full[key] = parsed[key] ?? 0;
  }
  return JSON.stringify(full);
}

export function weightsFromJson(json: string): MatchingWeights {
  return matchingWeightsSchema.parse(JSON.parse(json));
}

export function constraintsToJson(constraints: MatchingConstraints): string {
  return JSON.stringify(matchingConstraintsSchema.parse(constraints));
}

export function constraintsFromJson(json: string): MatchingConstraints {
  return matchingConstraintsSchema.parse(JSON.parse(json));
}

export class MatchingProfilesError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "MatchingProfilesError";
  }
}

export const matchingProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  isDefault: z.boolean().optional(),
});

export const matchingProfileVersionInputSchema = z.object({
  weights: matchingWeightsSchema.optional(),
  constraints: matchingConstraintsSchema.optional(),
});

export interface ProfileWithLatest {
  profile: MatchingProfile;
  latestVersion: MatchingProfileVersion | null;
}

export async function listMatchingProfiles(db: AppDb): Promise<ProfileWithLatest[]> {
  const rows = await db
    .select()
    .from(matchingProfiles)
    .orderBy(desc(matchingProfiles.createdAt));
  const withLatest: ProfileWithLatest[] = [];
  for (const profile of rows) {
    withLatest.push({ profile, latestVersion: await getLatestVersionForProfile(db, profile.id) });
  }
  return withLatest;
}

export async function getMatchingProfile(db: AppDb, id: string): Promise<MatchingProfile | null> {
  const rows = await db.select().from(matchingProfiles).where(eq(matchingProfiles.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function createMatchingProfile(
  db: AppDb,
  input: z.infer<typeof matchingProfileInputSchema>
): Promise<MatchingProfile> {
  const parsed = matchingProfileInputSchema.parse(input);
  const id = crypto.randomUUID();
  if (parsed.isDefault) {
    await clearDefaultProfiles(db);
  }
  const rows = await db
    .insert(matchingProfiles)
    .values({
      id,
      name: parsed.name,
      description: parsed.description ?? null,
      isDefault: parsed.isDefault ?? false,
      status: "draft",
    })
    .returning();
  return rows[0];
}

export async function updateMatchingProfile(
  db: AppDb,
  id: string,
  input: { name?: string; description?: string | null; status?: string; isDefault?: boolean }
): Promise<MatchingProfile> {
  const existing = await getMatchingProfile(db, id);
  if (!existing) {
    throw new MatchingProfilesError("MATCHING_PROFILE_NOT_FOUND", `Matching profile ${id} not found`);
  }
  if (input.isDefault) {
    await clearDefaultProfiles(db);
  }
  const rows = await db
    .update(matchingProfiles)
    .set({
      name: input.name ?? existing.name,
      description: input.description !== undefined ? input.description : existing.description,
      status: input.status ?? existing.status,
      isDefault: input.isDefault !== undefined ? input.isDefault : existing.isDefault,
      updatedAt: new Date(),
    })
    .where(eq(matchingProfiles.id, id))
    .returning();
  return rows[0];
}

async function clearDefaultProfiles(db: AppDb): Promise<void> {
  await db.update(matchingProfiles).set({ isDefault: false, updatedAt: new Date() });
}

export async function getLatestVersionForProfile(
  db: AppDb,
  profileId: string
): Promise<MatchingProfileVersion | null> {
  const rows = await db
    .select()
    .from(matchingProfileVersions)
    .where(eq(matchingProfileVersions.profileId, profileId))
    .orderBy(desc(matchingProfileVersions.version))
    .limit(1);
  return rows[0] ?? null;
}

export async function listVersionsForProfile(
  db: AppDb,
  profileId: string
): Promise<MatchingProfileVersion[]> {
  return db
    .select()
    .from(matchingProfileVersions)
    .where(eq(matchingProfileVersions.profileId, profileId))
    .orderBy(desc(matchingProfileVersions.version));
}

export async function createMatchingProfileVersion(
  db: AppDb,
  input: {
    profileId: string;
    weights?: MatchingWeights;
    constraints?: MatchingConstraints;
    createdBy?: string;
  }
): Promise<MatchingProfileVersion> {
  const profile = await getMatchingProfile(db, input.profileId);
  if (!profile) {
    throw new MatchingProfilesError(
      "MATCHING_PROFILE_NOT_FOUND",
      `Matching profile ${input.profileId} not found`
    );
  }
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const constraints = input.constraints ?? defaultConstraints();
  const latest = await getLatestVersionForProfile(db, input.profileId);
  const nextVersion = (latest?.version ?? 0) + 1;
  const rows = await db
    .insert(matchingProfileVersions)
    .values({
      id: crypto.randomUUID(),
      profileId: input.profileId,
      version: nextVersion,
      weightsJson: weightsToJson(weights),
      constraintsJson: constraintsToJson(constraints),
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return rows[0];
}

export async function getMatchingProfileVersionById(
  db: AppDb,
  versionId: string
): Promise<MatchingProfileVersion | null> {
  const rows = await db
    .select()
    .from(matchingProfileVersions)
    .where(eq(matchingProfileVersions.id, versionId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getDefaultProfileAndVersion(
  db: AppDb
): Promise<{ profile: MatchingProfile; version: MatchingProfileVersion | null } | null> {
  const defaults = await db
    .select()
    .from(matchingProfiles)
    .where(eq(matchingProfiles.isDefault, true))
    .orderBy(desc(matchingProfiles.createdAt))
    .limit(1);
  const profile = defaults[0];
  if (!profile) return null;
  return { profile, version: await getLatestVersionForProfile(db, profile.id) };
}

export interface ResolvedMatchingProfile {
  profile: MatchingProfile | null;
  version: MatchingProfileVersion | null;
  weightsRaw: MatchingWeights;
  weights: NormalizedWeights;
  constraints: MatchingConstraints;
}

/**
 * Resolve the matching profile + version that a run should use.
 * An explicit version id wins; otherwise the default profile's latest
 * version. When nothing is configured the engine falls back to the
 * built-in default weights and constraints so previews always work.
 */
export async function resolveMatchingProfile(
  db: AppDb,
  profileVersionId?: string | null
): Promise<ResolvedMatchingProfile> {
  if (profileVersionId) {
    const version = await getMatchingProfileVersionById(db, profileVersionId);
    if (!version) {
      throw new MatchingProfilesError(
        "MATCHING_PROFILE_VERSION_NOT_FOUND",
        `Matching profile version ${profileVersionId} not found`
      );
    }
    const profile = await getMatchingProfile(db, version.profileId);
    if (!profile) {
      throw new MatchingProfilesError(
        "MATCHING_PROFILE_NOT_FOUND",
        `Matching profile ${version.profileId} not found`
      );
    }
    return {
      profile,
      version,
      weightsRaw: weightsFromJson(version.weightsJson),
      weights: normalizeWeights(weightsFromJson(version.weightsJson)),
      constraints: constraintsFromJson(version.constraintsJson),
    };
  }
  const fallback = await getDefaultProfileAndVersion(db);
  if (!fallback || !fallback.version) {
    return {
      profile: fallback?.profile ?? null,
      version: fallback?.version ?? null,
      weightsRaw: DEFAULT_WEIGHTS,
      weights: defaultNormalizedWeights(),
      constraints: defaultConstraints(),
    };
  }
  return {
    profile: fallback.profile,
    version: fallback.version,
    weightsRaw: weightsFromJson(fallback.version.weightsJson),
    weights: normalizeWeights(weightsFromJson(fallback.version.weightsJson)),
    constraints: constraintsFromJson(fallback.version.constraintsJson),
  };
}
