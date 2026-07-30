/**
 * Core helpers for Members → Cities → Slack channels relationship repair.
 * CLI-only apply path. Dashboard only reads the resulting links.
 */
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import {
  collapseSpaces,
  isInvalidCityValue,
  normalizeCityKey,
  resolveCanonicalCity,
} from "@/lib/ops/city-normalize";
import {
  type ValidatedCityConfig,
  findChannelName,
  resolveFieldNames,
} from "@/lib/ops/city-relation-config";
import type {
  ChannelRelationProposal,
  CityRecordProposal,
  MemberCityProposal,
} from "@/lib/ops/city-relation-types";

export function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) {
    // linked record ids or multi-select — display first as string
    if (v.length === 0) return "";
    const first = v[0];
    if (first && typeof first === "object" && "name" in (first as object)) {
      return String((first as { name?: string }).name || "").trim();
    }
    return String(first ?? "").trim();
  }
  return String(v).trim();
}

/**
 * Read linked-record field values as bare Airtable record IDs.
 * Handles both API shapes: ["rec…"] and [{ id: "rec…" }].
 */
export function linkedRecordIds(fields: Record<string, unknown>, key: string): string[] {
  const v = fields[key];
  if (v == null || v === "") return [];
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object" && "id" in item) {
          return String((item as { id: string }).id).trim();
        }
        return "";
      })
      .filter((id) => id.startsWith("rec"));
  }
  if (typeof v === "string" && v.startsWith("rec")) return [v.trim()];
  return [];
}

/**
 * Airtable REST linked-record writes must be an array of record ID strings,
 * e.g. ["recXXX", "recYYY"] — NOT [{ id: "recXXX" }] (that becomes "[object Object]").
 */
export function toLinkedRecordWriteValue(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id.startsWith("rec")))];
}

export function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((id, i) => id === sb[i]);
}

export function parseRepairArgs(argv: string[]) {
  const flags = new Set(argv.filter((a) => a.startsWith("--") && !a.includes("=")));
  let configPath = "config/city_relation_repair_config.json";
  let reportDir = "";
  for (const a of argv) {
    if (a.startsWith("--config=")) configPath = a.slice("--config=".length);
    if (a.startsWith("--report-dir=")) reportDir = a.slice("--report-dir=".length);
  }
  const confirmApply = flags.has("--confirm-apply");
  const audit = flags.has("--audit") || flags.size === 0;
  const dryRun = flags.has("--dry-run");
  const applyCityRecords = flags.has("--apply-city-records") || flags.has("--apply-all");
  const applyChannelRelations =
    flags.has("--apply-channel-relations") || flags.has("--apply-all");
  const applyMemberLinks = flags.has("--apply-member-links") || flags.has("--apply-all");
  const mergeDuplicates = flags.has("--merge-duplicates") || flags.has("--apply-all");
  const deleteMergedDuplicates = flags.has("--delete-merged-duplicates");
  const assignInvalidToVirtual = flags.has("--assign-invalid-to-virtual");

  const anyApply =
    applyCityRecords || applyChannelRelations || applyMemberLinks || deleteMergedDuplicates;

  return {
    configPath,
    reportDir,
    confirmApply,
    audit,
    dryRun: dryRun || (!anyApply && !audit),
    applyCityRecords,
    applyChannelRelations,
    applyMemberLinks,
    mergeDuplicates,
    deleteMergedDuplicates,
    assignInvalidToVirtual,
    anyApply,
  };
}

export type LiveSnapshots = {
  members: AirtableRecord[];
  cities: AirtableRecord[];
  channels: AirtableRecord[];
};

async function loadTableOrThrow(
  label: string,
  fn: () => Promise<AirtableRecord[]>
): Promise<AirtableRecord[]> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed loading Airtable table "${label}": ${msg}\n` +
        `Hint: 403 often means wrong table name. Live base uses: MEMBERS, ALL CITIES, SLACK CHANNELS, MATCH GROUPS, DONUT DATA, CITY WLKS.`
    );
  }
}

export async function loadLiveSnapshots(
  airtable: AirtableClient,
  fields: ReturnType<typeof resolveFieldNames>
): Promise<LiveSnapshots> {
  // Sequential loads so failures name the exact table
  const members = await loadTableOrThrow(fields.membersTable, async () => {
    try {
      return await airtable.listRecords(fields.membersTable, {
        fields: [
          "Name",
          "email",
          fields.memberCityLegacy,
          fields.memberCityLink,
        ],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Link field may not exist yet — load without it
      if (
        msg.includes("Unknown field name") &&
        msg.includes(fields.memberCityLink)
      ) {
        console.warn(
          `Members field "${fields.memberCityLink}" not found — loading without it (create linked field before --apply-member-links).`
        );
        return airtable.listRecords(fields.membersTable, {
          fields: ["Name", "email", fields.memberCityLegacy],
        });
      }
      throw err;
    }
  });

  const cities = await loadTableOrThrow(fields.citiesTable, () =>
    airtable.listRecords(fields.citiesTable)
  );

  const channels = await loadTableOrThrow(fields.channelsTable, () =>
    airtable.listRecords(fields.channelsTable, {
      fields: [
        fields.channelName,
        fields.channelCities,
        fields.channelStatus,
        fields.channelSlackId,
      ],
    })
  );

  return { members, cities, channels };
}

export function indexCities(
  cities: AirtableRecord[],
  cityNameField: string
): {
  byId: Map<string, AirtableRecord>;
  byNormalizedName: Map<string, AirtableRecord[]>;
} {
  const byId = new Map<string, AirtableRecord>();
  const byNormalizedName = new Map<string, AirtableRecord[]>();
  for (const c of cities) {
    byId.set(c.id, c);
    const name = fieldStr(c.fields, cityNameField);
    const key = normalizeCityKey(name);
    if (!key) continue;
    const list = byNormalizedName.get(key) || [];
    list.push(c);
    byNormalizedName.set(key, list);
  }
  return { byId, byNormalizedName };
}

export function indexChannels(
  channels: AirtableRecord[],
  f: ReturnType<typeof resolveFieldNames>
): {
  byId: Map<string, AirtableRecord>;
  names: Set<string>;
  slackIds: Map<string, string>;
  statuses: Map<string, string>;
  nameToRecord: Map<string, AirtableRecord>;
} {
  const byId = new Map<string, AirtableRecord>();
  const names = new Set<string>();
  const slackIds = new Map<string, string>();
  const statuses = new Map<string, string>();
  const nameToRecord = new Map<string, AirtableRecord>();
  for (const ch of channels) {
    byId.set(ch.id, ch);
    const name = fieldStr(ch.fields, f.channelName);
    names.add(name);
    nameToRecord.set(name, ch);
    slackIds.set(name, fieldStr(ch.fields, f.channelSlackId));
    statuses.set(name, fieldStr(ch.fields, f.channelStatus));
  }
  return { byId, names, slackIds, statuses, nameToRecord };
}

export function proposeCityRecords(
  cities: AirtableRecord[],
  config: ValidatedCityConfig,
  fields: ReturnType<typeof resolveFieldNames>
): CityRecordProposal[] {
  const proposals: CityRecordProposal[] = [];
  const { byNormalizedName } = indexCities(cities, fields.cityName);

  for (const ren of config.cityRenames) {
    const key = normalizeCityKey(ren.from);
    const matches = byNormalizedName.get(key) || [];
    // also exact field match with trailing space
    for (const rec of cities) {
      const name = fieldStr(rec.fields, fields.cityName);
      if (name === ren.from || normalizeCityKey(name) === key) {
        if (name !== ren.to) {
          proposals.push({
            action: "rename",
            recordId: rec.id,
            beforeName: name,
            afterName: ren.to,
            country: fieldStr(rec.fields, fields.cityCountry),
            reason: `Rename city "${name}" → "${ren.to}"`,
            safeToAutoApply: true,
          });
        }
      }
    }
    void matches;
  }

  for (const co of config.countryOverrides) {
    const key = normalizeCityKey(co.city);
    const matches = byNormalizedName.get(key) || [];
    for (const rec of matches) {
      const current = fieldStr(rec.fields, fields.cityCountry);
      if (current !== co.country) {
        proposals.push({
          action: "country_override",
          recordId: rec.id,
          beforeName: fieldStr(rec.fields, fields.cityName),
          afterName: fieldStr(rec.fields, fields.cityName),
          country: co.country,
          reason: `Set country "${current || "(blank)"}" → "${co.country}"`,
          safeToAutoApply: true,
        });
      }
    }
  }

  for (const create of config.citiesToCreate) {
    const key = normalizeCityKey(create.city);
    const existing = byNormalizedName.get(key) || [];
    if (existing.length === 0) {
      proposals.push({
        action: "create",
        recordId: "",
        beforeName: "",
        afterName: create.city,
        country: create.country,
        reason: `Create missing City "${create.city}"`,
        safeToAutoApply: true,
      });
    }
  }

  // Duplicate detection
  for (const dupName of config.duplicateCityNames) {
    const key = normalizeCityKey(dupName);
    const matches = byNormalizedName.get(key) || [];
    if (matches.length > 1) {
      const canonical = pickCanonicalDuplicate(matches, fields);
      for (const m of matches) {
        if (m.id === canonical.id) continue;
        proposals.push({
          action: "merge_duplicate",
          recordId: m.id,
          beforeName: fieldStr(m.fields, fields.cityName),
          afterName: fieldStr(canonical.fields, fields.cityName),
          country: fieldStr(canonical.fields, fields.cityCountry),
          reason: `Duplicate of ${canonical.id}; re-link then optional delete`,
          safeToAutoApply: true,
        });
      }
    }
  }

  return proposals;
}

export function pickCanonicalDuplicate(
  matches: AirtableRecord[],
  fields: ReturnType<typeof resolveFieldNames>
): AirtableRecord {
  const scored = matches.map((m) => {
    let score = 0;
    const country = fieldStr(m.fields, fields.cityCountry).toLowerCase();
    if (country.includes("brazil")) score += 10;
    const channels = linkedRecordIds(m.fields, fields.cityChannels);
    score += channels.length * 5;
    // prefer earlier created (stable) via id lexicographic as weak tiebreak
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score || a.m.id.localeCompare(b.m.id));
  return scored[0].m;
}

export function proposeChannelRelations(
  cities: AirtableRecord[],
  channels: AirtableRecord[],
  config: ValidatedCityConfig,
  fields: ReturnType<typeof resolveFieldNames>
): ChannelRelationProposal[] {
  const { byNormalizedName } = indexCities(cities, fields.cityName);
  const chIndex = indexChannels(channels, fields);
  const proposals: ChannelRelationProposal[] = [];

  for (const [configChannelName, cityNames] of Object.entries(config.channelCityLinks)) {
    const liveName = findChannelName(configChannelName, chIndex.names);
    if (!liveName) continue;
    const ch = chIndex.nameToRecord.get(liveName);
    if (!ch) continue;

    const before = linkedRecordIds(ch.fields, fields.channelCities);
    const afterSet = new Set(before);
    const added: string[] = [];

    for (const cityName of cityNames) {
      const matches = byNormalizedName.get(normalizeCityKey(cityName)) || [];
      if (matches.length === 0) continue;
      // prefer single match; if duplicates, pick canonical
      const cityRec =
        matches.length === 1 ? matches[0] : pickCanonicalDuplicate(matches, fields);
      if (!afterSet.has(cityRec.id)) {
        afterSet.add(cityRec.id);
        added.push(cityName);
      }
    }

    const after = [...afterSet];
    proposals.push({
      channelRecordId: ch.id,
      channelName: liveName,
      status: fieldStr(ch.fields, fields.channelStatus),
      slackChannelId: fieldStr(ch.fields, fields.channelSlackId),
      beforeCityIds: before,
      afterCityIds: after,
      addedCityNames: added,
      reason: added.length
        ? `Link ${added.length} city record(s) to channel`
        : "Already up to date",
      wouldUpdate: !sameIdSet(before, after),
    });
  }

  return proposals;
}

export function proposeMemberLinks(
  members: AirtableRecord[],
  cities: AirtableRecord[],
  config: ValidatedCityConfig,
  fields: ReturnType<typeof resolveFieldNames>,
  opts?: { assignInvalidToVirtual?: boolean }
): { proposals: MemberCityProposal[]; unresolved: MemberCityProposal[] } {
  const { byNormalizedName } = indexCities(cities, fields.cityName);
  const proposals: MemberCityProposal[] = [];
  const unresolved: MemberCityProposal[] = [];

  // Expand known canonicals with live city names
  const known = new Set(config.knownCanonicals);
  for (const c of cities) {
    const n = fieldStr(c.fields, fields.cityName);
    if (n) known.add(n);
  }

  for (const m of members) {
    const legacy = fieldStr(m.fields, fields.memberCityLegacy);
    const currentLinks = linkedRecordIds(m.fields, fields.memberCityLink);
    const name = fieldStr(m.fields, "Name");
    const email = fieldStr(m.fields, "email");
    const override = config.recordOverrides[m.id];

    const resolution = resolveCanonicalCity(legacy, {
      aliases: config.aliases,
      knownCanonicals: known,
      virtualFallbackCities: config.virtualFallbackCities,
      recordOverride: override,
      invalidList: config.invalidMemberCityValues,
    });

    if (!resolution.ok) {
      if (opts?.assignInvalidToVirtual && isInvalidCityValue(legacy, config.invalidMemberCityValues)) {
        // explicit flag only
        const virtual = byNormalizedName.get(normalizeCityKey("Virtual")) || [];
        const vRec = virtual[0];
        const row: MemberCityProposal = {
          airtableRecordId: m.id,
          memberName: name,
          email,
          legacyCity: legacy,
          currentLinkIds: currentLinks,
          proposedCanonical: "Virtual",
          proposedCityRecordId: vRec?.id || "",
          proposedChannelName: "Virtual",
          confidence: "low",
          reason: "Invalid city assigned to Virtual via explicit flag",
          via: "virtual_flag",
          safeToAutoApply: Boolean(vRec),
          manualReviewReason: "",
          wouldUpdate: vRec ? !currentLinks.includes(vRec.id) || currentLinks.length !== 1 : false,
        };
        if (vRec) proposals.push(row);
        else unresolved.push({ ...row, manualReviewReason: "Virtual city record missing" });
        continue;
      }

      unresolved.push({
        airtableRecordId: m.id,
        memberName: name,
        email,
        legacyCity: legacy,
        currentLinkIds: currentLinks,
        proposedCanonical: "",
        proposedCityRecordId: "",
        proposedChannelName: "",
        confidence: "low",
        reason: resolution.reason,
        via: "none",
        safeToAutoApply: false,
        manualReviewReason: resolution.reason,
        wouldUpdate: false,
      });
      continue;
    }

    const matches = byNormalizedName.get(normalizeCityKey(resolution.canonical)) || [];
    if (matches.length === 0) {
      unresolved.push({
        airtableRecordId: m.id,
        memberName: name,
        email,
        legacyCity: legacy,
        currentLinkIds: currentLinks,
        proposedCanonical: resolution.canonical,
        proposedCityRecordId: "",
        proposedChannelName: config.cityToChannel.get(normalizeCityKey(resolution.canonical)) || "",
        confidence: "medium",
        reason: `Canonical city "${resolution.canonical}" not yet in Airtable`,
        via: resolution.via,
        safeToAutoApply: false,
        manualReviewReason: "Create city record first",
        wouldUpdate: false,
      });
      continue;
    }

    const cityRec =
      matches.length === 1 ? matches[0] : pickCanonicalDuplicate(matches, fields);
    const channelName =
      config.cityToChannel.get(normalizeCityKey(resolution.canonical)) || "";

    const already =
      currentLinks.length === 1 && currentLinks[0] === cityRec.id;

    proposals.push({
      airtableRecordId: m.id,
      memberName: name,
      email,
      legacyCity: legacy,
      currentLinkIds: currentLinks,
      proposedCanonical: resolution.canonical,
      proposedCityRecordId: cityRec.id,
      proposedChannelName: channelName,
      confidence: resolution.via === "override" || resolution.via === "alias" ? "high" : "high",
      reason: `Resolve "${legacy}" → ${resolution.canonical} via ${resolution.via}`,
      via: resolution.via,
      safeToAutoApply: true,
      manualReviewReason: "",
      wouldUpdate: !already,
    });
  }

  return { proposals, unresolved };
}

export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(r.map((c) => csvEscape(c ?? "")).join(","));
  }
  return lines.join("\n") + "\n";
}

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve member city display + channel via linked records.
 * Prefer City relation link; fall back to legacy text City.
 */
export function resolveMemberCityChannel(input: {
  memberFields: Record<string, unknown>;
  citiesById: Map<string, AirtableRecord>;
  channelsById: Map<string, AirtableRecord>;
  memberCityLinkField: string;
  memberCityLegacyField: string;
  cityNameField: string;
  cityChannelsField: string;
  channelNameField: string;
  channelStatusField: string;
  channelSlackIdField: string;
}): {
  cityName: string;
  cityRecordId: string;
  channelRecordId: string;
  channelName: string;
  channelStatus: string;
  slackChannelId: string;
  condition: import("@/lib/ops/city-relation-types").CityLinkCondition;
  usedLegacyFallback: boolean;
} {
  const {
    memberFields,
    citiesById,
    channelsById,
    memberCityLinkField,
    memberCityLegacyField,
    cityNameField,
    cityChannelsField,
    channelNameField,
    channelStatusField,
    channelSlackIdField,
  } = input;

  const linkIds = linkedRecordIds(memberFields, memberCityLinkField);
  const legacy = fieldStr(memberFields, memberCityLegacyField);
  let cityRecordId = linkIds[0] || "";
  let usedLegacyFallback = false;
  let cityName = "";

  if (cityRecordId && citiesById.has(cityRecordId)) {
    cityName = fieldStr(citiesById.get(cityRecordId)!.fields, cityNameField);
  } else if (legacy) {
    usedLegacyFallback = true;
    cityName = collapseSpaces(legacy);
    // try match city by name
    for (const [id, rec] of citiesById) {
      if (normalizeCityKey(fieldStr(rec.fields, cityNameField)) === normalizeCityKey(legacy)) {
        cityRecordId = id;
        cityName = fieldStr(rec.fields, cityNameField);
        break;
      }
    }
  }

  if (!cityRecordId && !cityName) {
    return {
      cityName: "",
      cityRecordId: "",
      channelRecordId: "",
      channelName: "",
      channelStatus: "",
      slackChannelId: "",
      condition: "MEMBER_CITY_LINK_MISSING",
      usedLegacyFallback,
    };
  }

  if (!cityRecordId) {
    return {
      cityName,
      cityRecordId: "",
      channelRecordId: "",
      channelName: "",
      channelStatus: "",
      slackChannelId: "",
      condition: usedLegacyFallback
        ? "LEGACY_CITY_FALLBACK"
        : "MEMBER_CITY_VALUE_UNRESOLVED",
      usedLegacyFallback,
    };
  }

  const cityRec = citiesById.get(cityRecordId);
  if (!cityRec) {
    return {
      cityName,
      cityRecordId,
      channelRecordId: "",
      channelName: "",
      channelStatus: "",
      slackChannelId: "",
      condition: "MEMBER_CITY_VALUE_UNRESOLVED",
      usedLegacyFallback,
    };
  }

  cityName = fieldStr(cityRec.fields, cityNameField) || cityName;
  const channelIds = linkedRecordIds(cityRec.fields, cityChannelsField);
  if (channelIds.length === 0) {
    return {
      cityName,
      cityRecordId,
      channelRecordId: "",
      channelName: "",
      channelStatus: "",
      slackChannelId: "",
      condition: "CITY_SLACK_CHANNEL_LINK_MISSING",
      usedLegacyFallback,
    };
  }

  // Prefer Active channel if multiple
  let chosenId = channelIds[0];
  for (const cid of channelIds) {
    const ch = channelsById.get(cid);
    if (!ch) continue;
    const st = fieldStr(ch.fields, channelStatusField).toLowerCase();
    if (st.includes("active")) {
      chosenId = cid;
      break;
    }
  }

  const ch = channelsById.get(chosenId);
  if (!ch) {
    return {
      cityName,
      cityRecordId,
      channelRecordId: chosenId,
      channelName: "",
      channelStatus: "",
      slackChannelId: "",
      condition: "CITY_SLACK_CHANNEL_LINK_MISSING",
      usedLegacyFallback,
    };
  }

  const channelName = fieldStr(ch.fields, channelNameField);
  const channelStatus = fieldStr(ch.fields, channelStatusField);
  const slackChannelId = fieldStr(ch.fields, channelSlackIdField);
  const st = channelStatus.toLowerCase();

  let condition: import("@/lib/ops/city-relation-types").CityLinkCondition = "ACTIVE_CHANNEL_READY";
  if (st.includes("paused")) condition = "CITY_CHANNEL_PAUSED";
  else if (st.includes("closed")) condition = "CITY_CHANNEL_CLOSED";
  else if (st.includes("active") && !slackChannelId) condition = "ACTIVE_CHANNEL_MISSING_SLACK_ID";
  else if (normalizeCityKey(cityName) === "virtual") condition = "VIRTUAL_FALLBACK_CHANNEL";
  else if (slackChannelId) condition = "ACTIVE_CHANNEL_READY";
  else if (!slackChannelId && !st.includes("active")) condition = "CITY_CHANNEL_PAUSED";

  return {
    cityName,
    cityRecordId,
    channelRecordId: chosenId,
    channelName,
    channelStatus,
    slackChannelId,
    condition,
    usedLegacyFallback,
  };
}

export function conditionMessage(condition: import("@/lib/ops/city-relation-types").CityLinkCondition): string {
  switch (condition) {
    case "MEMBER_CITY_LINK_MISSING":
      return "Member has no linked City relation. Run city-relation repair or set City relation in Airtable.";
    case "MEMBER_CITY_VALUE_UNRESOLVED":
      return "Member city value could not be resolved to a Cities record.";
    case "CITY_SLACK_CHANNEL_LINK_MISSING":
      return "City has no linked Slack channel. Link Cities ↔ Slack channels.";
    case "CITY_CHANNEL_PAUSED":
      return "City maps to a Paused Slack channel (no urgent ID required).";
    case "CITY_CHANNEL_CLOSED":
      return "City maps to a Closed Slack channel (historical; not an active destination).";
    case "ACTIVE_CHANNEL_MISSING_SLACK_ID":
      return "Active Slack channel is missing Slack Channel ID — configure the ID in Airtable.";
    case "ACTIVE_CHANNEL_READY":
      return "City channel is Active and has a Slack Channel ID.";
    case "VIRTUAL_FALLBACK_CHANNEL":
      return "Member city uses the Virtual fallback channel.";
    case "LEGACY_CITY_FALLBACK":
      return "Using legacy City text; City relation link not set yet.";
  }
}
