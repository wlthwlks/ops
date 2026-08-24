import { describe, it, expect } from "vitest";
import {
  PairScoreMatrix,
  buildGroups,
  rebuildGroupsWithLocks,
  hashSeed,
  mulberry32,
  seededShuffle,
  type GroupingOptions,
} from "@/lib/introduction/grouping";
import type { EffectiveGroupSizes } from "@/lib/introduction/settings";

const sizes: EffectiveGroupSizes = { target: 3, min: 2, max: 6, strict: false };

function members(n: number): Array<{ key: string }> {
  return Array.from({ length: n }, (_, i) => ({ key: `m${i}` }));
}

function options(overrides: Partial<GroupingOptions> = {}): GroupingOptions {
  return { sizes, seed: "test-seed", ...overrides };
}

/** Matrix where every pair is allowed and scores the same value. */
function uniformMatrix(n: number, score = 0.5): PairScoreMatrix {
  const matrix = new PairScoreMatrix();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      matrix.set(`m${i}`, `m${j}`, {
        score: { overall: score, components: {} },
        allowed: true,
      });
    }
  }
  return matrix;
}

/** Matrix with high scores inside clusters and low scores across clusters. */
function clusterMatrix(clusters: string[][], inner = 0.9, cross = 0.1): PairScoreMatrix {
  const matrix = new PairScoreMatrix();
  const all = clusters.flat();
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const same = clusters.some(
        (cluster) => cluster.includes(all[i]) && cluster.includes(all[j])
      );
      matrix.set(all[i], all[j], {
        score: { overall: same ? inner : cross, components: {} },
        allowed: true,
      });
    }
  }
  return matrix;
}

describe("rng helpers", () => {
  it("hashSeed is stable", () => {
    expect(hashSeed("abc")).toBe(hashSeed("abc"));
    expect(hashSeed("abc")).not.toBe(hashSeed("abd"));
  });

  it("mulberry32 is deterministic for a seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it("seededShuffle is a permutation", () => {
    const items = ["a", "b", "c", "d", "e"];
    const shuffled = seededShuffle(items, mulberry32(7));
    expect([...shuffled].sort()).toEqual([...items].sort());
    expect(seededShuffle(items, mulberry32(7))).toEqual(shuffled);
  });
});

describe("buildGroups", () => {
  it("returns empty for no members", () => {
    expect(buildGroups([], uniformMatrix(0), options())).toEqual({
      groups: [],
      unmatched: [],
      quality: 0,
      groupScores: [],
    });
  });

  it("leaves members unmatched when below the minimum size", () => {
    const result = buildGroups(members(1), uniformMatrix(1), options());
    expect(result.groups).toHaveLength(0);
    expect(result.unmatched.map((m) => m.key)).toEqual(["m0"]);
  });

  it("groups members into target-sized groups and uses every member once", () => {
    const result = buildGroups(members(9), uniformMatrix(9), options());
    const flat = [...result.groups.flat().map((m) => m.key), ...result.unmatched.map((m) => m.key)];
    expect(flat.sort()).toEqual(members(9).map((m) => m.key).sort());
    expect(new Set(flat).size).toBe(9);
    for (const group of result.groups) {
      expect(group.length).toBeGreaterThanOrEqual(2);
      expect(group.length).toBeLessThanOrEqual(6);
    }
    expect(result.unmatched).toHaveLength(0);
  });

  it("is deterministic for the same seed and matrix", () => {
    const a = buildGroups(members(10), uniformMatrix(10), options({ seed: "seed-1" }));
    const b = buildGroups(members(10), uniformMatrix(10), options({ seed: "seed-1" }));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("keeps strict groups at exactly the target size with leftovers unmatched", () => {
    const strict: EffectiveGroupSizes = { target: 3, min: 2, max: 6, strict: true };
    const result = buildGroups(members(8), uniformMatrix(8), options({ sizes: strict }));
    for (const group of result.groups) expect(group.length).toBe(3);
    expect(result.groups).toHaveLength(2);
    expect(result.unmatched).toHaveLength(2);
  });

  it("never groups blocked pairs together", () => {
    const matrix = uniformMatrix(6);
    matrix.set("m0", "m1", { score: { overall: 0, components: {} }, allowed: false, blockedReason: "recent_pair_repeat" });
    matrix.set("m0", "m2", { score: { overall: 0, components: {} }, allowed: false, blockedReason: "recent_pair_repeat" });

    const result = buildGroups(members(6), matrix, options());
    for (const group of result.groups) {
      const keys = group.map((m) => m.key);
      if (keys.includes("m0")) {
        expect(keys).not.toContain("m1");
        expect(keys).not.toContain("m2");
      }
    }
  });

  it("clusters members with high intra-cluster scores", () => {
    const matrix = clusterMatrix([
      ["a1", "a2", "a3"],
      ["b1", "b2", "b3"],
    ]);
    const membersList = [
      { key: "a1" }, { key: "a2" }, { key: "a3" },
      { key: "b1" }, { key: "b2" }, { key: "b3" },
    ];
    const result = buildGroups(membersList, matrix, options({ seed: "clusters" }));
    expect(result.groups).toHaveLength(2);
    const sortedGroups = result.groups
      .map((g) => g.map((m) => m.key).sort().join(","))
      .sort();
    expect(sortedGroups).toEqual(["a1,a2,a3", "b1,b2,b3"]);
    expect(result.unmatched).toHaveLength(0);
  });

  it("reports per-group score breakdowns and quality", () => {
    const matrix = clusterMatrix([
      ["a1", "a2", "a3"],
      ["b1", "b2", "b3"],
    ]);
    const result = buildGroups(
      [{ key: "a1" }, { key: "a2" }, { key: "a3" }, { key: "b1" }, { key: "b2" }, { key: "b3" }],
      matrix,
      options()
    );
    expect(result.groupScores).toHaveLength(2);
    for (const score of result.groupScores) expect(score.overall).toBeCloseTo(0.9, 6);
    expect(result.quality).toBeCloseTo(0.9, 6);
  });

  it("balancing pass places leftovers into groups below max", () => {
    // 7 members, target 3, max 6 → one group of 4 (or 3+3+1→unmatched).
    const result = buildGroups(members(7), uniformMatrix(7), options());
    const sizesUsed = result.groups.map((g) => g.length);
    const totalPlaced = sizesUsed.reduce((a, b) => a + b, 0);
    expect(totalPlaced + result.unmatched.length).toBe(7);
    for (const size of sizesUsed) {
      expect(size).toBeGreaterThanOrEqual(2);
      expect(size).toBeLessThanOrEqual(6);
    }
  });

  it("respects max group size", () => {
    const sizesMax3: EffectiveGroupSizes = { target: 3, min: 2, max: 3, strict: false };
    const result = buildGroups(members(9), uniformMatrix(9), options({ sizes: sizesMax3 }));
    for (const group of result.groups) expect(group.length).toBeLessThanOrEqual(3);
  });
});

describe("rebuildGroupsWithLocks", () => {
  it("preserves locked groups and excludes their members from the rebuild", () => {
    const pool = members(6);
    const matrix = uniformMatrix(6);
    const locked = [[{ key: "m0" }, { key: "m1" }, { key: "m2" }]];

    const result = rebuildGroupsWithLocks(pool, matrix, options(), locked);

    const lockedGroup = result.groups.find(
      (g) => g.map((m) => m.key).sort().join(",") === "m0,m1,m2"
    );
    expect(lockedGroup).toBeDefined();

    const flat = result.groups.flat().map((m) => m.key);
    expect(new Set(flat).size).toBe(flat.length);
    for (const key of ["m0", "m1", "m2"]) {
      expect(flat.filter((k) => k === key)).toHaveLength(1);
    }
    // Free members m3..m5 regroup among themselves (one group of 3 or leftovers).
    const freePlaced = result.groups
      .flat()
      .filter((m) => ["m3", "m4", "m5"].includes(m.key)).length;
    expect(freePlaced).toBe(3);
  });
});

describe("buildGroups — everyone matched (target 3 / min 2 / max 4)", () => {
  const sizes34: EffectiveGroupSizes = { target: 3, min: 2, max: 4, strict: false };

  function opts34(overrides: Partial<GroupingOptions> = {}): GroupingOptions {
    return { sizes: sizes34, seed: "test-seed-34", ...overrides };
  }

  it("fills groups to the target and never overfills beyond it", () => {
    const matrix = uniformMatrix(8, 0.5);
    const result = buildGroups(members(8), matrix, opts34());
    const sizes = result.groups.map((g) => g.length).sort((a, b) => a - b);
    expect(sizes).toEqual([2, 3, 3]);
    expect(result.unmatched).toEqual([]);
  });

  it("absorbs a single leftover into the last group (7 -> 3+4)", () => {
    const result = buildGroups(members(7), uniformMatrix(7), opts34());
    const sizes = result.groups.map((g) => g.length).sort((a, b) => a - b);
    expect(sizes).toEqual([3, 4]);
    expect(result.unmatched).toEqual([]);
  });

  it("forms a smaller min-size group for two leftovers (5 -> 3+2)", () => {
    const result = buildGroups(members(5), uniformMatrix(5), opts34());
    const sizes = result.groups.map((g) => g.length).sort((a, b) => a - b);
    expect(sizes).toEqual([2, 3]);
    expect(result.unmatched).toEqual([]);
  });

  it("matches pairs and singletons sensibly", () => {
    expect(buildGroups(members(4), uniformMatrix(4), opts34()).groups).toHaveLength(1);
    expect(buildGroups(members(2), uniformMatrix(2), opts34()).groups.map((g) => g.length)).toEqual([2]);
    const one = buildGroups(members(1), uniformMatrix(1), opts34());
    expect(one.groups).toEqual([]);
    expect(one.unmatched).toHaveLength(1);
    expect(one.unmatched[0].reason).toBe("no_allowed_pairs");
  });

  it("leaves hard-constraint-blocked members unmatched with a reason", () => {
    const matrix = uniformMatrix(6);
    // m5 has no allowed pair with anyone.
    for (let i = 0; i < 5; i++) {
      const entry = matrix.get(`m${i}`, "m5");
      if (entry) entry.allowed = false;
    }
    const result = buildGroups(members(6), matrix, opts34());
    expect(result.groups.flat().map((m) => m.key)).not.toContain("m5");
    const blocked = result.unmatched.find((u) => u.key === "m5");
    expect(blocked?.reason).toBe("no_allowed_pairs");
  });
});
