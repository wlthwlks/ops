import { createHash } from "node:crypto";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import type { AirtableRecord } from "@/lib/integrations/airtable";

/**
 * Semantic profile representation for the unified introduction engine.
 *
 * The text embedded into Pinecone covers ONLY the semantic profile fields
 * (headline, bio, business description, 90-day goal, help wanted/expertise
 * and connection type). Location, industry, business stage, availability and
 * topics are deliberately excluded — those dimensions are scored
 * independently and configurably, and must not be hidden inside the vector.
 *
 * Each member produces up to four vectors in the semantic namespace:
 *   {recordId}:profile   — overall semantic profile (AI correlation); always
 *                          present (name-based fallback for empty profiles)
 *   {recordId}:help      — help-wanted text (complementarity A→B)
 *   {recordId}:expertise — expertise text (complementarity B→A)
 *   {recordId}:goal      — current 90-day goal text (goal relevance)
 */

export const SEMANTIC_KINDS = ["profile", "help", "expertise", "goal"] as const;
export type SemanticKind = (typeof SEMANTIC_KINDS)[number];

export interface SemanticProfileFields {
  name?: string | null;
  professionalHeadline?: string | null;
  profileBio?: string | null;
  businessDescription?: string | null;
  ninetyDayGoal?: string | null;
  helpWanted?: string | null;
  helpWantedContext?: string | null;
  expertise?: string | null;
  expertiseContext?: string | null;
  connectionType?: string | null;
}

export interface SemanticTexts {
  profileText: string;
  helpText: string;
  expertiseText: string;
  goalText: string;
}

const RECORD_ID_PATTERN = /^rec[A-Za-z0-9]{10,}$/;

/** Flatten an Airtable field value (string | array | linked objects) into text. */
export function fieldToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const entry of value) {
      if (entry == null) continue;
      if (typeof entry === "string" || typeof entry === "number") {
        const text = String(entry).trim();
        // Bare Airtable record ids carry no meaning for embeddings.
        if (text && !RECORD_ID_PATTERN.test(text)) parts.push(text);
        continue;
      }
      if (typeof entry === "object") {
        const obj = entry as Record<string, unknown>;
        const label = obj.name ?? obj.label ?? obj.value;
        if (typeof label === "string" && label.trim()) parts.push(label.trim());
      }
    }
    return parts.filter((p, i) => parts.indexOf(p) === i).join(", ");
  }
  return "";
}

export function buildSemanticTexts(fields: SemanticProfileFields): SemanticTexts {
  const profileText = [
    fieldToText(fields.professionalHeadline),
    fieldToText(fields.profileBio),
    fieldToText(fields.businessDescription),
    fieldToText(fields.connectionType),
  ]
    .filter(Boolean)
    .join(". ");

  // Members with zero semantic content still need a Pinecone record (created
  // as soon as they pay). The name-based fallback keeps the text deterministic
  // (hash-stable) and non-empty (OpenAI rejects empty embedding input).
  const name = fieldToText(fields.name);
  const fallbackProfileText = name ? `Member profile: ${name}` : "Member profile";

  const helpText = [fieldToText(fields.helpWanted), fieldToText(fields.helpWantedContext)]
    .filter(Boolean)
    .join(". ");

  const expertiseText = [fieldToText(fields.expertise), fieldToText(fields.expertiseContext)]
    .filter(Boolean)
    .join(". ");

  const goalText = fieldToText(fields.ninetyDayGoal);

  return {
    profileText: profileText || fallbackProfileText,
    helpText,
    expertiseText,
    goalText,
  };
}

/** Stable change-detection hash over the four semantic texts. */
export function computeProfileHash(fields: SemanticProfileFields): string {
  const texts = buildSemanticTexts(fields);
  const raw = [
    texts.profileText,
    texts.helpText,
    texts.expertiseText,
    texts.goalText,
  ].join("\u0000");
  return createHash("sha256").update(raw).digest("hex");
}

export function vectorIdFor(airtableRecordId: string, kind: SemanticKind): string {
  return `${airtableRecordId}:${kind}`;
}

export function vectorIdsFor(airtableRecordId: string): Record<SemanticKind, string> {
  return {
    profile: vectorIdFor(airtableRecordId, "profile"),
    help: vectorIdFor(airtableRecordId, "help"),
    expertise: vectorIdFor(airtableRecordId, "expertise"),
    goal: vectorIdFor(airtableRecordId, "goal"),
  };
}

/** Recover the member record id from a semantic vector id ("recX:profile" → "recX"). */
export function recordIdFromVectorId(vectorId: string): string | null {
  const index = vectorId.lastIndexOf(":");
  if (index === -1) return null;
  const kind = vectorId.slice(index + 1);
  if (!SEMANTIC_KINDS.includes(kind as SemanticKind)) return null;
  return vectorId.slice(0, index);
}

/** Map Airtable MEMBERS fields to SemanticProfileFields using the canonical field names. */
export function semanticFieldsFromRecord(record: AirtableRecord): SemanticProfileFields {
  const f = record.fields;
  const name =
    fieldToText(f[MEMBER_FIELDS.name]) ||
    [f[MEMBER_FIELDS.firstName], f[MEMBER_FIELDS.lastName]]
      .map((v) => fieldToText(v))
      .filter(Boolean)
      .join(" ");
  return {
    name,
    professionalHeadline: String(f[MEMBER_FIELDS.professionalHeadline] ?? ""),
    profileBio: String(f[MEMBER_FIELDS.profileBio] ?? ""),
    businessDescription: String(f[MEMBER_FIELDS.businessDescription] ?? ""),
    ninetyDayGoal: String(f[MEMBER_FIELDS.ninetyDayGoal] ?? ""),
    helpWanted: fieldToText(f[MEMBER_FIELDS.helpWanted]),
    helpWantedContext: String(f[MEMBER_FIELDS.helpWantedContext] ?? ""),
    expertise: fieldToText(f[MEMBER_FIELDS.expertise]),
    expertiseContext: String(f[MEMBER_FIELDS.expertiseContext] ?? ""),
    connectionType: fieldToText(f[MEMBER_FIELDS.connectionType]),
  };
}
