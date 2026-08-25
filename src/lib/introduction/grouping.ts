import { createHash } from "node:crypto";
import type {
  PairScoreBreakdown,
} from "./scoring";
import type { ScoreComponent } from "./profiles";
import type { EffectiveGroupSizes } from "./settings";

/**
 * Deterministic city-level grouping for the unified introduction engine.
 *
 * The optimizer consumes a precomputed pair matrix (hard constraints are
 * applied by the caller: ineligible pairs are marked `allowed: false`), then
 * runs several seeded greedy assignments and keeps the one with the best
 * overall city quality. Identical inputs (members, matrix, sizes, seed)
 * always produce identical groups.
 */

export function hashSeed(value: string): number {
  return createHash("sha256").update(value).digest().readUInt32BE(0);
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: T[], rng: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export interface PairScoreEntry {
  score: PairScoreBreakdown;
  allowed: boolean;
  /** Set when the pair is blocked by a hard constraint. */
  blockedReason?: string | null;
}

export interface PairMatrixReader {
  get(keyA: string, keyB: string): PairScoreEntry | null;
}

export class PairScoreMatrix implements PairMatrixReader {
  private map = new Map<string, PairScoreEntry>();

  static keyFor(a: string, b: string): string {
    return [a, b].sort().join("<");
  }

  set(keyA: string, keyB: string, entry: PairScoreEntry): void {
    this.map.set(PairScoreMatrix.keyFor(keyA, keyB), entry);
  }

  get(keyA: string, keyB: string): PairScoreEntry | null {
    return this.map.get(PairScoreMatrix.keyFor(keyA, keyB)) ?? null;
  }

  get size(): number {
    return this.map.size;
  }

  entries(): Array<{ keyA: string; keyB: string; entry: PairScoreEntry }> {
    const result: Array<{ keyA: string; keyB: string; entry: PairScoreEntry }> = [];
    for (const [pairKey, entry] of this.map) {
      const [keyA, keyB] = pairKey.split("<");
      result.push({ keyA, keyB, entry });
    }
    return result;
  }
}

export interface GroupingOptions {
  sizes: EffectiveGroupSizes;
  /** Deterministic seed string (e.g. cycleId + profileVersionId + cityCode). */
  seed: string;
  /** Number of seeded attempts; the best assignment wins. */
  maxAttempts?: number;
}

export interface UnmatchedMember {
  key: string;
  /** "no_allowed_pairs" (hard constraints) or "size_impossible" (leftover below min). */
  reason: "no_allowed_pairs" | "size_impossible";
}

export interface GroupingResult {
  groups: Array<Array<{ key: string }>>;
  unmatched: UnmatchedMember[];
  /** Mean of the group pair-average scores across groups. */
  quality: number;
  groupScores: PairScoreBreakdown[];
}

interface Assignment {
  groups: Array<Array<{ key: string }>>;
  unmatched: UnmatchedMember[];
  quality: number;
  groupScores: PairScoreBreakdown[];
}

function groupScoreFromMatrix(
  group: Array<{ key: string }>,
  matrix: PairMatrixReader
): PairScoreBreakdown {
  if (group.length < 2) {
    return { overall: 0, components: {} };
  }
  const totals: Partial<Record<ScoreComponent, number>> = {};
  let pairCount = 0;
  let overallSum = 0;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const entry = matrix.get(group[i].key, group[j].key);
      if (!entry) continue;
      pairCount += 1;
      overallSum += entry.score.overall;
      for (const [component, value] of Object.entries(entry.score.components)) {
        const key = component as ScoreComponent;
        totals[key] = (totals[key] ?? 0) + (value ?? 0);
      }
    }
  }
  if (pairCount === 0) return { overall: 0, components: {} };
  const components: Partial<Record<ScoreComponent, number>> = {};
  for (const [component, sum] of Object.entries(totals)) {
    const value = (sum ?? 0) / pairCount;
    components[component as ScoreComponent] = Math.round(value * 1_000_000) / 1_000_000;
  }
  return {
    overall: Math.round((overallSum / pairCount) * 1_000_000) / 1_000_000,
    components,
  };
}

function bestCandidate(
  group: Array<{ key: string }>,
  pool: Array<{ key: string }>,
  matrix: PairMatrixReader
): { member: { key: string }; avg: number } | null {
  let best: { member: { key: string }; avg: number } | null = null;
  for (const candidate of pool) {
    let sum = 0;
    let count = 0;
    let allAllowed = true;
    for (const member of group) {
      const entry = matrix.get(member.key, candidate.key);
      if (!entry || !entry.allowed) {
        allAllowed = false;
        break;
      }
      sum += entry.score.overall;
      count += 1;
    }
    if (!allAllowed || count === 0) continue;
    const avg = sum / count;
    if (!best || avg > best.avg) {
      best = { member: candidate, avg };
    }
  }
  return best;
}

function attemptAssignment(
  order: Array<{ key: string }>,
  matrix: PairMatrixReader,
  sizes: EffectiveGroupSizes
): Assignment {
  const { target, min, max, strict } = sizes;
  const used = new Set<string>();
  const groups: Array<Array<{ key: string }>> = [];
  /** Seeds that could not anchor a complete group — never retried as seeds. */
  const blockedSeeds = new Set<string>();

  const pool = () => order.filter((m) => !used.has(m.key));
  const pickSeed = () => pool().find((m) => !blockedSeeds.has(m.key));

  while (true) {
    const candidates = pool();
    if (candidates.length < min) break;
    const seed = pickSeed();
    if (!seed) break;

    used.add(seed.key);
    const group = [seed];

    while (group.length < target) {
      const next = bestCandidate(group, pool(), matrix);
      if (!next) break;
      group.push(next.member);
      used.add(next.member.key);
    }

    if (group.length >= min && (!strict || group.length === target)) {
      groups.push(group);
      continue;
    }

    // The seed could not anchor a min-sized group (or an exact-size group
    // in strict mode): release everyone and keep going with the remaining
    // candidates instead of abandoning the whole assignment.
    for (const member of group) used.delete(member.key);
    blockedSeeds.add(seed.key);
  }

  // Balancing pass (non-strict): place leftovers into groups below max.
  if (!strict) {
    const leftovers = pool();
    for (const member of leftovers) {
      let bestGroup: Array<{ key: string }> | null = null;
      let bestGain = -Infinity;
      for (const group of groups) {
        if (group.length >= max) continue;
        const next = bestCandidate(group, [member], matrix);
        if (!next) continue;
        if (next.avg > bestGain) {
          bestGain = next.avg;
          bestGroup = group;
        }
      }
      if (bestGroup) {
        bestGroup.push(member);
        used.add(member.key);
      }
    }
  }

  const groupsFinal = groups.filter((g) => g.length >= min);
  const groupScores = groupsFinal.map((g) => groupScoreFromMatrix(g, matrix));
  const quality =
    groupScores.length > 0
      ? groupScores.reduce((acc, s) => acc + s.overall, 0) / groupScores.length
      : 0;

  return {
    groups: groupsFinal,
    unmatched: unmatchedMembers(order, used, matrix),
    quality,
    groupScores,
  };
}

/** Classify every unassigned member: hard-constraint blocked vs size leftover. */
function unmatchedMembers(
  all: Array<{ key: string }>,
  used: Set<string>,
  matrix: PairMatrixReader
): UnmatchedMember[] {
  const leftovers = all.filter((m) => !used.has(m.key));
  const result: UnmatchedMember[] = [];
  for (const member of leftovers) {
    let hasAllowedPair = false;
    for (const other of all) {
      if (other.key === member.key) continue;
      const entry = matrix.get(member.key, other.key);
      if (entry && entry.allowed) {
        hasAllowedPair = true;
        break;
      }
    }
    result.push({
      key: member.key,
      reason: hasAllowedPair ? "size_impossible" : "no_allowed_pairs",
    });
  }
  return result;
}

function betterAssignment(a: Assignment, b: Assignment): Assignment {
  if (b.quality > a.quality) return b;
  if (b.quality < a.quality) return a;
  if (b.unmatched.length < a.unmatched.length) return b;
  if (b.unmatched.length > a.unmatched.length) return a;
  const aSignature = JSON.stringify(a.groups.map((g) => g.map((m) => m.key).sort()));
  const bSignature = JSON.stringify(b.groups.map((g) => g.map((m) => m.key).sort()));
  return bSignature < aSignature ? b : a;
}

export function buildGroups(
  members: Array<{ key: string }>,
  matrix: PairMatrixReader,
  options: GroupingOptions
): GroupingResult {
  const sizes = options.sizes;
  const maxAttempts = options.maxAttempts ?? 10;

  if (members.length === 0) {
    return { groups: [], unmatched: [], quality: 0, groupScores: [] };
  }

  const baseOrder = [...members].sort((a, b) => a.key.localeCompare(b.key));
  let best: Assignment | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rng = mulberry32(hashSeed(`${options.seed}:${attempt}`));
    const order = seededShuffle(baseOrder, rng);
    const assignment = attemptAssignment(order, matrix, sizes);
    best = best ? betterAssignment(best, assignment) : assignment;
  }

  const result = best ?? attemptAssignment(baseOrder, matrix, sizes);
  return {
    groups: result.groups,
    unmatched: result.unmatched,
    quality: result.quality,
    groupScores: result.groupScores,
  };
}

/**
 * Rebuild a city plan from a stored pair matrix while preserving locked
 * groups: pool members of locked groups are fixed and excluded from the
 * rebuild. Deterministic for the same matrix + seed.
 */
export function rebuildGroupsWithLocks(
  poolMembers: Array<{ key: string }>,
  matrix: PairMatrixReader,
  options: GroupingOptions,
  lockedGroups: Array<Array<{ key: string }>>
): GroupingResult {
  const lockedKeys = new Set(lockedGroups.flatMap((g) => g.map((m) => m.key)));
  const free = poolMembers.filter((m) => !lockedKeys.has(m.key));
  const rebuilt = buildGroups(free, matrix, options);
  return {
    groups: [...lockedGroups, ...rebuilt.groups],
    unmatched: rebuilt.unmatched,
    quality: rebuilt.quality,
    groupScores: rebuilt.groupScores,
  };
}
