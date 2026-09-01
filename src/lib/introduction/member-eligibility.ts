import { normalizeCityKey } from "@/lib/ops/city-normalize";
import { evaluateServiceAccess } from "./service-access";
import { resolveIntroPauseState } from "./pause-state";
import { haversineDistanceKm } from "./geo-cache";
import { canonicalizeCityName } from "./city-matching";
import {
  isMemberRecent,
  isPairRecent,
  normalizeEmailKey,
  type PairHistory,
} from "./pair-history";
import type { ResolvedConstraints } from "./settings";

/**
 * Hard eligibility constraints for the unified introduction engine.
 * Everything in here is a hard gate — score weights never influence it.
 * Billing/access is consumed from the centralized service-access module
 * (never reimplemented), and introduction-specific states (Paused /
 * Excluded) are layered on top.
 */

export type MemberEligibilityReason =
  | "invalid_email"
  | "no_service_access"
  | "excluded"
  | "paused"
  | "city_mismatch"
  | "missing_postcode"
  | "unresolved_location";

export interface MemberEligibilityResult {
  eligible: boolean;
  reason: MemberEligibilityReason | null;
}

export interface MemberEligibilityInput {
  airtableRecordId: string;
  email: string | null | undefined;
  membership: string | null | undefined;
  payment: string | null | undefined;
  serviceAccessUntil: string | null | undefined;
  /** Airtable "Stripe subscription status" — "paused" blocks access. */
  stripeSubscriptionStatus?: string | null | undefined;
  recurringIntroStatus: string | null | undefined;
  recurringPauseUntil: string | null | undefined;
  city: string | null | undefined;
  postcode: string | null | undefined;
  lat: number | null | undefined;
  lon: number | null | undefined;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string | null | undefined): boolean {
  return EMAIL_REGEX.test((value ?? "").trim());
}

/** Stable member key: Airtable record id when available, else lowercased email. */
export function memberKey(
  email: string | null | undefined,
  airtableRecordId: string | null | undefined
): string {
  if (airtableRecordId) return `at:${airtableRecordId}`;
  return `em:${normalizeEmailKey(email)}`;
}

export interface MemberEligibilityOptions {
  cycleDate: Date;
  /**
   * Reference instant for the service-access evaluation. Defaults to
   * `cycleDate`; pass the plan-build time so members whose access is still
   * valid at build time (e.g. renewing at the end of the day before the
   * cycle) are not dropped.
   */
  accessReference?: Date;
  /** Normalized city the run is scoped to; null skips the city check. */
  runCity: string | null;
  constraints: ResolvedConstraints;
}

export function checkMemberEligibility(
  member: MemberEligibilityInput,
  options: MemberEligibilityOptions
): MemberEligibilityResult {
  if (!isValidEmail(member.email)) {
    return { eligible: false, reason: "invalid_email" };
  }

  const access = evaluateServiceAccess(
    member.membership ?? "",
    member.payment ?? "",
    member.serviceAccessUntil,
    options.accessReference ?? options.cycleDate,
    undefined,
    { stripeSubscriptionStatus: member.stripeSubscriptionStatus }
  );
  if (!access.accessible) {
    return { eligible: false, reason: "no_service_access" };
  }

  const pause = resolveIntroPauseState(
    member.recurringIntroStatus,
    member.recurringPauseUntil,
    options.cycleDate
  );
  if (pause.state === "excluded") {
    return { eligible: false, reason: "excluded" };
  }
  if (pause.isPaused) {
    return { eligible: false, reason: "paused" };
  }

  if (options.runCity != null) {
    // Both sides are canonicalized through the same alias table so member
    // cities that are standalone runs of their own (e.g. "Palo Alto" as its
    // own ALL CITIES record, historically an alias of "San Francisco") and
    // label variants ("St Louis" vs "St. Louis") never spuriously mismatch.
    const memberCityKey = normalizeCityKey(canonicalizeCityName(member.city ?? ""));
    const runCityKey = normalizeCityKey(canonicalizeCityName(options.runCity));
    if (!memberCityKey || !runCityKey || memberCityKey !== runCityKey) {
      return { eligible: false, reason: "city_mismatch" };
    }
  }

  const postcodeBlank = !(member.postcode ?? "").trim();
  const coordsMissing = member.lat == null || member.lon == null;

  if (postcodeBlank && !options.constraints.allowUnknownPostcode) {
    return { eligible: false, reason: "missing_postcode" };
  }
  if (!postcodeBlank && coordsMissing && !options.constraints.allowUnknownPostcode) {
    return { eligible: false, reason: "unresolved_location" };
  }

  return { eligible: true, reason: null };
}

export type PairEligibilityReason =
  | "self_pair"
  | "already_in_cycle"
  | "recent_pair_repeat"
  | "member_cooldown"
  | "not_same_city"
  | "distance_exceeds_max";

export interface PairEligibilityResult {
  eligible: boolean;
  reason: PairEligibilityReason | null;
  /** Distance in km when both members have coordinates, else null. */
  distanceKm: number | null;
}

export interface PairEligibilityOptions {
  cycleDate: Date;
  constraints: ResolvedConstraints;
  pairHistory: PairHistory;
  /** Normalized emails of members already placed in this cycle. */
  emailsInCycle: ReadonlySet<string>;
}

export type PairEligibilityMember = Pick<
  MemberEligibilityInput,
  "airtableRecordId" | "email" | "city" | "lat" | "lon"
>;

export function checkPairEligibility(
  a: PairEligibilityMember,
  b: PairEligibilityMember,
  options: PairEligibilityOptions
): PairEligibilityResult {
  const emailA = normalizeEmailKey(a.email);
  const emailB = normalizeEmailKey(b.email);

  if (a.airtableRecordId === b.airtableRecordId || (emailA && emailA === emailB)) {
    return { eligible: false, reason: "self_pair", distanceKm: null };
  }
  if (options.emailsInCycle.has(emailA) || options.emailsInCycle.has(emailB)) {
    return { eligible: false, reason: "already_in_cycle", distanceKm: null };
  }
  if (isPairRecent(options.pairHistory, emailA, emailB)) {
    return { eligible: false, reason: "recent_pair_repeat", distanceKm: null };
  }
  if (
    isMemberRecent(options.pairHistory, emailA) ||
    isMemberRecent(options.pairHistory, emailB)
  ) {
    return { eligible: false, reason: "member_cooldown", distanceKm: null };
  }

  if (options.constraints.requireSameCity) {
    const cityA = normalizeCityKey(a.city ?? "");
    const cityB = normalizeCityKey(b.city ?? "");
    if (!cityA || !cityB || cityA !== cityB) {
      return { eligible: false, reason: "not_same_city", distanceKm: null };
    }
  }

  const bothKnown = a.lat != null && a.lon != null && b.lat != null && b.lon != null;
  let distanceKm: number | null = null;
  if (bothKnown) {
    distanceKm = haversineDistanceKm(a.lat!, a.lon!, b.lat!, b.lon!);
    const max = options.constraints.maxDistanceKm;
    if (max != null && distanceKm > max) {
      return { eligible: false, reason: "distance_exceeds_max", distanceKm };
    }
  }

  return { eligible: true, reason: null, distanceKm };
}

/**
 * True when the member is already used somewhere in this cycle — the hard
 * "one appearance per cycle" rule for group construction.
 */
export function isMemberInCycle(
  emailsInCycle: ReadonlySet<string>,
  member: Pick<MemberEligibilityInput, "email">
): boolean {
  const email = normalizeEmailKey(member.email);
  return email !== "" && emailsInCycle.has(email);
}
