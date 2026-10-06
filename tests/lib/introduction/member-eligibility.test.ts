import { describe, it, expect } from "vitest";
import {
  checkMemberEligibility,
  checkPairEligibility,
  isMemberInCycle,
  isValidEmail,
  memberKey,
  type MemberEligibilityInput,
} from "@/lib/introduction/member-eligibility";
import type { ResolvedConstraints } from "@/lib/introduction/settings";
import type { PairHistory } from "@/lib/introduction/pair-history";

const CYCLE = new Date("2026-08-16T09:00:00Z");

const constraints: ResolvedConstraints = {
  requireSameCity: true,
  maxDistanceKm: null,
  allowUnknownPostcode: false,
  repeatPairDays: 60,
  memberCooldownDays: 14,
  minEligibleMembers: 0,
};

const emptyHistory: PairHistory = {
  recentPairs: new Set(),
  recentMemberEmails: new Set(),
};

function member(overrides: Partial<MemberEligibilityInput> = {}): MemberEligibilityInput {
  return {
    airtableRecordId: "rec_1",
    email: "alice@example.com",
    membership: "Active",
    payment: "Paid",
    serviceAccessUntil: null,
    stripeSubscriptionStatus: "active",
    recurringIntroStatus: "",
    recurringPauseUntil: null,
    city: "London",
    postcode: "SW1A 1AA",
    lat: 51.5074,
    lon: -0.1278,
    ...overrides,
  };
}

function pairOptions(overrides: Partial<Parameters<typeof checkPairEligibility>[2]> = {}) {
  return {
    cycleDate: CYCLE,
    constraints,
    pairHistory: emptyHistory,
    emailsInCycle: new Set<string>(),
    ...overrides,
  } as Parameters<typeof checkPairEligibility>[2];
}

describe("isValidEmail", () => {
  it("accepts normal emails and rejects junk", () => {
    expect(isValidEmail("alice@example.com")).toBe(true);
    expect(isValidEmail("  Bob@Example.COM ")).toBe(true);
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
  });
});

describe("memberKey", () => {
  it("prefers the Airtable record id and falls back to email", () => {
    expect(memberKey("a@x.com", "rec_1")).toBe("at:rec_1");
    expect(memberKey("A@X.com ", null)).toBe("em:a@x.com");
    expect(memberKey("a@x.com", "")).toBe("em:a@x.com");
  });
});

describe("checkMemberEligibility — active Stripe membership", () => {
  it("accepts members with an active Stripe subscription", () => {
    const result = checkMemberEligibility(member({ stripeSubscriptionStatus: "active" }), {
      cycleDate: CYCLE,
      runCity: null,
      constraints,
    });
    expect(result.eligible).toBe(true);
  });

  it("accepts members with a trialing Stripe subscription", () => {
    const result = checkMemberEligibility(member({ stripeSubscriptionStatus: "trialing" }), {
      cycleDate: CYCLE,
      runCity: null,
      constraints,
    });
    expect(result.eligible).toBe(true);
  });

  it("accepts members whose Stripe subscription is paused (pause collection)", () => {
    const result = checkMemberEligibility(member({ stripeSubscriptionStatus: "paused" }), {
      cycleDate: CYCLE,
      runCity: null,
      constraints,
    });
    expect(result.eligible).toBe(true);
  });

  it("excludes members with a canceled Stripe subscription", () => {
    const result = checkMemberEligibility(member({ stripeSubscriptionStatus: "canceled" }), {
      cycleDate: CYCLE,
      runCity: null,
      constraints,
    });
    expect(result).toEqual({ eligible: false, reason: "no_service_access" });
  });

  it("excludes members with a past_due Stripe subscription", () => {
    const result = checkMemberEligibility(member({ stripeSubscriptionStatus: "past_due" }), {
      cycleDate: CYCLE,
      runCity: null,
      constraints,
    });
    expect(result).toEqual({ eligible: false, reason: "no_service_access" });
  });

  it("excludes members with a blank Stripe subscription status", () => {
    const result = checkMemberEligibility(
      member({ stripeSubscriptionStatus: "" }),
      { cycleDate: CYCLE, runCity: null, constraints }
    );
    expect(result).toEqual({ eligible: false, reason: "no_service_access" });
  });

  it("compares Stripe status case-insensitively", () => {
    const result = checkMemberEligibility(member({ stripeSubscriptionStatus: "ACTIVE" }), {
      cycleDate: CYCLE,
      runCity: null,
      constraints,
    });
    expect(result.eligible).toBe(true);
  });

  it("rejects members with an invalid email", () => {
    const result = checkMemberEligibility(member({ email: "bad" }), {
      cycleDate: CYCLE,
      runCity: null,
      constraints,
    });
    expect(result).toEqual({ eligible: false, reason: "invalid_email" });
  });
});

describe("checkMemberEligibility — introduction states", () => {
  it("excludes members with Recurring intro status Excluded", () => {
    const result = checkMemberEligibility(member({ recurringIntroStatus: "Excluded" }), {
      cycleDate: CYCLE,
      runCity: null,
      constraints,
    });
    expect(result).toEqual({ eligible: false, reason: "excluded" });
  });

  it("accepts members with Recurring intro status Paused (no longer blocks)", () => {
    const result = checkMemberEligibility(
      member({ recurringIntroStatus: "Paused", recurringPauseUntil: "2026-09-01" }),
      { cycleDate: CYCLE, runCity: null, constraints }
    );
    expect(result.eligible).toBe(true);
  });

  it("accepts paused members with no pause end", () => {
    const result = checkMemberEligibility(member({ recurringIntroStatus: "Paused" }), {
      cycleDate: CYCLE,
      runCity: null,
      constraints,
    });
    expect(result.eligible).toBe(true);
  });
});

describe("checkMemberEligibility — city and postcode", () => {
  it("rejects members whose city does not match the run city", () => {
    const result = checkMemberEligibility(member({ city: "Paris" }), {
      cycleDate: CYCLE,
      runCity: "London",
      constraints,
    });
    expect(result).toEqual({ eligible: false, reason: "city_mismatch" });
  });

  it("compares cities case/accent-insensitively", () => {
    const result = checkMemberEligibility(member({ city: "  london " }), {
      cycleDate: CYCLE,
      runCity: "London",
      constraints,
    });
    expect(result.eligible).toBe(true);
  });

  it("accepts members whose city is a legacy alias of the run city", () => {
    // "Palo Alto" is a standalone city run, but historically an alternative
    // of "San Francisco" in the CITIES alias table.
    const result = checkMemberEligibility(member({ city: "Palo Alto" }), {
      cycleDate: CYCLE,
      runCity: "Palo Alto",
      constraints,
    });
    expect(result.eligible).toBe(true);
  });

  it("accepts already-canonicalized member cities against the raw run city", () => {
    // buildPlanMember canonicalizes "Palo Alto" → "San Francisco"; the run
    // city stays the raw name from city settings.
    const result = checkMemberEligibility(member({ city: "San Francisco" }), {
      cycleDate: CYCLE,
      runCity: "Palo Alto",
      constraints,
    });
    expect(result.eligible).toBe(true);
  });

  it("accepts label variants that differ in punctuation", () => {
    const result = checkMemberEligibility(member({ city: "St Louis" }), {
      cycleDate: CYCLE,
      runCity: "St. Louis",
      constraints,
    });
    expect(result.eligible).toBe(true);
  });

  it("still rejects genuinely different cities", () => {
    const result = checkMemberEligibility(member({ city: "Palo Alto" }), {
      cycleDate: CYCLE,
      runCity: "London",
      constraints,
    });
    expect(result).toEqual({ eligible: false, reason: "city_mismatch" });
  });

  it("rejects missing postcodes unless allowed", () => {
    const strict = checkMemberEligibility(member({ postcode: "" }), {
      cycleDate: CYCLE,
      runCity: null,
      constraints,
    });
    expect(strict).toEqual({ eligible: false, reason: "missing_postcode" });

    const lenient = checkMemberEligibility(member({ postcode: "" }), {
      cycleDate: CYCLE,
      runCity: null,
      constraints: { ...constraints, allowUnknownPostcode: true },
    });
    expect(lenient.eligible).toBe(true);
  });

  it("rejects unresolvable locations unless allowed", () => {
    const strict = checkMemberEligibility(member({ lat: null, lon: null }), {
      cycleDate: CYCLE,
      runCity: null,
      constraints,
    });
    expect(strict).toEqual({ eligible: false, reason: "unresolved_location" });

    const lenient = checkMemberEligibility(member({ lat: null, lon: null }), {
      cycleDate: CYCLE,
      runCity: null,
      constraints: { ...constraints, allowUnknownPostcode: true },
    });
    expect(lenient.eligible).toBe(true);
  });
});

describe("checkPairEligibility", () => {
  const bob = member({
    airtableRecordId: "rec_2",
    email: "bob@example.com",
    lat: 51.51,
    lon: -0.1,
  });

  it("rejects a member pairing with themselves", () => {
    const result = checkPairEligibility(member(), member(), pairOptions());
    expect(result.reason).toBe("self_pair");
    expect(result.eligible).toBe(false);
  });

  it("rejects a member already placed in the cycle", () => {
    const result = checkPairEligibility(
      member(),
      bob,
      pairOptions({ emailsInCycle: new Set(["bob@example.com"]) })
    );
    expect(result.reason).toBe("already_in_cycle");
  });

  it("rejects recent pair repeats from history", () => {
    const history: PairHistory = {
      recentPairs: new Set(["alice@example.com|bob@example.com"]),
      recentMemberEmails: new Set(),
    };
    const result = checkPairEligibility(member(), bob, pairOptions({ pairHistory: history }));
    expect(result.reason).toBe("recent_pair_repeat");
  });

  it("rejects members on cooldown", () => {
    const history: PairHistory = {
      recentPairs: new Set(),
      recentMemberEmails: new Set(["alice@example.com"]),
    };
    const result = checkPairEligibility(member(), bob, pairOptions({ pairHistory: history }));
    expect(result.reason).toBe("member_cooldown");
  });

  it("rejects different-city pairs when same-city is required", () => {
    const result = checkPairEligibility(
      member(),
      member({ airtableRecordId: "rec_2", email: "bob@example.com", city: "Paris" }),
      pairOptions()
    );
    expect(result.reason).toBe("not_same_city");
  });

  it("allows different-city pairs when same-city is not required", () => {
    const result = checkPairEligibility(
      member(),
      member({ airtableRecordId: "rec_2", email: "bob@example.com", city: "Paris" }),
      pairOptions({ constraints: { ...constraints, requireSameCity: false } })
    );
    expect(result.eligible).toBe(true);
  });

  it("rejects pairs exceeding the maximum distance", () => {
    const far = member({ airtableRecordId: "rec_2", email: "bob@example.com", lat: 48.85, lon: 2.35 });
    const result = checkPairEligibility(
      member(),
      far,
      pairOptions({ constraints: { ...constraints, maxDistanceKm: 50 } })
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("distance_exceeds_max");
    expect(result.distanceKm).toBeGreaterThan(300);
  });

  it("accepts pairs within the maximum distance and returns the distance", () => {
    const result = checkPairEligibility(member(), bob, pairOptions());
    expect(result.eligible).toBe(true);
    expect(result.distanceKm).toBeCloseTo(2.1, 0);
  });

  it("allows pairs with unknown coordinates at member level", () => {
    const unknown = member({ airtableRecordId: "rec_2", email: "bob@example.com", lat: null, lon: null });
    const result = checkPairEligibility(member(), unknown, pairOptions());
    expect(result.eligible).toBe(true);
    expect(result.distanceKm).toBeNull();
  });
});

describe("isMemberInCycle", () => {
  it("detects a member already in the cycle", () => {
    expect(isMemberInCycle(new Set(["alice@example.com"]), { email: "Alice@Example.com" })).toBe(true);
    expect(isMemberInCycle(new Set(), { email: "alice@example.com" })).toBe(false);
    expect(isMemberInCycle(new Set(), { email: "" })).toBe(false);
  });
});
