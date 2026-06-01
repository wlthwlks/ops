import {
  TRACTION_TO_STAGE,
  PERSONAL_EMAIL_DOMAINS,
} from "./constants";

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
 *   Location proximity  50% — repeated/emphasized, uses only close-proximity areas
 *   ARR / business stage 30% — repeated for weight
 *   Industry relevance  20% — industry
 *
 * Repetition in the embedding input amplifies that dimension's influence
 * on the resulting vector, approximating the desired weighting.
 */
export function buildEmbeddingText(member: {
  nearbyLocation: string;
  businessStage: string;
  industry: string;
}): string {
  const sections: string[] = [];

  // Location 50% — strongest signal, use only close-proximity half, repeated
  if (member.nearbyLocation) {
    const closeLoc = closeProximityLocations(member.nearbyLocation);
    sections.push(`Located near: ${closeLoc}.`);
    sections.push(`Nearby areas: ${closeLoc}.`);
    sections.push(`Close to: ${closeLoc}.`);
  }

  // ARR / business stage 30% — repeated for weight
  sections.push(`Business stage: ${member.businessStage}.`);
  sections.push(`Revenue stage: ${member.businessStage}.`);

  // Industry 20%
  const industry = member.industry || "business";
  sections.push(`Industry: ${industry.toLowerCase()}.`);
  sections.push(`Sector: ${industry.toLowerCase()}.`);

  return sections.join(" ");
}
