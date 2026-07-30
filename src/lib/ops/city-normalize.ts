/**
 * Unicode-aware city name normalization for comparison and alias resolution.
 * Automatic writes must only use exact matches + explicit config — not fuzzy guesses.
 */

export function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Normalize for comparison: trim, collapse spaces, NFD + strip combining marks, case-fold. */
export function normalizeCityKey(value: string): string {
  const collapsed = collapseSpaces(value);
  if (!collapsed) return "";
  return collapsed
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

export function isInvalidCityValue(
  raw: string,
  invalidList: string[] = ["", "na", "n/a", "none", "null", "-", "tbd", "unknown"]
): boolean {
  const key = normalizeCityKey(raw);
  if (!key) return true;
  return invalidList.map(normalizeCityKey).includes(key);
}

export type CityResolution =
  | { ok: true; canonical: string; via: "exact" | "alias" | "override" | "virtual_fallback" }
  | { ok: false; reason: string };

/**
 * Resolve a legacy city string to a canonical city name using config only.
 * Does not invent cities via fuzzy matching.
 */
export function resolveCanonicalCity(
  raw: string,
  opts: {
    aliases: Record<string, string>;
    /** canonical names that exist or will exist */
    knownCanonicals: Set<string>;
    virtualFallbackCities?: string[];
    recordOverride?: string;
    invalidList?: string[];
  }
): CityResolution {
  if (opts.recordOverride) {
    return { ok: true, canonical: opts.recordOverride, via: "override" };
  }

  const rawTrim = collapseSpaces(raw);
  if (isInvalidCityValue(rawTrim, opts.invalidList)) {
    return { ok: false, reason: "Invalid or blank city value" };
  }

  const key = normalizeCityKey(rawTrim);

  // Explicit alias table (keys already expected lower/normalized)
  const aliasMap = new Map<string, string>();
  for (const [k, v] of Object.entries(opts.aliases)) {
    aliasMap.set(normalizeCityKey(k), v);
  }
  const aliased = aliasMap.get(key);
  if (aliased) {
    return { ok: true, canonical: aliased, via: "alias" };
  }

  // Exact match against known canonicals (accent-insensitive)
  const canonicalByKey = new Map<string, string>();
  for (const c of opts.knownCanonicals) {
    canonicalByKey.set(normalizeCityKey(c), c);
  }
  const exact = canonicalByKey.get(key);
  if (exact) {
    return { ok: true, canonical: exact, via: "exact" };
  }

  // Explicit virtual fallback list only
  const virtuals = opts.virtualFallbackCities || [];
  for (const v of virtuals) {
    if (normalizeCityKey(v) === key) {
      return { ok: true, canonical: "Virtual", via: "virtual_fallback" };
    }
  }

  return {
    ok: false,
    reason: `No exact/alias/virtual mapping for "${rawTrim}"`,
  };
}

/** Build reverse map: normalized city → channel display name from channelCityLinks. */
export function buildCityToChannelMap(
  channelCityLinks: Record<string, string[]>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [channelName, cities] of Object.entries(channelCityLinks)) {
    for (const city of cities) {
      const key = normalizeCityKey(city);
      const existing = map.get(key);
      if (existing && existing !== channelName) {
        throw new Error(
          `Conflicting channel mapping for city "${city}": "${existing}" vs "${channelName}"`
        );
      }
      map.set(key, channelName);
    }
  }
  return map;
}
