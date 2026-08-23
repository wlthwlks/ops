/**
 * City / all-members Slack channel membership health.
 * Visibility-only classification — no Slack mutations.
 */
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import type { SlackClient, SlackUser } from "@/lib/integrations/slack";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createSlackClient } from "@/lib/integrations/slack";
import {
  CITIES_TABLE,
  CITY_LIST_FIELDS,
  MEMBER_FIELDS,
  MEMBER_LIST_FIELDS,
  MEMBERS_TABLE,
  SLACK_CHANNEL_FIELDS,
  SLACK_CHANNEL_LIST_FIELDS,
  SLACK_CHANNELS_TABLE,
  toAirtableSchemaError,
} from "@/lib/ops/airtable-fields";
import {
  getAllMembersChannelConfig,
  resolveSlackIdentity,
} from "@/lib/ops/member-health";
import { hasServiceAccess } from "@/lib/introduction/service-access";
import { isValidEmail, normalizeEmailStrict } from "@/lib/billing/reconcile-stripe-customers";
import type { SlackIdentityState } from "@/lib/ops/member-health-types";

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) {
    // linked records → ids; plain multi → first
    return String(v[0] ?? "").trim();
  }
  return String(v).trim();
}

function fieldLinkIds(fields: Record<string, unknown>, key: string): string[] {
  const v = fields[key];
  if (Array.isArray(v)) return v.map(String);
  if (v == null || v === "") return [];
  return [String(v)];
}

export type ChannelStatusKind = "active" | "paused" | "closed" | "other";

export function classifyChannelStatus(raw: string): ChannelStatusKind {
  const s = raw.trim().toLowerCase();
  if (!s) return "other";
  if (s.includes("closed")) return "closed";
  if (s.includes("paused") || s.includes("pause")) return "paused";
  if (s.includes("active")) return "active";
  return "other";
}

export type MissingMembershipReason =
  | "in_slack_missing_channel"
  | "not_in_slack_workspace"
  | "slack_identity_unresolved"
  | "invalid_or_missing_email"
  | "channel_configuration_missing";

export type ChannelMemberRow = {
  airtableRecordId: string;
  name: string;
  primaryEmail: string;
  slackEmail: string;
  city: string;
  slackUserId: string;
  slackDisplayName: string;
  hasCurrentServiceAccess: boolean;
  identityState: SlackIdentityState;
  identityMethod: string;
  reason?: MissingMembershipReason;
  recommendedAction?: string;
};

export type UnexpectedSlackUserRow = {
  slackUserId: string;
  slackDisplayName: string;
  slackEmail: string;
  explanation: string;
};

export type AllMembersPopulationClass =
  | "current_access"
  | "grace_period"
  | "expired"
  | "invalid_access_data"
  | "no_airtable_match"
  | "ambiguous_airtable_match";

export type AllMembersHumanRow = {
  slackUserId: string;
  slackDisplayName: string;
  slackEmail: string;
  classification: AllMembersPopulationClass;
  airtableRecordId: string;
  name: string;
  city: string;
  membership: string;
  payment: string;
  serviceAccessUntil: string;
  hasCurrentServiceAccess: boolean;
};

export type AllMembersBreakdown = {
  rawChannelMemberIds: number;
  deletedExcluded: number;
  botsAppsExcluded: number;
  activeHumansIncluded: number;
  idsNotInUsersList: number;
  duplicateIds: number;
  currentAccessPresent: number;
  gracePeriodPresent: number;
  expiredPresent: number;
  invalidAccessData: number;
  unmatchedSlackUsers: number;
  ambiguousMatches: number;
  expectedCurrentAccessMissing: number;
  humans: AllMembersHumanRow[];
};

export type ChannelHealthRow = {
  /** Canonical key: Slack Channel ID or airtable record id if missing */
  key: string;
  airtableRecordId: string;
  channelName: string;
  cityNames: string[];
  statusRaw: string;
  statusKind: ChannelStatusKind;
  slackChannelId: string;
  groupSize: string;
  timezone: string;
  schedulingMode: string;
  isAllMembersChannel: boolean;
  expectedCount: number;
  presentCount: number;
  missingCount: number;
  unresolvedCount: number;
  unexpectedCount: number;
  scanStatus: "ok" | "error" | "skipped" | "not_scanned";
  scanError: string | null;
  lastScanned: string | null;
  present: ChannelMemberRow[];
  missing: ChannelMemberRow[];
  unresolved: ChannelMemberRow[];
  unexpected: UnexpectedSlackUserRow[];
  /** Only populated for the all-wlth-wlks special channel */
  allMembersBreakdown?: AllMembersBreakdown;
};

function buildSlackMaps(users: SlackUser[]) {
  const emailToUser = new Map<string, SlackUser[]>();
  const nameToUser = new Map<string, SlackUser[]>();
  const userById = new Map<string, SlackUser>();
  for (const u of users) {
    userById.set(u.id, u);
    if (u.email) {
      const e = normalizeEmailStrict(u.email);
      const list = emailToUser.get(e) || [];
      list.push(u);
      emailToUser.set(e, list);
    }
    const n = (u.realName || u.name || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s\u00C0-\u024F]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (n) {
      const list = nameToUser.get(n) || [];
      list.push(u);
      nameToUser.set(n, list);
    }
  }
  return { emailToUser, nameToUser, userById };
}

function reasonMeta(reason: MissingMembershipReason): {
  recommendedAction: string;
} {
  switch (reason) {
    case "in_slack_missing_channel":
      return { recommendedAction: "Ask member to join city channel" };
    case "not_in_slack_workspace":
      return { recommendedAction: "Send Slack joining email" };
    case "slack_identity_unresolved":
      return { recommendedAction: "Review resolver suggestion" };
    case "invalid_or_missing_email":
      return { recommendedAction: "Correct Airtable member data" };
    case "channel_configuration_missing":
      return { recommendedAction: "Fix channel configuration" };
  }
}

async function mapPool<T, R>(
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

export type ChannelScanResult = {
  scannedAt: string;
  channels: ChannelHealthRow[];
  warnings: string[];
  partial: boolean;
};

/**
 * Scan Airtable Slack channels + Members + Slack memberships.
 */
export async function scanChannelMemberships(input?: {
  airtable?: AirtableClient;
  slack?: SlackClient;
  referenceDate?: Date;
  concurrency?: number;
  /** Only fetch membership for active channels + all-members (default true). */
  activeOnlyFetch?: boolean;
}): Promise<ChannelScanResult> {
  const referenceDate = input?.referenceDate ?? new Date();
  const concurrency = input?.concurrency ?? 3;
  const warnings: string[] = [];
  const scannedAt = new Date().toISOString();

  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) throw new Error("Airtable is not configured");
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) throw new Error("SLACK_BOT_TOKEN is not configured");

  const airtable =
    input?.airtable ?? createAirtableClient({ apiKey: token, baseId });
  const slack = input?.slack ?? createSlackClient({ botToken: slackToken });

  let channelRecords: AirtableRecord[] = [];
  try {
    channelRecords = await airtable.listRecords(SLACK_CHANNELS_TABLE, {
      fields: SLACK_CHANNEL_LIST_FIELDS,
    });
  } catch (e) {
    const schema = toAirtableSchemaError(SLACK_CHANNELS_TABLE, e);
    if (schema) throw schema;
    throw e;
  }

  let cityRecords: AirtableRecord[] = [];
  try {
    // Prefer full fetch so primary field works even if labeled differently
    cityRecords = await airtable.listRecords(CITIES_TABLE);
  } catch (e) {
    const schema = toAirtableSchemaError(CITIES_TABLE, e);
    if (schema) throw schema;
    warnings.push(`Cities load failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const cityIdToName = new Map<string, string>();
  for (const c of cityRecords) {
    const name =
      fieldStr(c.fields, CITY_LIST_FIELDS[0]) ||
      fieldStr(c.fields, "Name") ||
      fieldStr(c.fields, "City") ||
      c.id;
    cityIdToName.set(c.id, name);
  }

  let memberRecords: AirtableRecord[] = [];
  try {
    memberRecords = await airtable.listRecords(MEMBERS_TABLE, {
      fields: MEMBER_LIST_FIELDS,
    });
  } catch (e) {
    const schema = toAirtableSchemaError(MEMBERS_TABLE, e);
    if (schema) throw schema;
    throw e;
  }

  const slackUsers = await slack.listUsers();
  const maps = buildSlackMaps(slackUsers);

  type Eligible = {
    record: AirtableRecord;
    name: string;
    email: string;
    slackEmail: string;
    city: string;
    identity: ReturnType<typeof resolveSlackIdentity>;
  };

  type MemberSnap = Eligible & {
    membership: string;
    payment: string;
    serviceAccessUntil: string;
    hasAccess: boolean;
  };

  const allMemberSnaps: MemberSnap[] = [];
  const eligible: Eligible[] = [];
  for (const r of memberRecords) {
    const membership = fieldStr(r.fields, MEMBER_FIELDS.membership);
    const payment = fieldStr(r.fields, MEMBER_FIELDS.payment);
    const until = fieldStr(r.fields, MEMBER_FIELDS.serviceAccessUntil);
    const name = fieldStr(r.fields, MEMBER_FIELDS.name);
    const email = fieldStr(r.fields, MEMBER_FIELDS.email);
    const slackEmail = fieldStr(r.fields, MEMBER_FIELDS.slackEmail);
    const city = fieldStr(r.fields, MEMBER_FIELDS.city);
    const identity = resolveSlackIdentity({
      primaryEmail: email,
      slackEmail,
      name,
      ...maps,
    });
    const hasAccess = hasServiceAccess(
      membership,
      payment,
      until || null,
      referenceDate
    );
    const snap: MemberSnap = {
      record: r,
      name,
      email,
      slackEmail,
      city,
      identity,
      membership,
      payment,
      serviceAccessUntil: until,
      hasAccess,
    };
    allMemberSnaps.push(snap);
    if (hasAccess) eligible.push(snap);
  }

  /** Slack user id → Airtable member snaps (for reverse match) */
  const slackIdToMembers = new Map<string, MemberSnap[]>();
  for (const m of allMemberSnaps) {
    const uid = m.identity.user?.id;
    if (!uid) continue;
    if (
      m.identity.state !== "matched_primary_email" &&
      m.identity.state !== "matched_slack_email"
    ) {
      continue;
    }
    const list = slackIdToMembers.get(uid) || [];
    list.push(m);
    slackIdToMembers.set(uid, list);
  }

  const byCityLower = new Map<string, Eligible[]>();
  for (const m of eligible) {
    const key = m.city.trim().toLowerCase();
    if (!key) continue;
    const list = byCityLower.get(key) || [];
    list.push(m);
    byCityLower.set(key, list);
  }

  const allMembersCfg = getAllMembersChannelConfig();

  type ChannelDef = {
    airtableRecordId: string;
    channelName: string;
    cityNames: string[];
    statusRaw: string;
    statusKind: ChannelStatusKind;
    slackChannelId: string;
    groupSize: string;
    timezone: string;
    schedulingMode: string;
    isAllMembersChannel: boolean;
    expected: Eligible[];
  };

  const defs: ChannelDef[] = [];

  for (const ch of channelRecords) {
    const channelName = fieldStr(ch.fields, SLACK_CHANNEL_FIELDS.name);
    const statusRaw = fieldStr(ch.fields, SLACK_CHANNEL_FIELDS.status);
    const statusKind = classifyChannelStatus(statusRaw);
    const slackChannelId = fieldStr(ch.fields, SLACK_CHANNEL_FIELDS.slackChannelId);
    const groupSize = fieldStr(ch.fields, SLACK_CHANNEL_FIELDS.groupSize);
    const timezone = fieldStr(ch.fields, SLACK_CHANNEL_FIELDS.timezone);
    const schedulingMode = fieldStr(ch.fields, SLACK_CHANNEL_FIELDS.schedulingMode);

    const cityIds = fieldLinkIds(ch.fields, SLACK_CHANNEL_FIELDS.cities);
    const cityNames = cityIds
      .map((id) => cityIdToName.get(id) || "")
      .filter(Boolean);
    // Fallback: if no linked cities resolved, try channel name without emoji prefix
    if (cityNames.length === 0 && channelName) {
      const stripped = channelName.replace(/^[^\p{L}\p{N}]+/u, "").trim();
      if (stripped) cityNames.push(stripped);
    }

    const expectedSet = new Map<string, Eligible>();
    for (const cn of cityNames) {
      for (const m of byCityLower.get(cn.toLowerCase()) || []) {
        expectedSet.set(m.record.id, m);
      }
    }

    defs.push({
      airtableRecordId: ch.id,
      channelName,
      cityNames,
      statusRaw,
      statusKind,
      slackChannelId,
      groupSize,
      timezone,
      schedulingMode,
      isAllMembersChannel: false,
      expected: [...expectedSet.values()],
    });
  }

  // Pin all-members channel
  if (allMembersCfg.id) {
    defs.unshift({
      airtableRecordId: "",
      channelName: allMembersCfg.name || "introductions",
      cityNames: ["(all)"],
      statusRaw: "Active",
      statusKind: "active",
      slackChannelId: allMembersCfg.id,
      groupSize: "",
      timezone: "",
      schedulingMode: "",
      isAllMembersChannel: true,
      expected: eligible,
    });
  } else {
    warnings.push("SLACK_ALL_MEMBERS_CHANNEL_ID is not configured");
  }

  const activeOnlyFetch = input?.activeOnlyFetch !== false;

  const channels = await mapPool(defs, concurrency, async (def) => {
    const base: ChannelHealthRow = {
      key: def.slackChannelId || def.airtableRecordId || def.channelName,
      airtableRecordId: def.airtableRecordId,
      channelName: def.channelName,
      cityNames: def.cityNames,
      statusRaw: def.statusRaw,
      statusKind: def.statusKind,
      slackChannelId: def.slackChannelId,
      groupSize: def.groupSize,
      timezone: def.timezone,
      schedulingMode: def.schedulingMode,
      isAllMembersChannel: def.isAllMembersChannel,
      expectedCount: def.expected.length,
      presentCount: 0,
      missingCount: 0,
      unresolvedCount: 0,
      unexpectedCount: 0,
      scanStatus: "not_scanned",
      scanError: null,
      lastScanned: null,
      present: [],
      missing: [],
      unresolved: [],
      unexpected: [],
    };

    if (!def.slackChannelId) {
      base.scanStatus = "error";
      base.scanError = "Missing Slack Channel ID";
      // All expected become configuration missing
      for (const m of def.expected) {
        const reason: MissingMembershipReason = "channel_configuration_missing";
        base.missing.push({
          airtableRecordId: m.record.id,
          name: m.name,
          primaryEmail: m.email,
          slackEmail: m.slackEmail,
          city: m.city,
          slackUserId: m.identity.user?.id || "",
          slackDisplayName: m.identity.user
            ? m.identity.user.realName || m.identity.user.name
            : "",
          hasCurrentServiceAccess: true,
          identityState: m.identity.state,
          identityMethod: m.identity.state,
          reason,
          recommendedAction: reasonMeta(reason).recommendedAction,
        });
      }
      base.missingCount = base.missing.length;
      return base;
    }

    const shouldFetch =
      !activeOnlyFetch ||
      def.statusKind === "active" ||
      def.isAllMembersChannel;

    if (!shouldFetch) {
      base.scanStatus = "skipped";
      base.expectedCount = def.expected.length;
      return base;
    }

    let memberIds: string[] = [];
    try {
      memberIds = await slack.getConversationMembers(def.slackChannelId);
      base.scanStatus = "ok";
      base.lastScanned = scannedAt;
    } catch (e) {
      base.scanStatus = "error";
      base.scanError = e instanceof Error ? e.message.slice(0, 200) : String(e);
      base.lastScanned = scannedAt;
      return base;
    }

    const inChannel = new Set(memberIds);
    const expectedSlackIds = new Set<string>();

    for (const m of def.expected) {
      const rowBase = {
        airtableRecordId: m.record.id,
        name: m.name,
        primaryEmail: m.email,
        slackEmail: m.slackEmail,
        city: m.city,
        slackUserId: m.identity.user?.id || "",
        slackDisplayName: m.identity.user
          ? m.identity.user.realName || m.identity.user.name
          : "",
        hasCurrentServiceAccess: true,
        identityState: m.identity.state,
        identityMethod: m.identity.state,
      };

      if (!m.email.trim() || !isValidEmail(m.email)) {
        const reason: MissingMembershipReason = "invalid_or_missing_email";
        base.missing.push({
          ...rowBase,
          reason,
          recommendedAction: reasonMeta(reason).recommendedAction,
        });
        continue;
      }

      if (
        m.identity.state === "ambiguous" ||
        m.identity.state === "stale_slack_email" ||
        m.identity.state === "suggested_name"
      ) {
        const reason: MissingMembershipReason = "slack_identity_unresolved";
        base.unresolved.push({
          ...rowBase,
          reason,
          recommendedAction: reasonMeta(reason).recommendedAction,
        });
        continue;
      }

      if (
        m.identity.state === "not_found" ||
        m.identity.state === "deactivated" ||
        !m.identity.user
      ) {
        const reason: MissingMembershipReason = "not_in_slack_workspace";
        base.missing.push({
          ...rowBase,
          reason,
          recommendedAction: reasonMeta(reason).recommendedAction,
        });
        continue;
      }

      expectedSlackIds.add(m.identity.user.id);
      if (inChannel.has(m.identity.user.id)) {
        base.present.push(rowBase);
      } else {
        const reason: MissingMembershipReason = "in_slack_missing_channel";
        base.missing.push({
          ...rowBase,
          reason,
          recommendedAction: reasonMeta(reason).recommendedAction,
        });
      }
    }

    for (const sid of memberIds) {
      if (expectedSlackIds.has(sid)) continue;
      const u = maps.userById.get(sid);
      if (!u) {
        base.unexpected.push({
          slackUserId: sid,
          slackDisplayName: sid,
          slackEmail: "",
          explanation: "Slack user not in workspace user list snapshot",
        });
        continue;
      }
      if (u.isBot || u.isAppUser) continue;
      if (u.deleted) {
        base.unexpected.push({
          slackUserId: sid,
          slackDisplayName: u.realName || u.name,
          slackEmail: u.email || "",
          explanation: "Deactivated Slack user still listed in channel",
        });
        continue;
      }
      base.unexpected.push({
        slackUserId: sid,
        slackDisplayName: u.realName || u.name,
        slackEmail: u.email || "",
        explanation:
          "In channel but not matched to an eligible Airtable member for this city (expired access, other city, or missing Airtable row)",
      });
    }

    // Special all-wlth-wlks population: actual active human membership
    if (def.isAllMembersChannel) {
      const seenIds = new Set<string>();
      let duplicateIds = 0;
      let deletedExcluded = 0;
      let botsAppsExcluded = 0;
      let idsNotInUsersList = 0;
      const humans: AllMembersHumanRow[] = [];

      for (const sid of memberIds) {
        if (seenIds.has(sid)) {
          duplicateIds++;
          continue;
        }
        seenIds.add(sid);
        const u = maps.userById.get(sid);
        if (!u) {
          idsNotInUsersList++;
          continue;
        }
        if (u.deleted) {
          deletedExcluded++;
          continue;
        }
        if (u.isBot || u.isAppUser || u.id === "USLACKBOT") {
          botsAppsExcluded++;
          continue;
        }

        const matches = slackIdToMembers.get(sid) || [];
        let classification: AllMembersPopulationClass = "no_airtable_match";
        let snap: MemberSnap | null = null;
        if (matches.length > 1) {
          classification = "ambiguous_airtable_match";
          snap = matches[0];
        } else if (matches.length === 1) {
          snap = matches[0];
          const until = snap.serviceAccessUntil;
          const untilDate = until ? new Date(until) : null;
          const untilInvalid = Boolean(until && untilDate && Number.isNaN(untilDate.getTime()));
          if (untilInvalid) {
            classification = "invalid_access_data";
          } else if (snap.hasAccess) {
            if (
              snap.membership === "Active" &&
              snap.payment === "Paid"
            ) {
              classification = "current_access";
            } else {
              classification = "grace_period";
            }
          } else {
            classification = "expired";
          }
        }

        humans.push({
          slackUserId: sid,
          slackDisplayName: u.realName || u.name,
          slackEmail: u.email || "",
          classification,
          airtableRecordId: snap?.record.id || "",
          name: snap?.name || "",
          city: snap?.city || "",
          membership: snap?.membership || "",
          payment: snap?.payment || "",
          serviceAccessUntil: snap?.serviceAccessUntil || "",
          hasCurrentServiceAccess: snap?.hasAccess || false,
        });
      }

      const count = (c: AllMembersPopulationClass) =>
        humans.filter((h) => h.classification === c).length;

      const presentCurrentIds = new Set(
        humans
          .filter((h) => h.classification === "current_access" || h.classification === "grace_period")
          .map((h) => h.slackUserId)
      );
      let expectedCurrentAccessMissing = 0;
      for (const m of eligible) {
        const uid = m.identity.user?.id;
        if (
          uid &&
          (m.identity.state === "matched_primary_email" ||
            m.identity.state === "matched_slack_email") &&
          !presentCurrentIds.has(uid) &&
          !inChannel.has(uid)
        ) {
          expectedCurrentAccessMissing++;
        } else if (
          uid &&
          (m.identity.state === "matched_primary_email" ||
            m.identity.state === "matched_slack_email") &&
          !inChannel.has(uid)
        ) {
          expectedCurrentAccessMissing++;
        }
      }

      base.allMembersBreakdown = {
        rawChannelMemberIds: memberIds.length,
        deletedExcluded,
        botsAppsExcluded,
        activeHumansIncluded: humans.length,
        idsNotInUsersList,
        duplicateIds,
        currentAccessPresent: count("current_access"),
        gracePeriodPresent: count("grace_period"),
        expiredPresent: count("expired"),
        invalidAccessData: count("invalid_access_data"),
        unmatchedSlackUsers: count("no_airtable_match"),
        ambiguousMatches: count("ambiguous_airtable_match"),
        expectedCurrentAccessMissing,
        humans,
      };
      // Present count for all-members = actual active humans (not only eligible expected)
      base.presentCount = humans.length;
    } else {
      base.presentCount = base.present.length;
    }

    base.missingCount = base.missing.length;
    base.unresolvedCount = base.unresolved.length;
    base.unexpectedCount = base.unexpected.length;
    return base;
  });

  const partial = warnings.length > 0 || channels.some((c) => c.scanStatus === "error");
  return { scannedAt, channels, warnings, partial };
}
