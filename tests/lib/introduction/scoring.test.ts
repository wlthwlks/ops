import { describe, it, expect } from "vitest";
import {
  ScorableMember,
  categoryOverlap,
  clamp01,
  clampedCosine,
  cosineSimilarity,
  scoreComponent,
  scoreGroupMembers,
  scorePair,
} from "@/lib/introduction/scoring";
import {
  DEFAULT_WEIGHTS,
  normalizeWeights,
  SCORE_COMPONENTS,
} from "@/lib/introduction/profiles";

function member(overrides: Partial<ScorableMember> = {}): ScorableMember {
  return {
    key: "at:rec_a123456789",
    email: "a@example.com",
    city: "London",
    lat: 51.5074,
    lon: -0.1278,
    postcode: "SW1A 1AA",
    industry: "TECH_SAAS",
    businessStage: "EARLY_TRACTION",
    connectionTypes: ["SIMILAR_STAGE_PEER"],
    helpWanted: ["FUNDRAISING"],
    helpWantedText: "Closing a pre-seed round",
    expertise: ["GROWTH_MARKETING"],
    expertiseText: "Ten years in B2B SaaS",
    goalText: "Reach 500 paying customers",
    profileVector: [1, 0, 0],
    helpVector: [0, 1, 0],
    expertiseVector: [0, 0, 1],
    goalVector: [1, 1, 0],
    ...overrides,
  };
}

const defaultWeights = normalizeWeights(DEFAULT_WEIGHTS);

describe("vector helpers", () => {
  it("computes cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 1], [2, 2])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([], [1])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("clamps negative cosine to 0 via clampedCosine", () => {
    expect(clampedCosine([1, 0], [-1, 0])).toBe(0);
    expect(clampedCosine([1, 0], [1, 0])).toBe(1);
  });

  it("clamps values into 0-1", () => {
    expect(clamp01(-5)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(42)).toBe(1);
  });
});

describe("proximity component", () => {
  it("scores 1 at the same point and 0 beyond the scale", () => {
    const a = member({ lat: 51.5, lon: -0.12 });
    const same = member({ key: "at:rec_b123456789", email: "b@example.com", lat: 51.5, lon: -0.12 });
    const far = member({ key: "at:rec_b123456789", email: "b@example.com", lat: 40.7, lon: -74 });

    expect(scoreComponent("proximity", {}, a, same)).toBe(1);
    expect(scoreComponent("proximity", {}, a, far)).toBe(0);
  });

  it("scores 0 when coordinates are unknown", () => {
    const a = member();
    const unknown = member({ key: "at:rec_b123456789", email: "b@example.com", lat: null, lon: null });
    expect(scoreComponent("proximity", {}, a, unknown)).toBe(0);
    expect(scoreComponent("proximity", {}, unknown, unknown)).toBe(0);
  });

  it("uses maxDistanceKm as the decay scale when configured", () => {
    const a = member({ lat: 51.5, lon: -0.12 });
    // ~2.1 km away (see eligibility tests)
    const near = member({ key: "at:rec_b123456789", email: "b@example.com", lat: 51.51, lon: -0.1 });
    const strict = scoreComponent("proximity", { maxDistanceKm: 3 }, a, near);
    const loose = scoreComponent("proximity", { maxDistanceKm: 100 }, a, near);
    expect(strict).toBeLessThan(loose);
    expect(strict).toBeGreaterThan(0);
    // beyond the max distance → 0
    expect(scoreComponent("proximity", { maxDistanceKm: 0.001 }, a, near)).toBe(0);
  });
});

describe("ai correlation component", () => {
  it("scores 1 for identical profile vectors and 0 when missing", () => {
    const a = member({ profileVector: [1, 2, 3] });
    const b = member({ key: "at:rec_b123456789", email: "b@example.com", profileVector: [2, 4, 6] });
    const missing = member({ key: "at:rec_c123456789", email: "c@example.com", profileVector: null });
    expect(scoreComponent("ai_correlation", {}, a, b)).toBeCloseTo(1, 6);
    expect(scoreComponent("ai_correlation", {}, a, missing)).toBe(0);
  });
});

describe("help/expertise complementarity", () => {
  it("scores category overlap in both directions", () => {
    const a = member({
      helpWanted: ["FUNDRAISING", "SALES"],
      expertise: ["PRODUCT"],
      helpVector: null,
      expertiseVector: null,
    });
    const b = member({
      key: "at:rec_b123456789",
      email: "b@example.com",
      helpWanted: ["PRODUCT"],
      expertise: ["SALES", "FUNDRAISING", "HIRING"],
      helpVector: null,
      expertiseVector: null,
    });
    // dir A→B: A needs [FUNDRAISING, SALES], B offers SALES+FUNDRAISING+HIRING → 2/2 = 1
    // dir B→A: B needs [PRODUCT], A offers PRODUCT → 1/1 = 1
    expect(scoreComponent("help_expertise", {}, a, b)).toBeCloseTo(1, 6);
  });

  it("scores partial category overlap", () => {
    const a = member({ helpWanted: ["FUNDRAISING", "SALES"], helpVector: null, expertiseVector: null });
    const b = member({
      key: "at:rec_b123456789",
      email: "b@example.com",
      helpWanted: ["PRODUCT"],
      expertise: ["SALES"],
      helpVector: null,
      expertiseVector: null,
    });
    // A→B: need [FUNDRAISING, SALES] vs offer [SALES] → 1/min(2,1) = 1
    // B→A: need [PRODUCT] vs offer [GROWTH_MARKETING] → 0
    expect(scoreComponent("help_expertise", {}, a, b)).toBeCloseTo(0.5, 6);
  });

  it("scores 0 when either side has no categories", () => {
    const a = member({ helpWanted: [], expertise: [], helpVector: null, expertiseVector: null });
    const b = member({
      key: "at:rec_b123456789",
      email: "b@example.com",
      helpWanted: [],
      expertise: [],
      helpVector: null,
      expertiseVector: null,
    });
    expect(scoreComponent("help_expertise", {}, a, b)).toBe(0);
  });

  it("combines category overlap with text-vector similarity", () => {
    // categoryWeight 0 → text cosine only.
    const a = member({
      helpVector: [1, 0],
      expertiseVector: [0, 1],
      helpWanted: ["FUNDRAISING"],
      expertise: ["FUNDRAISING"],
    });
    const b = member({
      key: "at:rec_b123456789",
      email: "b@example.com",
      helpVector: [0, 1],
      expertiseVector: [1, 0],
      helpWanted: ["FUNDRAISING"],
      expertise: ["FUNDRAISING"],
    });
    // dir A→B: cosine(helpA=[1,0], expB=[1,0]) = 1
    // dir B→A: cosine(helpB=[0,1], expA=[0,1]) = 1
    expect(scoreComponent("help_expertise", { helpExpertiseCategoryWeight: 0 }, a, b)).toBeCloseTo(1, 6);

    // categoryWeight 1 → categories only: A.help [FUNDRAISING] vs B.exp [FUNDRAISING] → 1; same other way → 1
    expect(scoreComponent("help_expertise", { helpExpertiseCategoryWeight: 1 }, a, b)).toBeCloseTo(1, 6);

    // Mixed: orthogonal text vectors with perfect categories at 0.5/0.5 → 0.5
    const orthogonal = member({
      key: "at:rec_c123456789",
      email: "c@example.com",
      helpVector: [1, 0],
      expertiseVector: [1, 0],
      helpWanted: ["FUNDRAISING"],
      expertise: ["FUNDRAISING"],
    });
    const result = scoreComponent(
      "help_expertise",
      { helpExpertiseCategoryWeight: 0.5 },
      orthogonal,
      b
    );
    // dir A→B: 0.5*1 + 0.5*cos([1,0],[1,0])=1 → 1
    // dir B→A: 0.5*1 + 0.5*cos([0,1],[1,0])=0 → 0.5
    expect(result).toBeCloseTo(0.75, 6);
  });
});

describe("goal relevance component", () => {
  it("scores cosine similarity of goal vectors and 0 when missing", () => {
    const a = member({ goalVector: [1, 0, 0] });
    const b = member({ key: "at:rec_b123456789", email: "b@example.com", goalVector: [1, 0, 0] });
    const missing = member({ key: "at:rec_c123456789", email: "c@example.com", goalVector: null });
    expect(scoreComponent("goal_relevance", {}, a, b)).toBe(1);
    expect(scoreComponent("goal_relevance", {}, a, missing)).toBe(0);
  });
});

describe("connection type component", () => {
  it("scores the mentor/guide pair as 1", () => {
    const mentor = member({ connectionTypes: ["I_CAN_MENTOR"] });
    const guide = member({
      key: "at:rec_b123456789",
      email: "b@example.com",
      connectionTypes: ["MORE_EXPERIENCED_GUIDE"],
    });
    expect(scoreComponent("connection_type", {}, mentor, guide)).toBe(1);
  });

  it("scores same-type peers as 1 and no-preference as 1", () => {
    const a = member({ connectionTypes: ["SIMILAR_STAGE_PEER"] });
    const b = member({
      key: "at:rec_b123456789",
      email: "b@example.com",
      connectionTypes: ["SIMILAR_STAGE_PEER"],
    });
    expect(scoreComponent("connection_type", {}, a, b)).toBe(1);

    const open = member({
      key: "at:rec_c123456789",
      email: "c@example.com",
      connectionTypes: ["NO_PREFERENCE"],
    });
    expect(scoreComponent("connection_type", {}, a, open)).toBe(1);
    expect(scoreComponent("connection_type", {}, member(), open)).toBe(1);
  });

  it("uses 0.5 for unknown codes and takes the best across multiple types", () => {
    const weird = member({ connectionTypes: ["SOMETHING_NEW"] });
    const b = member({
      key: "at:rec_b123456789",
      email: "b@example.com",
      connectionTypes: ["SIMILAR_STAGE_PEER"],
    });
    expect(scoreComponent("connection_type", {}, weird, b)).toBe(0.5);

    const multi = member({ connectionTypes: ["SOMETHING_NEW", "SIMILAR_STAGE_PEER"] });
    expect(scoreComponent("connection_type", {}, multi, b)).toBe(1);
  });
});

describe("industry component", () => {
  it("scores 1 for the same industry and 0 otherwise", () => {
    const a = member({ industry: "TECH_SAAS" });
    const same = member({ key: "at:rec_b123456789", email: "b@example.com", industry: "tech_saas" });
    const other = member({ key: "at:rec_c123456789", email: "c@example.com", industry: "FINANCE" });
    const unknown = member({ key: "at:rec_d123456789", email: "d@example.com", industry: null });
    expect(scoreComponent("industry", {}, a, same)).toBe(1);
    expect(scoreComponent("industry", {}, a, other)).toBe(0);
    expect(scoreComponent("industry", {}, a, unknown)).toBe(0);
  });
});

describe("business stage component", () => {
  it("scores 1 for the same stage and decays with distance", () => {
    const a = member({ businessStage: "EARLY_TRACTION" });
    const same = member({ key: "at:rec_b123456789", email: "b@example.com", businessStage: "early_traction" });
    const adjacent = member({ key: "at:rec_c123456789", email: "c@example.com", businessStage: "VALIDATING" });
    const far = member({ key: "at:rec_d123456789", email: "d@example.com", businessStage: "EXIT_TRANSITION" });
    const unknown = member({ key: "at:rec_e123456789", email: "e@example.com", businessStage: null });

    expect(scoreComponent("business_stage", {}, a, same)).toBe(1);
    expect(scoreComponent("business_stage", {}, a, adjacent)).toBeCloseTo(1 - 1 / 8, 6);
    expect(scoreComponent("business_stage", {}, a, far)).toBeLessThan(
      scoreComponent("business_stage", {}, a, adjacent)
    );
    expect(scoreComponent("business_stage", {}, a, unknown)).toBe(0);
  });
});

describe("scorePair", () => {
  it("combines enabled components with normalized weights", () => {
    const a = member();
    const b = member({
      key: "at:rec_b123456789",
      email: "b@example.com",
      lat: 51.5,
      lon: -0.12,
      profileVector: [1, 0, 0],
      goalVector: [1, 1, 0],
    });

    const result = scorePair(a, b, defaultWeights);
    expect(result.overall).toBeGreaterThan(0);
    expect(result.overall).toBeLessThanOrEqual(1);

    // breakdown contains exactly the enabled components
    const keys = Object.keys(result.components).sort();
    expect(keys).toEqual([...defaultWeights.enabled].sort());

    // manual recomputation from the breakdown
    let expected = 0;
    for (const [component, score] of Object.entries(result.components)) {
      expected += defaultWeights.components[component as keyof typeof defaultWeights.components] * (score ?? 0);
    }
    expect(result.overall).toBeCloseTo(expected, 5);
  });

  it("skips zero-weight components entirely", () => {
    const a = member();
    const b = member({ key: "at:rec_b123456789", email: "b@example.com" });

    const weights = normalizeWeights({ proximity: 100 });
    const result = scorePair(a, b, weights);
    expect(result.components.proximity).toBeDefined();
    expect(result.components.ai_correlation).toBeUndefined();
    expect(result.components.industry).toBeUndefined();
    expect(result.overall).toBeCloseTo(result.components.proximity ?? 0, 6);

    // A zero-weighted component must not change the overall score.
    const mixed = normalizeWeights({ proximity: 50, industry: 50 });
    const withZero = normalizeWeights({ proximity: 50, industry: 50, ai_correlation: 0 });
    expect(scorePair(a, b, mixed).overall).toBeCloseTo(scorePair(a, b, withZero).overall, 6);
  });

  it("weights proportionally regardless of raw totals", () => {
    const a = member();
    const b = member({ key: "at:rec_b123456789", email: "b@example.com" });
    const doubled = normalizeWeights({
      proximity: 60,
      industry: 60,
    });
    const base = normalizeWeights({ proximity: 30, industry: 30 });
    expect(scorePair(a, b, doubled).overall).toBeCloseTo(scorePair(a, b, base).overall, 6);
  });

  it("is deterministic for identical inputs", () => {
    const a = member();
    const b = member({ key: "at:rec_b123456789", email: "b@example.com" });
    const first = scorePair(a, b, defaultWeights);
    const second = scorePair(a, b, defaultWeights);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("produces the documented default-weight breakdown proportions", () => {
    const a = member();
    const b = member({
      key: "at:rec_b123456789",
      email: "b@example.com",
      lat: 51.5,
      lon: -0.12,
      profileVector: [1, 0, 0],
      goalVector: [1, 1, 0],
      industry: "TECH_SAAS",
      businessStage: "EARLY_TRACTION",
    });
    const result = scorePair(a, b, defaultWeights);
    expect(result.components.proximity).toBeGreaterThan(0.9);
    expect(result.components.industry).toBe(1);
    expect(result.components.business_stage).toBe(1);
    expect(result.components.connection_type).toBe(1);
  });
});

describe("scoreGroupMembers", () => {
  it("returns 0 for fewer than two members", () => {
    const single = scoreGroupMembers([member()], defaultWeights);
    expect(single).toEqual({ overall: 0, components: {} });
  });

  it("averages every intra-group pair score", () => {
    const a = member();
    const b = member({ key: "at:rec_b123456789", email: "b@example.com", lat: 51.5, lon: -0.12 });
    const c = member({ key: "at:rec_c123456789", email: "c@example.com", lat: 51.4, lon: -0.2 });

    const group = scoreGroupMembers([a, b, c], defaultWeights);
    const ab = scorePair(a, b, defaultWeights);
    const ac = scorePair(a, c, defaultWeights);
    const bc = scorePair(b, c, defaultWeights);

    expect(group.overall).toBeCloseTo((ab.overall + ac.overall + bc.overall) / 3, 5);
    expect(group.components.proximity).toBeDefined();
  });

  it("is symmetric to member ordering", () => {
    const a = member();
    const b = member({ key: "at:rec_b123456789", email: "b@example.com" });
    const c = member({ key: "at:rec_c123456789", email: "c@example.com" });
    expect(scoreGroupMembers([a, b, c], defaultWeights)).toEqual(
      scoreGroupMembers([c, a, b], defaultWeights)
    );
  });
});

describe("categoryOverlap", () => {
  it("measures coverage of the smaller set", () => {
    expect(categoryOverlap(["A", "B"], ["A", "B"])).toBe(1);
    expect(categoryOverlap(["A", "B"], ["A"])).toBe(1);
    expect(categoryOverlap(["A", "B"], ["A", "C"])).toBe(0.5);
    expect(categoryOverlap(["A"], ["B"])).toBe(0);
    expect(categoryOverlap([], ["A"])).toBe(0);
    expect(categoryOverlap(["A"], [])).toBe(0);
  });
});

describe("scoreComponent keys", () => {
  it("supports every configured component", () => {
    const a = member();
    const b = member({ key: "at:rec_b123456789", email: "b@example.com" });
    for (const component of SCORE_COMPONENTS) {
      const score = scoreComponent(component, {}, a, b);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});
