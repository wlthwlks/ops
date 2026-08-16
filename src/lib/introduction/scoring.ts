import { haversineDistanceKm } from "./geo-cache";
import {
  SCORE_COMPONENTS,
  type NormalizedWeights,
  type ScoreComponent,
} from "./profiles";
import {
  BUSINESS_STAGES,
} from "@/lib/forms/reference-data/static-options";

/**
 * Normalized 0-1 pair scoring for the unified introduction engine.
 *
 * Every component is a pure, deterministic function of the two members and
 * the scoring context; the weighted combination uses the normalized weights
 * from the run's matching profile version. Components with zero weight are
 * never computed and never appear in the breakdown.
 *
 * Adding a new dimension = add its key to SCORE_COMPONENTS in profiles.ts,
 * add a definition to COMPONENT_DEFS below, and give it a weight in the
 * matching profile. Nothing else needs to change.
 */

export interface ScorableMember {
  key: string;
  email: string;
  city: string | null;
  lat: number | null;
  lon: number | null;
  postcode: string | null;
  /** Normalized industry code (e.g. "TECH_SAAS"). */
  industry: string | null;
  /** Normalized business stage code (e.g. "EARLY_TRACTION"). */
  businessStage: string | null;
  /** Connection type code(s); may contain several. */
  connectionTypes: string[];
  /** Help-wanted category codes (from the MATCHING OPTIONS catalog). */
  helpWanted: string[];
  /** Free-text help-wanted context. */
  helpWantedText: string | null;
  /** Expertise category codes (from the MATCHING OPTIONS catalog). */
  expertise: string[];
  /** Free-text expertise context. */
  expertiseText: string | null;
  /** Free-text current 90-day goal. */
  goalText: string | null;
  profileVector: number[] | null;
  helpVector: number[] | null;
  expertiseVector: number[] | null;
  goalVector: number[] | null;
}

export interface ScoringContext {
  /** Distance at which the proximity component reaches 0. */
  maxDistanceKm?: number | null;
  /** Fallback decay scale when maxDistanceKm is not configured. */
  proximityScaleKm?: number;
  /**
   * Weight of the category overlap inside each help/expertise direction
   * (default 0.5; the remainder weights the text-vector cosine).
   */
  helpExpertiseCategoryWeight?: number;
}

export const DEFAULT_PROXIMITY_SCALE_KM = 50;

export interface PairScoreBreakdown {
  overall: number;
  components: Partial<Record<ScoreComponent, number>>;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Cosine in [-1, 1] clamped into [0, 1] (negative correlation scores 0). */
export function clampedCosine(a: number[], b: number[]): number {
  return clamp01(cosineSimilarity(a, b));
}

export function normalizeCode(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function proximityScore(
  ctx: ScoringContext,
  a: ScorableMember,
  b: ScorableMember
): number {
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return 0;
  const distance = haversineDistanceKm(a.lat, a.lon, b.lat, b.lon);
  const scale = ctx.maxDistanceKm ?? ctx.proximityScaleKm ?? DEFAULT_PROXIMITY_SCALE_KM;
  if (scale <= 0) return 0;
  return clamp01(1 - distance / scale);
}

function aiCorrelationScore(_ctx: ScoringContext, a: ScorableMember, b: ScorableMember): number {
  if (!a.profileVector || !b.profileVector) return 0;
  return clampedCosine(a.profileVector, b.profileVector);
}

/** How much of the smaller category set is covered by the intersection. */
export function categoryOverlap(need: string[], offer: string[]): number {
  if (need.length === 0 || offer.length === 0) return 0;
  const offerSet = new Set(offer);
  const intersection = need.filter((code) => offerSet.has(code)).length;
  return intersection / Math.min(need.length, offer.length);
}

function helpExpertiseDirection(
  categoryWeight: number,
  needCategories: string[],
  needVector: number[] | null,
  offerCategories: string[],
  offerVector: number[] | null
): number {
  const hasCategory = needCategories.length > 0 && offerCategories.length > 0;
  const hasText = Boolean(needVector && offerVector);
  if (!hasCategory && !hasText) return 0;

  // Renormalize when only one signal is available so a missing vector (or
  // missing categories) never drags a direction's score down.
  const categoryPart = hasCategory ? categoryOverlap(needCategories, offerCategories) : 0;
  const textPart = hasText ? clampedCosine(needVector!, offerVector!) : 0;
  if (hasCategory && hasText) {
    const textWeight = 1 - categoryWeight;
    return clamp01(categoryWeight * categoryPart + textWeight * textPart);
  }
  return clamp01(hasCategory ? categoryPart : textPart);
}

function helpExpertiseScore(
  ctx: ScoringContext,
  a: ScorableMember,
  b: ScorableMember
): number {
  const categoryWeight = clamp01(ctx.helpExpertiseCategoryWeight ?? 0.5);
  // A.HelpWanted → B.Expertise and B.HelpWanted → A.Expertise.
  const dirAB = helpExpertiseDirection(
    categoryWeight,
    a.helpWanted,
    a.helpVector,
    b.expertise,
    b.expertiseVector
  );
  const dirBA = helpExpertiseDirection(
    categoryWeight,
    b.helpWanted,
    b.helpVector,
    a.expertise,
    a.expertiseVector
  );
  return (dirAB + dirBA) / 2;
}

function goalRelevanceScore(_ctx: ScoringContext, a: ScorableMember, b: ScorableMember): number {
  if (!a.goalVector || !b.goalVector) return 0;
  return clampedCosine(a.goalVector, b.goalVector);
}

/**
 * Compatibility lookup keyed by the two codes sorted alphabetically with "<".
 * Anything not in the table (including unknown codes) scores 0.5.
 */
const CONNECTION_SCORES: Record<string, number> = {
  "SIMILAR_STAGE_PEER<SIMILAR_STAGE_PEER": 1,
  "ACCOUNTABILITY_PARTNER<ACCOUNTABILITY_PARTNER": 1,
  "COLLABORATOR_OR_REFERRAL<COLLABORATOR_OR_REFERRAL": 1,
  "I_CAN_MENTOR<I_CAN_MENTOR": 0.5,
  "MORE_EXPERIENCED_GUIDE<MORE_EXPERIENCED_GUIDE": 0.5,
  "LOCAL_CONNECTION<LOCAL_CONNECTION": 1,
  "I_CAN_MENTOR<MORE_EXPERIENCED_GUIDE": 1,
  "I_CAN_MENTOR<SIMILAR_STAGE_PEER": 0.75,
  "ACCOUNTABILITY_PARTNER<I_CAN_MENTOR": 0.5,
  "COLLABORATOR_OR_REFERRAL<I_CAN_MENTOR": 0.75,
  "I_CAN_MENTOR<LOCAL_CONNECTION": 1,
  "MORE_EXPERIENCED_GUIDE<SIMILAR_STAGE_PEER": 0.75,
  "ACCOUNTABILITY_PARTNER<MORE_EXPERIENCED_GUIDE": 0.5,
  "COLLABORATOR_OR_REFERRAL<MORE_EXPERIENCED_GUIDE": 0.75,
  "LOCAL_CONNECTION<MORE_EXPERIENCED_GUIDE": 1,
  "ACCOUNTABILITY_PARTNER<SIMILAR_STAGE_PEER": 0.5,
  "COLLABORATOR_OR_REFERRAL<SIMILAR_STAGE_PEER": 0.5,
  "LOCAL_CONNECTION<SIMILAR_STAGE_PEER": 1,
  "ACCOUNTABILITY_PARTNER<COLLABORATOR_OR_REFERRAL": 0.75,
  "ACCOUNTABILITY_PARTNER<LOCAL_CONNECTION": 1,
  "COLLABORATOR_OR_REFERRAL<LOCAL_CONNECTION": 1,
};

function connectionTypePairScore(codeA: string, codeB: string): number {
  const a = normalizeCode(codeA);
  const b = normalizeCode(codeB);
  if (!a || !b) return 0.5;
  if (a === "NO_PREFERENCE" || b === "NO_PREFERENCE") return 1;
  const key = [a, b].sort().join("<");
  return CONNECTION_SCORES[key] ?? 0.5;
}

function connectionTypeScore(_ctx: ScoringContext, a: ScorableMember, b: ScorableMember): number {
  const typesA =
    a.connectionTypes.length > 0 ? a.connectionTypes : ["NO_PREFERENCE"];
  const typesB =
    b.connectionTypes.length > 0 ? b.connectionTypes : ["NO_PREFERENCE"];
  let best = 0;
  for (const typeA of typesA) {
    for (const typeB of typesB) {
      best = Math.max(best, connectionTypePairScore(typeA, typeB));
    }
  }
  return best;
}

function industryScore(_ctx: ScoringContext, a: ScorableMember, b: ScorableMember): number {
  const industryA = normalizeCode(a.industry);
  const industryB = normalizeCode(b.industry);
  if (!industryA || !industryB) return 0;
  return industryA === industryB ? 1 : 0;
}

const BUSINESS_STAGE_ORDER: string[] = BUSINESS_STAGES.map((entry) => entry.code);

function businessStageScore(_ctx: ScoringContext, a: ScorableMember, b: ScorableMember): number {
  const stageA = normalizeCode(a.businessStage);
  const stageB = normalizeCode(b.businessStage);
  const indexA = BUSINESS_STAGE_ORDER.indexOf(stageA);
  const indexB = BUSINESS_STAGE_ORDER.indexOf(stageB);
  if (indexA === -1 || indexB === -1) return 0;
  const maxDistance = BUSINESS_STAGE_ORDER.length - 1;
  return clamp01(1 - Math.abs(indexA - indexB) / maxDistance);
}

type ComponentFunction = (
  ctx: ScoringContext,
  a: ScorableMember,
  b: ScorableMember
) => number;

const COMPONENT_DEFS: Record<ScoreComponent, ComponentFunction> = {
  proximity: proximityScore,
  ai_correlation: aiCorrelationScore,
  help_expertise: helpExpertiseScore,
  goal_relevance: goalRelevanceScore,
  connection_type: connectionTypeScore,
  industry: industryScore,
  business_stage: businessStageScore,
};

export function scoreComponent(
  component: ScoreComponent,
  ctx: ScoringContext,
  a: ScorableMember,
  b: ScorableMember
): number {
  return round6(COMPONENT_DEFS[component](ctx, a, b));
}

/**
 * Score a pair: enabled (non-zero-weight) components are computed, rounded,
 * and combined with the normalized weights. Deterministic for identical
 * inputs (weights and members).
 */
export function scorePair(
  a: ScorableMember,
  b: ScorableMember,
  weights: NormalizedWeights,
  ctx: ScoringContext = {}
): PairScoreBreakdown {
  const components: Partial<Record<ScoreComponent, number>> = {};
  let overall = 0;
  for (const component of SCORE_COMPONENTS) {
    const weight = weights.components[component];
    if (weight <= 0) continue;
    const score = scoreComponent(component, ctx, a, b);
    components[component] = score;
    overall += weight * score;
  }
  return { overall: round6(overall), components };
}

/**
 * Group quality: mean of every intra-group pair score. Returns 0 for
 * groups with fewer than two members.
 */
export function scoreGroupMembers(
  members: ScorableMember[],
  weights: NormalizedWeights,
  ctx: ScoringContext = {}
): PairScoreBreakdown {
  if (members.length < 2) {
    return { overall: 0, components: {} };
  }
  const totals: Partial<Record<ScoreComponent, number>> = {};
  let pairCount = 0;
  let overallSum = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const pair = scorePair(members[i], members[j], weights, ctx);
      pairCount += 1;
      overallSum += pair.overall;
      for (const [component, score] of Object.entries(pair.components)) {
        const key = component as ScoreComponent;
        totals[key] = (totals[key] ?? 0) + (score ?? 0);
      }
    }
  }
  const components: Partial<Record<ScoreComponent, number>> = {};
  for (const [component, sum] of Object.entries(totals)) {
    components[component as ScoreComponent] = round6((sum ?? 0) / pairCount);
  }
  return { overall: round6(overallSum / pairCount), components };
}
