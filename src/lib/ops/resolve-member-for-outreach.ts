/**
 * Targeted single-member resolver for Slack outreach preview/send.
 * Avoids full workspace scanMemberHealth() for one record.
 */
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createSlackClient, type SlackUser } from "@/lib/integrations/slack";
import {
  CITIES_TABLE,
  MEMBER_FIELDS,
  MEMBER_LIST_FIELDS,
  MEMBERS_TABLE,
  SLACK_CHANNEL_FIELDS,
  SLACK_CHANNEL_LIST_FIELDS,
  SLACK_CHANNELS_TABLE,
  CITY_FIELDS,
  toAirtableSchemaError,
} from "@/lib/ops/airtable-fields";
import {
  buildCityChannelMap,
  buildSlackMaps,
  getAllMembersChannelConfig,
  resolveSlackIdentity,
} from "@/lib/ops/member-health";
import type { MemberHealthRow } from "@/lib/ops/member-health-types";
import { buildMemberHealthRow } from "@/lib/ops/member-issue-classifier";
import { resolveMemberCityChannel } from "@/lib/ops/city-relation-repair";
import { getOutreachCooldownDays } from "@/lib/ops/slack-outreach";
import { db } from "@/db";
import { memberOutreach } from "@/db/schema";
import { and, desc, eq, gte } from "drizzle-orm";

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

export type TargetedMemberTimings = {
  airtableMemberMs: number;
  cityChannelMs: number;
  slackIdentityMs: number;
  cooldownMs: number;
  templateMs: number;
  totalMs: number;
};

export type TargetedMemberResult = {
  member: MemberHealthRow;
  cooldownActive: boolean;
  cooldownLastSentAt: string | null;
  timings: TargetedMemberTimings;
  scanVersion: string;
};

/** Short-lived in-memory cache for channel config snapshots. */
let channelConfigCache: {
  at: number;
  cityChannelMap: Map<string, { channelId: string; channelName: string }>;
  citiesById: Map<string, import("@/lib/integrations/airtable").AirtableRecord>;
  channelsById: Map<string, import("@/lib/integrations/airtable").AirtableRecord>;
} | null = null;

const CHANNEL_CACHE_TTL_MS = 60_000;

async function loadCityChannelConfig(
  airtable: ReturnType<typeof createAirtableClient>
): Promise<{
  cityChannelMap: Map<string, { channelId: string; channelName: string }>;
  citiesById: Map<string, import("@/lib/integrations/airtable").AirtableRecord>;
  channelsById: Map<string, import("@/lib/integrations/airtable").AirtableRecord>;
  ms: number;
}> {
  const t0 = Date.now();
  if (channelConfigCache && Date.now() - channelConfigCache.at < CHANNEL_CACHE_TTL_MS) {
    return { ...channelConfigCache, ms: Date.now() - t0 };
  }
  const [channels, cities] = await Promise.all([
    airtable.listRecords(SLACK_CHANNELS_TABLE, { fields: SLACK_CHANNEL_LIST_FIELDS }),
    airtable.listRecords(CITIES_TABLE),
  ]);
  const citiesById = new Map(cities.map((c) => [c.id, c]));
  const channelsById = new Map(channels.map((c) => [c.id, c]));
  const cityChannelMap = buildCityChannelMap(channels, cities);
  channelConfigCache = {
    at: Date.now(),
    cityChannelMap,
    citiesById,
    channelsById,
  };
  return { cityChannelMap, citiesById, channelsById, ms: Date.now() - t0 };
}

async function lookupSlackUserByEmails(
  slack: ReturnType<typeof createSlackClient>,
  emails: string[]
): Promise<{ users: SlackUser[]; ms: number }> {
  const t0 = Date.now();
  const users: SlackUser[] = [];
  const seen = new Set<string>();
  for (const email of emails) {
    const e = email.trim();
    if (!e || seen.has(e.toLowerCase())) continue;
    seen.add(e.toLowerCase());
    try {
      const hit = await slack.lookupByEmail(e);
      if (hit) {
        users.push({
          id: hit.id,
          email: e,
          name: hit.name,
          realName: hit.name,
          deleted: false,
          isBot: false,
          isAppUser: false,
        });
      }
    } catch {
      /* ignore per-email lookup failures */
    }
  }
  return { users, ms: Date.now() - t0 };
}

/**
 * Resolve one Airtable member for outreach without a full health scan.
 */
export async function resolveMemberForOutreach(
  airtableRecordId: string,
  options?: { checkCooldown?: boolean }
): Promise<TargetedMemberResult> {
  const totalT0 = Date.now();
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) throw new Error("Airtable is not configured");

  const airtable = createAirtableClient({ apiKey: token, baseId });
  const referenceDate = new Date();

  const airT0 = Date.now();
  let record;
  try {
    record = await airtable.getRecord(MEMBERS_TABLE, airtableRecordId);
  } catch (e) {
    const schema = toAirtableSchemaError(MEMBERS_TABLE, e);
    if (schema) throw schema;
    throw e;
  }
  const airtableMemberMs = Date.now() - airT0;

  const { cityChannelMap, citiesById, channelsById, ms: cityChannelMs } =
    await loadCityChannelConfig(airtable);

  const primaryEmail = fieldStr(record.fields, MEMBER_FIELDS.email);
  const slackEmail = fieldStr(record.fields, MEMBER_FIELDS.slackEmail);
  const name = fieldStr(record.fields, MEMBER_FIELDS.name);
  const membership = fieldStr(record.fields, MEMBER_FIELDS.membership);
  const payment = fieldStr(record.fields, MEMBER_FIELDS.payment);
  const serviceAccessUntil = fieldStr(record.fields, MEMBER_FIELDS.serviceAccessUntil);
  const stripeCustomerId = fieldStr(record.fields, MEMBER_FIELDS.stripeCustomerId);
  const dateJoined = fieldStr(record.fields, MEMBER_FIELDS.dateJoined);
  const cancellationDate = fieldStr(record.fields, MEMBER_FIELDS.cancellationDate);

  const cityResolved = resolveMemberCityChannel({
    memberFields: record.fields,
    citiesById,
    channelsById,
    memberCityLinkField: MEMBER_FIELDS.cityRelation,
    memberCityLegacyField: MEMBER_FIELDS.city,
    cityNameField: CITY_FIELDS.city,
    cityChannelsField: CITY_FIELDS.slackChannels,
    channelNameField: SLACK_CHANNEL_FIELDS.name,
    channelStatusField: SLACK_CHANNEL_FIELDS.status,
    channelSlackIdField: SLACK_CHANNEL_FIELDS.slackChannelId,
  });
  const city = cityResolved.cityName || fieldStr(record.fields, MEMBER_FIELDS.city);
  const cityKey = city.toLowerCase();
  const cityChFromName = cityChannelMap.get(cityKey);
  const resolvedSlackChannelId =
    cityResolved.slackChannelId || cityChFromName?.channelId || "";
  const resolvedChannelName =
    cityResolved.channelName || cityChFromName?.channelName || "";

  let slackIdentityMs = 0;
  let identity: ReturnType<typeof resolveSlackIdentity> = {
    state: "not_checked",
    user: null,
    confidence: "none",
  };

  const slackToken = process.env.SLACK_BOT_TOKEN?.trim();
  if (slackToken) {
    const slack = createSlackClient({ botToken: slackToken });
    const emails = [slackEmail, primaryEmail].filter(Boolean);
    const { users, ms } = await lookupSlackUserByEmails(slack, emails);
    slackIdentityMs = ms;
    const maps = buildSlackMaps(users);
    identity = resolveSlackIdentity({
      primaryEmail,
      slackEmail,
      name,
      ...maps,
    });
  }

  const allMembers = getAllMembersChannelConfig();
  const cityChannelConfigured = Boolean(resolvedSlackChannelId);

  const tmplT0 = Date.now();
  const member = buildMemberHealthRow(
    {
      airtableRecordId: record.id,
      name,
      primaryEmail,
      slackEmail,
      city,
      membership,
      payment,
      dateJoined,
      cancellationDate,
      serviceAccessUntil,
      stripeCustomerId,
      stripeCustomerEmail: "",
      latestQualifyingPaidThrough: "",
      recurringIntroStatus: fieldStr(record.fields, MEMBER_FIELDS.recurringIntroStatus),
      recurringPauseUntil: fieldStr(record.fields, MEMBER_FIELDS.recurringPauseUntil),
      introPauseState: "unknown",
      stripeSubscriptionStatus: fieldStr(
        record.fields,
        MEMBER_FIELDS.stripeSubscriptionStatus
      ),
      billingPauseUntil: fieldStr(record.fields, MEMBER_FIELDS.billingPauseUntil),
      activeSlackUserId: identity.user?.id || "",
      activeSlackEmail: identity.user?.email || "",
      activeSlackDisplayName: identity.user
        ? identity.user.realName || identity.user.name
        : "",
      slackIdentityState: identity.state,
      cityChannelId: resolvedSlackChannelId,
      cityChannelName: resolvedChannelName,
      cityChannelMembership: "not_checked",
      allMembersChannelId: allMembers.id,
      allMembersChannelMembership: "not_checked",
      resolverConfidence: identity.confidence,
      stripeOnly: false,
    },
    {
      airtableRecordId: record.id,
      name,
      primaryEmail,
      slackEmail,
      city,
      membership,
      payment,
      serviceAccessUntil,
      stripeCustomerId,
      airtableEmailCount: 1,
      stripeIdAirtableCount: 1,
      slackIdentityState: identity.state,
      cityChannelMembership: "not_checked",
      allMembersChannelMembership: "not_checked",
      cityChannelConfigured,
      referenceDate,
      billingChecked: false,
      stripeOnly: false,
    }
  );
  const templateMs = Date.now() - tmplT0;

  let cooldownMs = 0;
  let cooldownActive = false;
  let cooldownLastSentAt: string | null = null;
  if (options?.checkCooldown !== false) {
    const cT0 = Date.now();
    try {
      const cooldownDays = getOutreachCooldownDays();
      const cooldownSince = new Date(Date.now() - cooldownDays * 86400000);
      const recent = await db
        .select()
        .from(memberOutreach)
        .where(
          and(
            eq(memberOutreach.airtableRecordId, airtableRecordId),
            eq(memberOutreach.outreachType, "slack_join"),
            eq(memberOutreach.status, "sent"),
            gte(memberOutreach.createdAt, cooldownSince)
          )
        )
        .orderBy(desc(memberOutreach.createdAt))
        .limit(1);
      if (recent.length > 0) {
        cooldownActive = true;
        cooldownLastSentAt =
          recent[0].sentAt?.toISOString() || recent[0].createdAt.toISOString();
      }
    } catch {
      /* table may be missing */
    }
    cooldownMs = Date.now() - cT0;
  }

  const timings: TargetedMemberTimings = {
    airtableMemberMs,
    cityChannelMs,
    slackIdentityMs,
    cooldownMs,
    templateMs,
    totalMs: Date.now() - totalT0,
  };

  console.info(
    "[slack-email] targeted resolve",
    JSON.stringify({
      airtableRecordId,
      timings,
      // never log credentials
    })
  );

  return {
    member,
    cooldownActive,
    cooldownLastSentAt,
    timings,
    scanVersion: `targeted:${record.id}:${Math.floor(Date.now() / 30_000)}`,
  };
}

/** Ensure MEMBER_LIST_FIELDS reference stays used for consistency checks in tests. */
export const TARGETED_MEMBER_FIELDS = MEMBER_LIST_FIELDS;
