/**
 * Recurring group quality scoring.
 *
 * Hard constraints (applied before scoring):
 *   - Eligible (service access, first intro status, not paused/excluded)
 *   - Correct city/channel
 *   - Has Slack user ID
 *   - Not reserved
 *   - Outside member cooldown
 *   - No pair inside pair cooldown (unless overridden)
 *   - Group size between 2 and 8
 *
 * Priority order for tie-breaking within a pool:
 *   1. Longest time since last successful introduction
 *   2. Fewest successful introductions
 *   3. Previously unmatched members
 *   4. Availability overlap (normalized keyword sets)
 *   5. Topic overlap (normalized keyword sets)
 *   6. Industry and revenue-stage diversity (encouraged but not enforced)
 *   7. Seeded deterministic tie-breaking
 */

export interface ScorableMember {
  email: string;
  name: string;
  lastIntroductionDate: Date | null;
  introductionCount: number;
  previouslyUnmatched: boolean;
  availability: string;
  topics: string;
  industry: string;
  revenue: string;
}

function normalizeTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
}

function tokenizeSet(text: string): string[] {
  return Array.from(normalizeTokens(text));
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  return intersection / Math.min(a.size, b.size);
}

function diversityScore(values: Set<string>): number {
  return Math.min(1, (values.size - 1) / 4); // 0 → 1 as diversity increases
}

/**
 * Score a proposed group. Higher is better.
 */
export function scoreGroup(members: ScorableMember[]): number {
  if (members.length < 2) return 0;

  let score = 0;

  // Factor 1: average days since last introduction (more = better)
  const now = Date.now();
  let totalWaitDays = 0;
  let membersWithHistory = 0;
  for (const m of members) {
    if (m.lastIntroductionDate) {
      totalWaitDays += (now - m.lastIntroductionDate.getTime()) / (1000 * 60 * 60 * 24);
      membersWithHistory++;
    } else {
      // No history → treat as max wait (prefer these)
      totalWaitDays += 365;
      membersWithHistory++;
    }
  }
  score += (totalWaitDays / membersWithHistory) * 0.3 / 30; // normalize around monthly

  // Factor 2: lower average introduction count (fewer = better)
  const avgCount = members.reduce((s, m) => s + m.introductionCount, 0) / members.length;
  score += Math.max(0, 5 - avgCount) * 0.2;

  // Factor 3: prefer previously unmatched
  const unmatchedCount = members.filter((m) => m.previouslyUnmatched).length;
  score += (unmatchedCount / members.length) * 0.2;

  // Factor 4: availability overlap
  const availabilitySets = members.map((m) => normalizeTokens(m.availability || ""));
  let availOverlap = 0;
  let availPairs = 0;
  for (let i = 0; i < availabilitySets.length; i++) {
    for (let j = i + 1; j < availabilitySets.length; j++) {
      availOverlap += jaccardOverlap(availabilitySets[i], availabilitySets[j]);
      availPairs++;
    }
  }
  score += (availPairs > 0 ? availOverlap / availPairs : 0) * 0.1;

  // Factor 5: topic overlap
  const topicSets = members.map((m) => normalizeTokens(m.topics || ""));
  let topicOverlap = 0;
  let topicPairs = 0;
  for (let i = 0; i < topicSets.length; i++) {
    for (let j = i + 1; j < topicSets.length; j++) {
      topicOverlap += jaccardOverlap(topicSets[i], topicSets[j]);
      topicPairs++;
    }
  }
  score += (topicPairs > 0 ? topicOverlap / topicPairs : 0) * 0.1;

  // Factor 6: industry diversity
  const industries = new Set(members.map((m) => m.industry).filter(Boolean));
  score += diversityScore(industries) * 0.05;

  // Factor 7: revenue-stage diversity
  const revenues = new Set(members.map((m) => m.revenue).filter(Boolean));
  score += diversityScore(revenues) * 0.05;

  return score;
}
