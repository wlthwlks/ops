import { CITIES } from "@/lib/constants";
import { normalizeCityKey } from "@/lib/ops/city-normalize";

/**
 * City alias matching for the introduction engine. Member "City" values in
 * Airtable are free text with inconsistent spellings (e.g. "LA" vs
 * "Los Angeles"), so matching is done against the CITIES alias list
 * (label + alternatives), and member city values are canonicalized to the
 * label before eligibility checks and rendering.
 */

function buildAliasMaps(): {
  labelByKey: Map<string, string>;
  aliasesByLabelKey: Map<string, string[]>;
} {
  const labelByKey = new Map<string, string>();
  const aliasesByLabelKey = new Map<string, string[]>();
  for (const city of CITIES) {
    const aliases: string[] = [];
    for (const alias of [city.label, ...city.alternatives]) {
      const key = normalizeCityKey(alias);
      if (!key) continue;
      if (!labelByKey.has(key)) labelByKey.set(key, city.label);
      aliases.push(alias);
    }
    const labelKey = normalizeCityKey(city.label);
    aliasesByLabelKey.set(labelKey, aliases);
  }
  return { labelByKey, aliasesByLabelKey };
}

const { labelByKey, aliasesByLabelKey } = buildAliasMaps();

/** Canonical city label for a raw member city value (fallback: the raw value). */
export function canonicalizeCityName(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  return labelByKey.get(normalizeCityKey(trimmed)) ?? trimmed;
}

/**
 * Airtable filter formula matching members whose City cell equals the
 * canonical city name or any of its aliases (case-insensitive).
 */
export function cityAliasFilterFormula(cityName: string): string {
  const canonical = canonicalizeCityName(cityName);
  const labelKey = normalizeCityKey(canonical);
  const aliases = aliasesByLabelKey.get(labelKey) ?? (canonical ? [canonical] : []);
  if (aliases.length === 0) return `FIND(LOWER(""), LOWER({City}))`;
  const conditions = aliases.map((alias) => {
    const escaped = alias.replace(/"/g, '\\"');
    return `FIND(LOWER("${escaped}"), LOWER({City}))`;
  });
  return `OR(${conditions.join(", ")})`;
}
