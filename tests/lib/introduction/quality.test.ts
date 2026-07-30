import { describe, it, expect } from "vitest";
import { scoreGroup, type ScorableMember } from "@/lib/introduction/quality";

function makeMember(overrides: Partial<ScorableMember> = {}): ScorableMember {
  return {
    email: "test@example.com",
    name: "Test",
    lastIntroductionDate: null,
    introductionCount: 0,
    previouslyUnmatched: false,
    availability: "",
    topics: "",
    industry: "",
    revenue: "",
    ...overrides,
  };
}

describe("scoreGroup", () => {
  it("scores a group of 2 members", () => {
    const score = scoreGroup([makeMember({ email: "a@t.com" }), makeMember({ email: "b@t.com" })]);
    expect(score).toBeGreaterThan(0);
  });

  it("returns 0 for fewer than 2 members", () => {
    expect(scoreGroup([])).toBe(0);
    expect(scoreGroup([makeMember()])).toBe(0);
  });

  it("prefers members with no previous introductions", () => {
    const experienced = scoreGroup([
      makeMember({ email: "a@t.com", introductionCount: 10, lastIntroductionDate: new Date("2026-07-01") }),
      makeMember({ email: "b@t.com", introductionCount: 8, lastIntroductionDate: new Date("2026-07-05") }),
    ]);
    const fresh = scoreGroup([
      makeMember({ email: "a@t.com", introductionCount: 0, lastIntroductionDate: null }),
      makeMember({ email: "b@t.com", introductionCount: 0, lastIntroductionDate: null }),
    ]);
    expect(fresh).toBeGreaterThan(experienced);
  });

  it("prefers previously unmatched members", () => {
    const unmatched = scoreGroup([
      makeMember({ email: "a@t.com", previouslyUnmatched: true }),
      makeMember({ email: "b@t.com", previouslyUnmatched: true }),
    ]);
    const matched = scoreGroup([
      makeMember({ email: "a@t.com", previouslyUnmatched: false }),
      makeMember({ email: "b@t.com", previouslyUnmatched: false }),
    ]);
    expect(unmatched).toBeGreaterThan(matched);
  });

  it("rewards availability overlap", () => {
    const overlapping = scoreGroup([
      makeMember({ email: "a@t.com", availability: "mornings, weekends" }),
      makeMember({ email: "b@t.com", availability: "mornings, afternoons" }),
    ]);
    const disjointed = scoreGroup([
      makeMember({ email: "a@t.com", availability: "mornings" }),
      makeMember({ email: "b@t.com", availability: "evenings" }),
    ]);
    expect(overlapping).toBeGreaterThan(disjointed);
  });

  it("rewards industry diversity", () => {
    const diverse = scoreGroup([
      makeMember({ email: "a@t.com", industry: "SaaS" }),
      makeMember({ email: "b@t.com", industry: "Consumer" }),
    ]);
    const same = scoreGroup([
      makeMember({ email: "a@t.com", industry: "SaaS" }),
      makeMember({ email: "b@t.com", industry: "SaaS" }),
    ]);
    expect(diverse).toBeGreaterThan(same);
  });

  it("deterministic for same inputs", () => {
    const a = scoreGroup([
      makeMember({ email: "a@t.com", introductionCount: 2 }),
      makeMember({ email: "b@t.com", introductionCount: 3 }),
    ]);
    const b = scoreGroup([
      makeMember({ email: "a@t.com", introductionCount: 2 }),
      makeMember({ email: "b@t.com", introductionCount: 3 }),
    ]);
    expect(a).toBe(b);
  });
});
