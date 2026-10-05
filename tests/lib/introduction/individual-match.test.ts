import { describe, it, expect } from "vitest";
import { PairScoreMatrix } from "@/lib/introduction/grouping";
import {
  combineBreakdowns,
  selectBestPartners,
} from "@/lib/introduction/individual-match";
import type { PlanMember } from "@/lib/introduction/plan";
import type { PairScoreBreakdown } from "@/lib/introduction/scoring";

function m(key: string): PlanMember {
  return { key } as PlanMember;
}

function sc(overall: number, components: Record<string, number> = {}): PairScoreBreakdown {
  return { overall, components };
}

describe("selectBestPartners", () => {
  it("picks the pair that maximizes the group score", () => {
    const target = m("t");
    const p1 = m("p1");
    const p2 = m("p2");
    const p3 = m("p3");
    const matrix = new PairScoreMatrix();
    matrix.set("t", "p1", { score: sc(0.8), allowed: true });
    matrix.set("t", "p2", { score: sc(0.9), allowed: true });
    matrix.set("t", "p3", { score: sc(0.5), allowed: true });
    matrix.set("p1", "p2", { score: sc(0.7), allowed: true });
    matrix.set("p1", "p3", { score: sc(0.2), allowed: true });
    matrix.set("p2", "p3", { score: sc(0.9), allowed: true });

    const result = selectBestPartners(target, [p1, p2, p3], matrix);
    expect(result?.partners.map((p) => p.key).sort()).toEqual(["p1", "p2"]);
    expect(result?.groupScore).toBeCloseTo(0.8, 5);
  });

  it("skips a pair when any of the three intra-group pairs is disallowed", () => {
    const target = m("t");
    const p1 = m("p1");
    const p2 = m("p2");
    const matrix = new PairScoreMatrix();
    matrix.set("t", "p1", { score: sc(1), allowed: true });
    matrix.set("t", "p2", { score: sc(1), allowed: true });
    matrix.set("p1", "p2", {
      score: sc(1),
      allowed: false,
      blockedReason: "recent_pair_repeat",
    });
    expect(selectBestPartners(target, [p1, p2], matrix)).toBeNull();
  });

  it("returns null when there are fewer than two partners", () => {
    const target = m("t");
    const matrix = new PairScoreMatrix();
    matrix.set("t", "p1", { score: sc(1), allowed: true });
    expect(selectBestPartners(target, [m("p1")], matrix)).toBeNull();
  });

  it("returns null when no pair is fully allowed", () => {
    const target = m("t");
    const matrix = new PairScoreMatrix();
    matrix.set("t", "p1", { score: sc(1), allowed: false });
    matrix.set("t", "p2", { score: sc(1), allowed: false });
    matrix.set("p1", "p2", { score: sc(1), allowed: false });
    expect(selectBestPartners(target, [m("p1"), m("p2")], matrix)).toBeNull();
  });
});

describe("combineBreakdowns", () => {
  it("averages components across the pair breakdowns", () => {
    const combined = combineBreakdowns([
      { overall: 1, components: { proximity: 0.5, industry: 1 } },
      { overall: 1, components: { proximity: 0.9 } },
    ]);
    expect(combined.proximity).toBeCloseTo(0.7, 5);
    expect(combined.industry).toBeCloseTo(0.5, 5);
  });

  it("returns an empty object for no breakdowns", () => {
    expect(combineBreakdowns([])).toEqual({});
  });
});
