import {
  TRACTION_TO_STAGE,
  PRIORITY_TOPICS,
  PERSONAL_EMAIL_DOMAINS,
  WEEKDAYS,
} from "./constants";

/**
 * Simple djb2 hash — deterministic, fast, good distribution.
 */
function djb2(str: string, seed: number = 0): number {
  let hash = 5381 + seed;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Map Airtable traction string to a business stage label.
 * Normalises hyphens and en-dashes before lookup.
 */
export function toBusinessStage(traction: unknown): string {
  if (typeof traction !== "string" || !traction.trim()) return "Pre-Revenue";

  const normalized = traction.trim().replace(/\u2013/g, "-");
  return TRACTION_TO_STAGE.get(normalized) ?? "Pre-Revenue";
}

/**
 * Returns true if the email uses a business domain (not gmail, hotmail, etc.).
 */
export function hasBusinessDomain(email: unknown): boolean {
  if (typeof email !== "string") return false;
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain) return false;
  return !PERSONAL_EMAIL_DOMAINS.has(domain);
}

/**
 * Deterministically assign a priority topic based on member's Airtable record ID.
 * Same ID always produces the same topic.
 */
export function assignPriorityTopic(memberId: string): string {
  const hash = djb2(memberId, 0);
  return PRIORITY_TOPICS[hash % PRIORITY_TOPICS.length];
}

/**
 * Deterministically generate 3-4 weekday names based on member ID.
 * Uses a different seed offset so it doesn't correlate with topic assignment.
 */
export function generateAvailability(memberId: string): string {
  const hash = djb2(memberId, 42);
  const count = (hash % 2) + 3; // 3 or 4 days

  // Seeded Fisher-Yates shuffle of indices
  const indices = [0, 1, 2, 3, 4];
  let seed = hash;
  for (let i = indices.length - 1; i > 0; i--) {
    seed = ((seed * 1103515245) + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  return indices
    .slice(0, count)
    .sort((a, b) => a - b)
    .map((i) => WEEKDAYS[i])
    .join(", ");
}

/**
 * Extract the close-proximity half of a tiered location string.
 * The nearby string uses " | " to separate tiers (5km | 10km | 25km).
 * We take the first half of all area names for the embedding so the
 * vector emphasizes close proximity over distant areas.
 */
function closeProximityLocations(nearbyLocation: string): string {
  // Flatten all tiers into a single list, preserving tier order (closest first)
  const allNames = nearbyLocation
    .split(/\s*\|\s*/)
    .flatMap((tier) => tier.split(/\s*,\s*/))
    .filter((n) => n.length > 0);

  // Take the first half (closest areas)
  const halfCount = Math.max(1, Math.ceil(allNames.length / 2));
  return allNames.slice(0, halfCount).join(", ");
}

/**
 * Build the natural-language text used for embedding.
 * Weighted by importance:
 *   Location proximity  35% — repeated/emphasized, uses only close-proximity areas
 *   Availability overlap 25% — repeated for weight
 *   ARR / business stage 20% — repeated for weight
 *   Topic relevance     10% — priority topic
 *   Industry relevance  10% — industry
 *
 * Repetition in the embedding input amplifies that dimension's influence
 * on the resulting vector, approximating the desired weighting.
 */
export function buildEmbeddingText(member: {
  nearbyLocation: string;
  availability: string;
  businessStage: string;
  priorityTopic: string;
  industry: string;
}): string {
  const sections: string[] = [];

  // Location 40% — strongest signal, use only close-proximity half, repeated
  if (member.nearbyLocation) {
    const closeLoc = closeProximityLocations(member.nearbyLocation);
    sections.push(`Located near: ${closeLoc}.`);
    sections.push(`Nearby areas: ${closeLoc}.`);
  }

  // Availability 30% — include twice
  if (member.availability) {
    sections.push(`Available on ${member.availability}.`);
    sections.push(`Free days: ${member.availability}.`);
  }

  // ARR / business stage 20% — repeated for weight
  sections.push(`Business stage: ${member.businessStage}.`);
  sections.push(`Revenue stage: ${member.businessStage}.`);

  // Topic 10%
  sections.push(`Focused on ${member.priorityTopic.toLowerCase()}.`);

  // Industry 10%
  const industry = member.industry || "business";
  sections.push(`Industry: ${industry.toLowerCase()}.`);
  sections.push(`Sector: ${industry.toLowerCase()}.`);

  return sections.join(" ");
}
