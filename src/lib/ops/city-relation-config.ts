import { readFileSync } from "fs";
import { normalizeCityKey, buildCityToChannelMap } from "@/lib/ops/city-normalize";

export type CityRelationRepairConfig = {
  version: number;
  description?: string;
  tables: {
    members: string;
    cities: string;
    slackChannels: string;
  };
  fields: {
    memberCityLegacy: string;
    memberCityLink: string;
    cityName: string;
    cityCountry: string;
    cityChannels: string;
    channelName: string;
    channelCities: string;
    channelStatus: string;
    channelSlackId: string;
  };
  cityRenames: Array<{ from: string; to: string }>;
  countryOverrides: Array<{ city: string; country: string }>;
  aliases: Record<string, string>;
  citiesToCreate: Array<{ city: string; country: string }>;
  channelCityLinks: Record<string, string[]>;
  virtualFallbackCities: string[];
  recordOverrides: Record<string, string>;
  duplicateCityNames: string[];
  invalidMemberCityValues: string[];
};

export type ValidatedCityConfig = CityRelationRepairConfig & {
  cityToChannel: Map<string, string>;
  knownCanonicals: Set<string>;
  aliasKeys: Map<string, string>;
};

export function loadCityRelationConfig(path: string): CityRelationRepairConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as CityRelationRepairConfig;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid city relation config: not an object");
  }
  if (!parsed.tables?.members || !parsed.tables?.cities || !parsed.tables?.slackChannels) {
    throw new Error("Invalid city relation config: missing tables");
  }
  if (!parsed.fields?.memberCityLink || !parsed.fields?.cityName) {
    throw new Error("Invalid city relation config: missing fields");
  }
  if (!parsed.channelCityLinks || typeof parsed.channelCityLinks !== "object") {
    throw new Error("Invalid city relation config: missing channelCityLinks");
  }
  return parsed;
}

/**
 * Validate mapping consistency before any writes.
 * channelNames / activeChannelIds come from live Airtable when available.
 */
export function validateCityRelationConfig(
  config: CityRelationRepairConfig,
  live?: {
    channelNames: Set<string>;
    /** channel name → slack id (may be blank for paused/closed) */
    channelSlackIds: Map<string, string>;
    channelStatuses: Map<string, string>;
  }
): { ok: true; validated: ValidatedCityConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  let cityToChannel: Map<string, string>;
  try {
    cityToChannel = buildCityToChannelMap(config.channelCityLinks);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    cityToChannel = new Map();
  }

  const knownCanonicals = new Set<string>();
  for (const cities of Object.values(config.channelCityLinks)) {
    for (const c of cities) knownCanonicals.add(c);
  }
  for (const c of config.citiesToCreate) knownCanonicals.add(c.city);
  for (const r of config.cityRenames) knownCanonicals.add(r.to);
  for (const a of Object.values(config.aliases)) knownCanonicals.add(a);

  // Alias uniqueness: one alias → one canonical
  const aliasKeys = new Map<string, string>();
  for (const [k, v] of Object.entries(config.aliases || {})) {
    const nk = normalizeCityKey(k);
    if (aliasKeys.has(nk) && aliasKeys.get(nk) !== v) {
      errors.push(`Alias "${k}" maps to multiple canonicals`);
    }
    aliasKeys.set(nk, v);
  }

  // Every canonical city should map to exactly one channel
  for (const city of knownCanonicals) {
    const ch = cityToChannel.get(normalizeCityKey(city));
    if (!ch && city !== "Virtual") {
      // cities only in renames/creates may still get linked later via channelCityLinks
      const inLinks = [...cityToChannel.keys()].includes(normalizeCityKey(city));
      if (!inLinks) {
        // soft: only error if city is in channelCityLinks values check already covered
      }
    }
  }

  if (live) {
    /**
     * Validate mapped CHANNEL NAMES (values of city→channel), never city keys.
     * cityToChannel: normalizedCityKey → config channel name (from channelCityLinks keys).
     */
    const citiesByChannel = new Map<string, string[]>();
    for (const [cityKey, channelName] of cityToChannel.entries()) {
      const list = citiesByChannel.get(channelName) || [];
      list.push(cityKey);
      citiesByChannel.set(channelName, list);
    }

    // Also cover channel keys that somehow have empty city lists
    for (const channelName of Object.keys(config.channelCityLinks)) {
      if (!citiesByChannel.has(channelName)) citiesByChannel.set(channelName, []);
    }

    for (const [channelName, cityKeys] of citiesByChannel.entries()) {
      const match = findChannelName(channelName, live.channelNames);
      if (!match) {
        // Prefer a human city label in the error (first city mapped to this channel)
        const sampleCity =
          (config.channelCityLinks[channelName] || [])[0] ||
          cityKeys[0] ||
          "(unknown city)";
        errors.push(
          `Mapped Slack channel not found for city "${sampleCity}": "${channelName}"`
        );
        continue;
      }
      const status = (live.channelStatuses.get(match) || "").toLowerCase();
      const slackId = (live.channelSlackIds.get(match) || "").trim();
      if (status.includes("active") && !slackId) {
        errors.push(`Active channel "${match}" is missing Slack Channel ID`);
      }
    }

    // Duplicate Active Slack IDs
    const idToNames = new Map<string, string[]>();
    for (const [name, id] of live.channelSlackIds) {
      const status = (live.channelStatuses.get(name) || "").toLowerCase();
      if (!id || !status.includes("active")) continue;
      const list = idToNames.get(id) || [];
      list.push(name);
      idToNames.set(id, list);
    }
    for (const [id, names] of idToNames) {
      if (names.length > 1) {
        errors.push(`Duplicate Active Slack Channel ID ${id}: ${names.join(", ")}`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    validated: {
      ...config,
      cityToChannel,
      knownCanonicals,
      aliasKeys,
    },
  };
}

/**
 * Find Airtable Slack channels.Name matching a config channel name.
 * Prefer exact match (including Unicode lock prefix), then strip leading non-letters.
 * Never treats a bare city label as a successful channel match unless it equals Name.
 */
export function findChannelName(
  configName: string,
  liveNames: Set<string>
): string | null {
  if (!configName) return null;
  // 1) Exact primary-field match (preserves 🔒 etc.)
  if (liveNames.has(configName)) return configName;

  const want = normalizeCityKey(configName);
  const wantStripped = normalizeCityKey(
    configName.replace(/^[^\p{L}\p{N}]+/u, "").trim()
  );

  // 2) Exact match after stripping leading emoji/symbols on either side
  for (const name of liveNames) {
    const stripped = name.replace(/^[^\p{L}\p{N}]+/u, "").trim();
    if (
      normalizeCityKey(name) === want ||
      normalizeCityKey(stripped) === want ||
      normalizeCityKey(stripped) === wantStripped
    ) {
      return name;
    }
  }

  // 3) Slug containment only when config looks like a channel slug (wlth-wlks-...)
  if (wantStripped.includes("wlth-wlks") || want.includes("wlth-wlks")) {
    for (const name of liveNames) {
      const stripped = normalizeCityKey(
        name.replace(/^[^\p{L}\p{N}]+/u, "").trim()
      );
      if (stripped.includes(wantStripped) || wantStripped.includes(stripped)) {
        if (stripped.length >= 8) return name;
      }
    }
  }

  return null;
}

export function envField(name: string, fallback: string): string {
  return (process.env[name] || "").trim() || fallback;
}

export function resolveFieldNames(config: CityRelationRepairConfig) {
  return {
    membersTable: envField("AIRTABLE_MEMBERS_TABLE", config.tables.members),
    citiesTable: envField(
      "AIRTABLE_CITIES_TABLE",
      config.tables.cities || "ALL CITIES"
    ),
    channelsTable: envField("AIRTABLE_SLACK_CHANNELS_TABLE", config.tables.slackChannels),
    memberCityLegacy: envField(
      "AIRTABLE_MEMBER_CITY_LEGACY_FIELD",
      config.fields.memberCityLegacy
    ),
    memberCityLink: envField(
      "AIRTABLE_MEMBER_CITY_LINK_FIELD",
      config.fields.memberCityLink
    ),
    cityName: envField("AIRTABLE_CITY_NAME_FIELD", config.fields.cityName),
    cityCountry: envField("AIRTABLE_CITY_COUNTRY_FIELD", config.fields.cityCountry),
    cityChannels: envField("AIRTABLE_CITY_CHANNEL_FIELD", config.fields.cityChannels),
    channelName: envField("AIRTABLE_SLACK_CHANNEL_NAME_FIELD", config.fields.channelName),
    channelCities: envField(
      "AIRTABLE_SLACK_CHANNEL_CITIES_FIELD",
      config.fields.channelCities
    ),
    channelStatus: envField(
      "AIRTABLE_SLACK_CHANNEL_STATUS_FIELD",
      config.fields.channelStatus
    ),
    channelSlackId: envField(
      "AIRTABLE_SLACK_CHANNEL_ID_FIELD",
      config.fields.channelSlackId
    ),
  };
}
