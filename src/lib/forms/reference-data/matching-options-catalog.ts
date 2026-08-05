/**
 * MATCHING OPTIONS catalogue for Help wanted / Expertise linked fields.
 * Loads live options when Airtable is configured; falls back to static app codes.
 */
import {
  createAirtableClient,
  type AirtableClient,
} from "@/lib/integrations/airtable";
import { MATCHING_OPTIONS_TABLE } from "@/lib/ops/airtable-fields";
import {
  EXPERTISE_OPTIONS,
  HELP_WANTED_OPTIONS,
} from "./static-options";

export type MatchingOption = {
  code: string;
  label: string;
  /** help | expertise | both — from verified Airtable category when present */
  kind: "help" | "expertise" | "both";
};

export type MatchingOptionsCatalog = {
  helpWantedOptions: MatchingOption[];
  expertiseOptions: MatchingOption[];
  source: "airtable" | "static";
  fetchedAt: string;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; data: MatchingOptionsCatalog } | null = null;

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

function getClient(): AirtableClient | null {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) return null;
  return createAirtableClient({ apiKey: token, baseId });
}

function staticCatalog(): MatchingOptionsCatalog {
  return {
    helpWantedOptions: HELP_WANTED_OPTIONS.map((o) => ({
      code: o.code,
      label: o.label,
      kind: "help" as const,
    })),
    expertiseOptions: EXPERTISE_OPTIONS.map((o) => ({
      code: o.code,
      label: o.label,
      kind: "expertise" as const,
    })),
    source: "static",
    fetchedAt: new Date().toISOString(),
  };
}

/** Infer help vs expertise from optional Type/Category/Kind columns when present. */
function classifyKind(fields: Record<string, unknown>): "help" | "expertise" | "both" {
  const raw = (
    fieldStr(fields, "Type") ||
    fieldStr(fields, "Category") ||
    fieldStr(fields, "Kind") ||
    fieldStr(fields, "Option type") ||
    ""
  ).toLowerCase();
  if (!raw) return "both";
  if (/help|want|need|seek/.test(raw) && !/expert|offer|skill/.test(raw)) return "help";
  if (/expert|offer|skill|give/.test(raw) && !/help|want|need/.test(raw)) return "expertise";
  if (/help|want|need/.test(raw)) return "help";
  if (/expert|offer|skill/.test(raw)) return "expertise";
  return "both";
}

function isInactive(fields: Record<string, unknown>): boolean {
  if (fields.Active === false || fields.Active === 0) return true;
  if (fields["Form enabled"] === false || fields["Form enabled"] === 0) return true;
  const status = fieldStr(fields, "Status").toLowerCase();
  if (status === "inactive" || status === "archived" || status === "disabled") return true;
  return false;
}

export function clearMatchingOptionsCache(): void {
  cache = null;
}

export function setMatchingOptionsCatalogForTests(
  data: MatchingOptionsCatalog | null
): void {
  if (!data) {
    cache = null;
    return;
  }
  cache = { at: Date.now(), data };
}

export async function loadMatchingOptionsCatalog(
  airtable: AirtableClient | null = getClient(),
  opts?: { force?: boolean }
): Promise<MatchingOptionsCatalog> {
  if (!opts?.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  if (!airtable) {
    const fallback = staticCatalog();
    cache = { at: Date.now(), data: fallback };
    return fallback;
  }

  try {
    // Request only widely-present Name; optional fields may 422 — retry with Name only.
    let recs;
    try {
      recs = await airtable.listRecords(MATCHING_OPTIONS_TABLE, {
        fields: ["Name", "Type", "Category", "Kind", "Active", "Form enabled", "Status"],
      });
    } catch {
      recs = await airtable.listRecords(MATCHING_OPTIONS_TABLE, {
        fields: ["Name"],
      });
    }

    const help: MatchingOption[] = [];
    const expertise: MatchingOption[] = [];

    for (const r of recs) {
      if (isInactive(r.fields)) continue;
      const label =
        fieldStr(r.fields, "Name") ||
        fieldStr(r.fields, "Option") ||
        fieldStr(r.fields, "Label");
      if (!label) continue;
      const kind = classifyKind(r.fields);
      const opt: MatchingOption = { code: r.id, label, kind };
      if (kind === "help" || kind === "both") help.push(opt);
      if (kind === "expertise" || kind === "both") expertise.push(opt);
    }

    // If Airtable table is empty or unusable, keep static codes so forms still work.
    if (help.length === 0 && expertise.length === 0) {
      const fallback = staticCatalog();
      cache = { at: Date.now(), data: fallback };
      return fallback;
    }

    // If classification put everything in one bucket, mirror into both.
    const helpWantedOptions =
      help.length > 0
        ? help.sort((a, b) => a.label.localeCompare(b.label))
        : expertise.map((o) => ({ ...o, kind: "help" as const }));
    const expertiseOptions =
      expertise.length > 0
        ? expertise.sort((a, b) => a.label.localeCompare(b.label))
        : help.map((o) => ({ ...o, kind: "expertise" as const }));

    const data: MatchingOptionsCatalog = {
      helpWantedOptions,
      expertiseOptions,
      source: "airtable",
      fetchedAt: new Date().toISOString(),
    };
    cache = { at: Date.now(), data };
    return data;
  } catch {
    const fallback = staticCatalog();
    cache = { at: Date.now(), data: fallback };
    return fallback;
  }
}

export function linkIdsFromField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => {
      if (typeof v === "string") return v.trim();
      if (v && typeof v === "object" && "id" in v && typeof (v as { id: unknown }).id === "string") {
        return (v as { id: string }).id.trim();
      }
      return "";
    })
    .filter(Boolean);
}
