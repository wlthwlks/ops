/**
 * Server-side member health aggregation.
 * Loads Airtable (+ optional Slack) once and builds maps — no N+1.
 * Full Stripe billing scan is separate and opt-in.
 */
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import type { SlackClient, SlackUser } from "@/lib/integrations/slack";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createSlackClient } from "@/lib/integrations/slack";
import {
  type ChannelMembershipState,
  type IntegrationHealth,
  type MemberHealthRow,
  type MemberHealthScanResult,
  type MemberHealthSummary,
  type SlackIdentityState,
} from "@/lib/ops/member-health-types";
import {
  buildMemberHealthRow,
  normalizeMemberEmail,
} from "@/lib/ops/member-issue-classifier";
import { isValidEmail } from "@/lib/billing/reconcile-stripe-customers";
import { getIntroductionsMode } from "@/lib/introduction/runtime-mode";
import { STRIPE_CUSTOMER_ID_FIELD } from "@/lib/billing/service-access-sync";
import {
  CITIES_TABLE,
  CITY_FIELDS,
  MEMBER_FIELDS,
  MEMBER_LIST_FIELDS,
  MEMBERS_TABLE,
  SLACK_CHANNEL_FIELDS,
  SLACK_CHANNEL_LIST_FIELDS,
  SLACK_CHANNELS_TABLE,
  toAirtableSchemaError,
} from "@/lib/ops/airtable-fields";
import {
  conditionMessage,
  resolveMemberCityChannel,
} from "@/lib/ops/city-relation-repair";
import type { CityLinkCondition } from "@/lib/ops/city-relation-types";

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

function envConfigured(...keys: string[]): boolean {
  return keys.every((k) => Boolean(process.env[k]?.trim()));
}

export function getAllMembersChannelConfig(): {
  id: string;
  name: string;
} {
  return {
    id: (process.env.SLACK_ALL_MEMBERS_CHANNEL_ID || "").trim(),
    name: (process.env.SLACK_ALL_MEMBERS_CHANNEL_NAME || "all-wlth-wlks").trim(),
  };
}

export function buildSlackChannelUrl(channelId: string): string | null {
  const workspace = (process.env.SLACK_WORKSPACE_URL || "").trim().replace(/\/$/, "");
  if (!workspace || !channelId) return null;
  // Prefer deep link form if workspace is a slack.com URL
  if (workspace.includes("slack.com")) {
    return `${workspace}/archives/${channelId}`;
  }
  return `${workspace}/archives/${channelId}`;
}

export function getSlackInviteUrl(): string {
  return (
    process.env.SLACK_WORKSPACE_INVITE_URL?.trim() ||
    process.env.SLACK_JOIN_URL?.trim() ||
    ""
  );
}

/**
 * Resolve Slack identity for one member against pre-built maps.
 */
export function resolveSlackIdentity(input: {
  primaryEmail: string;
  slackEmail: string;
  name: string;
  emailToUser: Map<string, SlackUser[]>;
  nameToUser: Map<string, SlackUser[]>;
  userById: Map<string, SlackUser>;
}): {
  state: SlackIdentityState;
  user: SlackUser | null;
  confidence: "high" | "low" | "none";
} {
  const { primaryEmail, slackEmail, name, emailToUser, nameToUser } = input;

  const slackEmailNorm = slackEmail ? normalizeMemberEmail(slackEmail) : "";
  const primaryNorm = primaryEmail ? normalizeMemberEmail(primaryEmail) : "";

  if (slackEmailNorm) {
    const hits = emailToUser.get(slackEmailNorm) || [];
    const active = hits.filter((u) => !u.deleted && !u.isBot && !u.isAppUser);
    if (active.length === 1) {
      return { state: "matched_slack_email", user: active[0], confidence: "high" };
    }
    if (hits.some((u) => u.deleted)) {
      return { state: "deactivated", user: hits[0], confidence: "none" };
    }
    if (active.length === 0) {
      return { state: "stale_slack_email", user: null, confidence: "none" };
    }
  }

  if (primaryNorm) {
    const hits = emailToUser.get(primaryNorm) || [];
    const active = hits.filter((u) => !u.deleted && !u.isBot && !u.isAppUser);
    if (active.length === 1) {
      return { state: "matched_primary_email", user: active[0], confidence: "high" };
    }
    if (hits.some((u) => u.deleted) && active.length === 0) {
      return { state: "deactivated", user: hits[0], confidence: "none" };
    }
  }

  const normName = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normName) {
    const byName = (nameToUser.get(normName) || []).filter(
      (u) => !u.deleted && !u.isBot && !u.isAppUser
    );
    if (byName.length === 1) {
      return { state: "suggested_name", user: byName[0], confidence: "low" };
    }
    if (byName.length > 1) {
      return { state: "ambiguous", user: null, confidence: "none" };
    }
  }

  return { state: "not_found", user: null, confidence: "none" };
}

export function buildSlackMaps(users: SlackUser[]) {
  const emailToUser = new Map<string, SlackUser[]>();
  const nameToUser = new Map<string, SlackUser[]>();
  const userById = new Map<string, SlackUser>();
  for (const u of users) {
    userById.set(u.id, u);
    if (u.email) {
      const e = normalizeMemberEmail(u.email);
      const list = emailToUser.get(e) || [];
      list.push(u);
      emailToUser.set(e, list);
    }
    const n = (u.realName || u.name || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
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

/** Map city name → slack channel id from Airtable Slack channels + Cities. */
export function buildCityChannelMap(
  channelRecords: AirtableRecord[],
  cityRecords: AirtableRecord[]
): Map<string, { channelId: string; channelName: string }> {
  const cityIdToName = new Map<string, string>();
  for (const c of cityRecords) {
    const name =
      fieldStr(c.fields, "City") ||
      fieldStr(c.fields, "Name") ||
      fieldStr(c.fields, "name");
    if (name) cityIdToName.set(c.id, name);
  }

  const map = new Map<string, { channelId: string; channelName: string }>();
  for (const ch of channelRecords) {
    const channelId = fieldStr(ch.fields, SLACK_CHANNEL_FIELDS.slackChannelId);
    const channelName = fieldStr(ch.fields, SLACK_CHANNEL_FIELDS.name);
    const status = fieldStr(ch.fields, SLACK_CHANNEL_FIELDS.status);
    if (!channelId) continue;
    if (status && /closed|inactive|archived|disabled/i.test(status)) continue;

    // Linked city records live on "Cities" only (not "City")
    const cityLinks = ch.fields[SLACK_CHANNEL_FIELDS.cities];
    const linkIds = Array.isArray(cityLinks)
      ? cityLinks.map(String)
      : cityLinks
        ? [String(cityLinks)]
        : [];

    if (linkIds.length > 0) {
      for (const cid of linkIds) {
        const cityName = cityIdToName.get(cid);
        if (cityName) {
          map.set(cityName.toLowerCase(), { channelId, channelName });
        }
      }
    } else if (channelName) {
      const stripped = channelName.replace(/^[^\p{L}\p{N}]+/u, "").trim();
      if (stripped) map.set(stripped.toLowerCase(), { channelId, channelName });
    }
  }
  return map;
}

export type ScanOptions = {
  includeSlack?: boolean;
  includeChannelMembership?: boolean;
  airtable?: AirtableClient;
  slack?: SlackClient;
  referenceDate?: Date;
};

export async function scanMemberHealth(
  options: ScanOptions = {}
): Promise<MemberHealthScanResult> {
  const includeSlack = options.includeSlack !== false;
  const includeChannels = options.includeChannelMembership === true;
  const referenceDate = options.referenceDate ?? new Date();
  const warnings: string[] = [];
  const integrations: IntegrationHealth[] = [];

  let mode = "read_only";
  try {
    mode = getIntroductionsMode();
  } catch (e) {
    warnings.push(e instanceof Error ? e.message : "Invalid INTRODUCTIONS_MODE");
  }

  // Config checks (configured ≠ healthy)
  const airtableConfigured = envConfigured("AIRTABLE_GET_DATA_TOKEN", "AIRTABLE_BASE_ID");
  const slackConfigured = envConfigured("SLACK_BOT_TOKEN");
  const stripeConfigured = envConfigured("STRIPE_SECRET_KEY", "STRIPE_MEMBERSHIP_PRICE_IDS");
  const resendConfigured = envConfigured("RESEND_API_KEY", "RESEND_FROM_EMAIL");
  const postgresConfigured = envConfigured("POSTGRES_URL") || envConfigured("POSTGRES_URL_NON_POOLING");

  integrations.push({
    name: "Runtime mode",
    status: mode === "live" ? "warning" : "healthy",
    configured: true,
    checked: true,
    message: mode === "live" ? "LIVE — mutations can write and send" : "read_only — safe default",
  });

  if (!airtableConfigured) {
    integrations.push({
      name: "Airtable",
      status: "not_configured",
      configured: false,
      checked: false,
      message: "AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID missing",
    });
    throw new Error("Airtable is not configured");
  }

  const airtable =
    options.airtable ??
    createAirtableClient({
      apiKey: process.env.AIRTABLE_GET_DATA_TOKEN!,
      baseId: process.env.AIRTABLE_BASE_ID!,
    });

  let memberRecords: AirtableRecord[] = [];
  try {
    try {
      memberRecords = await airtable.listRecords(MEMBERS_TABLE, {
        fields: MEMBER_LIST_FIELDS,
      });
    } catch (e) {
      // City relation linked field may not exist until migration
      const schema = toAirtableSchemaError(MEMBERS_TABLE, e);
      if (schema?.field === MEMBER_FIELDS.cityRelation) {
        warnings.push(
          `Members."${MEMBER_FIELDS.cityRelation}" missing — using legacy City only. Create linked field or run city-relation repair.`
        );
        const withoutLink = MEMBER_LIST_FIELDS.filter(
          (f) => f !== MEMBER_FIELDS.cityRelation
        );
        memberRecords = await airtable.listRecords(MEMBERS_TABLE, {
          fields: withoutLink,
        });
      } else {
        throw e;
      }
    }
    integrations.push({
      name: "Airtable",
      status: "healthy",
      configured: true,
      checked: true,
      message: `Loaded ${memberRecords.length} Members`,
    });
  } catch (e) {
    const schema = toAirtableSchemaError(MEMBERS_TABLE, e);
    integrations.push({
      name: "Airtable",
      status: "error",
      configured: true,
      checked: true,
      message: schema
        ? `${schema.message} (table=${schema.table})`
        : e instanceof Error
          ? e.message.slice(0, 120)
          : "Airtable error",
    });
    if (schema) throw schema;
    throw e;
  }

  integrations.push({
    name: "Stripe",
    status: stripeConfigured ? "not_checked" : "not_configured",
    configured: stripeConfigured,
    checked: false,
    message: stripeConfigured
      ? "Configured — run Billing Integrity scan for invoice checks"
      : "STRIPE_SECRET_KEY / STRIPE_MEMBERSHIP_PRICE_IDS missing",
  });
  integrations.push({
    name: "Resend",
    status: resendConfigured ? "not_checked" : "not_configured",
    configured: resendConfigured,
    checked: false,
    message: resendConfigured ? "Configured (not probed)" : "RESEND_API_KEY / RESEND_FROM_EMAIL missing",
  });
  integrations.push({
    name: "Postgres",
    status: postgresConfigured ? "not_checked" : "not_configured",
    configured: postgresConfigured,
    checked: false,
    message: postgresConfigured ? "Configured (not probed)" : "POSTGRES_URL missing",
  });

  // Email / stripe id frequency maps
  const emailCounts = new Map<string, number>();
  const stripeIdCounts = new Map<string, number>();
  for (const r of memberRecords) {
    const email = fieldStr(r.fields, "email");
    if (email) {
      const n = normalizeMemberEmail(email);
      emailCounts.set(n, (emailCounts.get(n) || 0) + 1);
    }
    const cus = fieldStr(r.fields, STRIPE_CUSTOMER_ID_FIELD);
    if (cus.startsWith("cus_")) {
      stripeIdCounts.set(cus, (stripeIdCounts.get(cus) || 0) + 1);
    }
  }

  // Slack
  let slackMaps = buildSlackMaps([]);
  let slackUsers: SlackUser[] = [];
  if (includeSlack && slackConfigured) {
    try {
      const slack =
        options.slack ??
        createSlackClient({ botToken: process.env.SLACK_BOT_TOKEN! });
      slackUsers = await slack.listUsers();
      slackMaps = buildSlackMaps(slackUsers);
      integrations.push({
        name: "Slack",
        status: "healthy",
        configured: true,
        checked: true,
        message: `Loaded ${slackUsers.length} workspace users`,
      });
    } catch (e) {
      warnings.push(`Slack load failed: ${e instanceof Error ? e.message : String(e)}`);
      integrations.push({
        name: "Slack",
        status: "error",
        configured: true,
        checked: true,
        message: e instanceof Error ? e.message.slice(0, 120) : "Slack error",
      });
    }
  } else {
    integrations.push({
      name: "Slack",
      status: slackConfigured ? "not_checked" : "not_configured",
      configured: slackConfigured,
      checked: false,
      message: slackConfigured ? "Skipped (includeSlack=false)" : "SLACK_BOT_TOKEN missing",
    });
  }

  // Cities + Slack channels (linked-record model: Member → City → Channel)
  let cityChannelMap = new Map<string, { channelId: string; channelName: string }>();
  const citiesById = new Map<string, AirtableRecord>();
  const channelsById = new Map<string, AirtableRecord>();
  try {
    const [channels, cities] = await Promise.all([
      airtable.listRecords(SLACK_CHANNELS_TABLE, {
        fields: SLACK_CHANNEL_LIST_FIELDS,
      }),
      airtable.listRecords(CITIES_TABLE),
    ]);
    for (const c of cities) citiesById.set(c.id, c);
    for (const ch of channels) channelsById.set(ch.id, ch);
    cityChannelMap = buildCityChannelMap(channels, cities);
  } catch (e) {
    const schema =
      toAirtableSchemaError(SLACK_CHANNELS_TABLE, e) ||
      toAirtableSchemaError(CITIES_TABLE, e);
    warnings.push(
      schema
        ? schema.message
        : `City/channel config load failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const allMembers = getAllMembersChannelConfig();

  // Channel membership sets (optional — expensive)
  const channelMemberSets = new Map<string, Set<string>>();
  if (includeChannels && slackConfigured) {
    try {
      const slackForChannels =
        options.slack ??
        createSlackClient({ botToken: process.env.SLACK_BOT_TOKEN! });
      const ids = new Set<string>();
      for (const v of cityChannelMap.values()) ids.add(v.channelId);
      if (allMembers.id) ids.add(allMembers.id);
      for (const id of ids) {
        try {
          const chMembers = await slackForChannels.getConversationMembers(id);
          channelMemberSets.set(id, new Set(chMembers));
        } catch {
          channelMemberSets.set(id, new Set());
          warnings.push(`Could not list members for channel ${id}`);
        }
      }
    } catch (e) {
      warnings.push(
        `Channel membership load failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  const members: MemberHealthRow[] = [];

  for (const r of memberRecords) {
    const primaryEmail = fieldStr(r.fields, MEMBER_FIELDS.email);
    const slackEmail = fieldStr(r.fields, MEMBER_FIELDS.slackEmail);
    const name = fieldStr(r.fields, MEMBER_FIELDS.name);
    const membership = fieldStr(r.fields, MEMBER_FIELDS.membership);
    const payment = fieldStr(r.fields, MEMBER_FIELDS.payment);
    const serviceAccessUntil = fieldStr(r.fields, MEMBER_FIELDS.serviceAccessUntil);
    const stripeCustomerId = fieldStr(r.fields, MEMBER_FIELDS.stripeCustomerId);
    const dateJoined = fieldStr(r.fields, MEMBER_FIELDS.dateJoined);
    const cancellationDate = fieldStr(r.fields, MEMBER_FIELDS.cancellationDate);

    const cityResolved = resolveMemberCityChannel({
      memberFields: r.fields,
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
    const city = cityResolved.cityName || fieldStr(r.fields, MEMBER_FIELDS.city);
    const cityLinkCondition: CityLinkCondition = cityResolved.condition;

    const identity = includeSlack
      ? resolveSlackIdentity({
          primaryEmail,
          slackEmail,
          name,
          ...slackMaps,
        })
      : { state: "not_checked" as const, user: null, confidence: "none" as const };

    // Prefer linked City → Channel; fall back to name map from buildCityChannelMap
    const cityKey = city.toLowerCase();
    const cityChFromName = cityChannelMap.get(cityKey);
    const resolvedSlackChannelId =
      cityResolved.slackChannelId || cityChFromName?.channelId || "";
    const resolvedChannelName =
      cityResolved.channelName || cityChFromName?.channelName || "";

    // Urgent misconfiguration only for missing link or Active missing ID — not Paused/Closed
    const cityChannelConfigured =
      cityLinkCondition === "ACTIVE_CHANNEL_READY" ||
      cityLinkCondition === "VIRTUAL_FALLBACK_CHANNEL" ||
      cityLinkCondition === "CITY_CHANNEL_PAUSED" ||
      cityLinkCondition === "CITY_CHANNEL_CLOSED" ||
      Boolean(resolvedSlackChannelId);

    let cityChannelMembership: ChannelMembershipState = "not_checked";
    let allMembersChannelMembership: ChannelMembershipState = "not_checked";

    if (!city.trim()) {
      cityChannelMembership = "not_configured";
    } else if (
      cityLinkCondition === "CITY_SLACK_CHANNEL_LINK_MISSING" ||
      cityLinkCondition === "ACTIVE_CHANNEL_MISSING_SLACK_ID" ||
      cityLinkCondition === "MEMBER_CITY_LINK_MISSING" ||
      cityLinkCondition === "MEMBER_CITY_VALUE_UNRESOLVED"
    ) {
      cityChannelMembership = "not_configured";
    } else if (
      cityLinkCondition === "CITY_CHANNEL_PAUSED" ||
      cityLinkCondition === "CITY_CHANNEL_CLOSED"
    ) {
      // Not an urgent config error — membership check skipped without ID
      cityChannelMembership = resolvedSlackChannelId ? "not_checked" : "not_configured";
    } else if (includeChannels && identity.user && resolvedSlackChannelId) {
      const set = channelMemberSets.get(resolvedSlackChannelId);
      cityChannelMembership = set
        ? set.has(identity.user.id)
          ? "member"
          : "not_member"
        : "error";
    }

    if (!allMembers.id) {
      allMembersChannelMembership = "not_configured";
    } else if (includeChannels && identity.user) {
      const set = channelMemberSets.get(allMembers.id);
      allMembersChannelMembership = set
        ? set.has(identity.user.id)
          ? "member"
          : "not_member"
        : "error";
    }

    const emailNorm = primaryEmail ? normalizeMemberEmail(primaryEmail) : "";
    const row = buildMemberHealthRow(
      {
        airtableRecordId: r.id,
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
        activeSlackUserId: identity.user?.id || "",
        activeSlackEmail: identity.user?.email || "",
        activeSlackDisplayName: identity.user
          ? identity.user.realName || identity.user.name
          : "",
        slackIdentityState: identity.state,
        cityChannelId: resolvedSlackChannelId,
        cityChannelName: resolvedChannelName,
        cityChannelMembership,
        allMembersChannelId: allMembers.id,
        allMembersChannelMembership,
        resolverConfidence: identity.confidence,
        stripeOnly: false,
      },
      {
        airtableRecordId: r.id,
        name,
        primaryEmail,
        slackEmail,
        city,
        membership,
        payment,
        serviceAccessUntil,
        stripeCustomerId,
        airtableEmailCount: emailNorm ? emailCounts.get(emailNorm) || 1 : 1,
        stripeIdAirtableCount: stripeCustomerId.startsWith("cus_")
          ? stripeIdCounts.get(stripeCustomerId) || 1
          : 0,
        slackIdentityState: identity.state,
        cityChannelMembership,
        allMembersChannelMembership,
        // false only for true gaps — Paused/Closed are configured relationships
        cityChannelConfigured:
          cityLinkCondition === "ACTIVE_CHANNEL_READY" ||
          cityLinkCondition === "VIRTUAL_FALLBACK_CHANNEL" ||
          cityLinkCondition === "CITY_CHANNEL_PAUSED" ||
          cityLinkCondition === "CITY_CHANNEL_CLOSED" ||
          (Boolean(resolvedSlackChannelId) &&
            cityLinkCondition !== "ACTIVE_CHANNEL_MISSING_SLACK_ID" &&
            cityLinkCondition !== "CITY_SLACK_CHANNEL_LINK_MISSING"),
        referenceDate,
        billingChecked: false,
        stripeOnly: false,
      }
    );

    // Prefer specific city-link guidance over generic config text
    if (
      row.hasCurrentServiceAccess &&
      (cityLinkCondition === "MEMBER_CITY_LINK_MISSING" ||
        cityLinkCondition === "MEMBER_CITY_VALUE_UNRESOLVED" ||
        cityLinkCondition === "CITY_SLACK_CHANNEL_LINK_MISSING" ||
        cityLinkCondition === "ACTIVE_CHANNEL_MISSING_SLACK_ID" ||
        cityLinkCondition === "LEGACY_CITY_FALLBACK")
    ) {
      row.recommendedNextAction = conditionMessage(cityLinkCondition);
      // Downgrade paused/closed: strip CITY_CHANNEL_NOT_CONFIGURED if present from paused
    }
    if (
      cityLinkCondition === "CITY_CHANNEL_PAUSED" ||
      cityLinkCondition === "CITY_CHANNEL_CLOSED"
    ) {
      row.issues = row.issues.filter((i) => i.code !== "CITY_CHANNEL_NOT_CONFIGURED");
      if (!row.issues.some((i) => i.severity !== "info")) {
        row.highestSeverity =
          row.issues.length > 0
            ? row.issues.sort((a, b) =>
                a.severity === "info" ? 1 : b.severity === "info" ? -1 : 0
              )[0]?.severity ?? null
            : null;
      }
      row.recommendedNextAction = conditionMessage(cityLinkCondition);
    }

    members.push(row);
  }

  const summary = summariseHealth(members, [], {
    scannedAt: new Date().toISOString(),
    referenceDate: referenceDate.toISOString(),
    totalAirtableMembers: memberRecords.length,
    integrations,
    mode,
    partial: warnings.length > 0 || !includeChannels,
    warnings,
  });

  return {
    summary,
    members,
    orphanStripeCustomers: [],
  };
}

export function summariseHealth(
  members: MemberHealthRow[],
  orphans: MemberHealthRow[],
  meta: {
    scannedAt: string;
    referenceDate: string;
    totalAirtableMembers: number;
    integrations: IntegrationHealth[];
    mode: string;
    partial: boolean;
    warnings: string[];
  }
): MemberHealthSummary {
  const withServiceAccess = members.filter((m) => m.hasCurrentServiceAccess).length;
  const fullyConnected = members.filter((m) =>
    m.issues.some((i) => i.code === "FULLY_CONNECTED")
  ).length;
  const payingMissingSlack = members.filter((m) =>
    m.issues.some((i) => i.code === "SERVICE_ELIGIBLE_MEMBER_NOT_IN_SLACK")
  ).length;
  const missingStripeCustomerId = members.filter((m) =>
    m.issues.some((i) => i.code === "AIRTABLE_MEMBER_MISSING_STRIPE_CUSTOMER_ID")
  ).length;
  let criticalIssues = 0;
  let highIssues = 0;
  let mediumIssues = 0;
  let channelGaps = 0;
  const issuesByCode: Record<string, number> = {};
  const issuesByCity: Record<string, number> = {};

  const all = [...members, ...orphans];
  for (const m of all) {
    for (const issue of m.issues) {
      if (issue.severity === "info") continue;
      issuesByCode[issue.code] = (issuesByCode[issue.code] || 0) + 1;
      if (issue.severity === "critical") criticalIssues++;
      if (issue.severity === "high") highIssues++;
      if (issue.severity === "medium") mediumIssues++;
      if (
        issue.code === "MEMBER_NOT_IN_CITY_CHANNEL" ||
        issue.code === "MEMBER_NOT_IN_ALL_MEMBERS_CHANNEL"
      ) {
        channelGaps++;
      }
      const city = m.city || "(no city)";
      issuesByCity[city] = (issuesByCity[city] || 0) + 1;
    }
  }

  return {
    scannedAt: meta.scannedAt,
    referenceDate: meta.referenceDate,
    totalAirtableMembers: meta.totalAirtableMembers,
    withServiceAccess,
    fullyConnected,
    payingMissingSlack,
    payingStripeMissingAirtable: orphans.length,
    missingStripeCustomerId,
    criticalIssues,
    highIssues,
    mediumIssues,
    channelGaps,
    issuesByCode,
    issuesByCity,
    integrations: meta.integrations,
    mode: meta.mode,
    partial: meta.partial,
    warnings: meta.warnings,
  };
}

export type MemberFilterQuery = {
  q?: string;
  city?: string;
  cities?: string[];
  membership?: string;
  payment?: string;
  severity?: string;
  issueCode?: string;
  serviceAccess?: string;
  needsAction?: boolean;
  missingSlack?: boolean;
  missingStripeId?: boolean;
  slackIdentityUnresolved?: boolean;
  missingCityChannel?: boolean;
  missingAllMembers?: boolean;
  criticalIssues?: boolean;
  gracePeriod?: boolean;
  expiredStillInSlack?: boolean;
  stripeConflict?: boolean;
  duplicateStripe?: boolean;
  actionableOnly?: boolean;
  informationalOnly?: boolean;
  accessEndingDays?: number;
  dateJoinedFrom?: string;
  dateJoinedTo?: string;
  cancellationFrom?: string;
  cancellationTo?: string;
  slackIdentityState?: string;
};

function isGracePeriod(m: MemberHealthRow): boolean {
  return (
    m.hasCurrentServiceAccess &&
    (m.membership !== "Active" || m.payment !== "Paid") &&
    Boolean(m.serviceAccessUntil)
  );
}

function parseDateMs(value: string): number | null {
  if (!value?.trim()) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

export function filterMembers(
  members: MemberHealthRow[],
  query: MemberFilterQuery
): MemberHealthRow[] {
  let list = members;
  if (query.needsAction) {
    list = list.filter((m) => m.highestSeverity && m.highestSeverity !== "info");
  }
  if (query.actionableOnly) {
    list = list.filter((m) => m.issues.some((i) => i.severity !== "info"));
  }
  if (query.informationalOnly) {
    list = list.filter(
      (m) =>
        m.issues.length > 0 &&
        m.issues.every((i) => i.severity === "info")
    );
  }
  if (query.missingSlack) {
    list = list.filter((m) =>
      m.issues.some((i) => i.code === "SERVICE_ELIGIBLE_MEMBER_NOT_IN_SLACK")
    );
  }
  if (query.missingStripeId) {
    list = list.filter((m) =>
      m.issues.some((i) => i.code === "AIRTABLE_MEMBER_MISSING_STRIPE_CUSTOMER_ID")
    );
  }
  if (query.slackIdentityUnresolved) {
    list = list.filter((m) =>
      ["ambiguous", "stale_slack_email", "not_found", "suggested_name", "deactivated"].includes(
        m.slackIdentityState
      )
    );
  }
  if (query.missingCityChannel) {
    list = list.filter((m) =>
      m.issues.some((i) => i.code === "MEMBER_NOT_IN_CITY_CHANNEL")
    );
  }
  if (query.missingAllMembers) {
    list = list.filter((m) =>
      m.issues.some((i) => i.code === "MEMBER_NOT_IN_ALL_MEMBERS_CHANNEL")
    );
  }
  if (query.criticalIssues) {
    list = list.filter((m) => m.highestSeverity === "critical");
  }
  if (query.gracePeriod) {
    list = list.filter(isGracePeriod);
  }
  if (query.expiredStillInSlack) {
    list = list.filter((m) =>
      m.issues.some((i) => i.code === "EXPIRED_MEMBER_STILL_IN_SLACK_WORKSPACE")
    );
  }
  if (query.stripeConflict) {
    list = list.filter((m) =>
      m.issues.some((i) =>
        [
          "STRIPE_CUSTOMER_ID_CONFLICT",
          "MULTIPLE_STRIPE_CUSTOMERS_FOR_EMAIL",
          "STRIPE_CUSTOMER_ASSIGNED_TO_MULTIPLE_AIRTABLE_RECORDS",
        ].includes(i.code)
      )
    );
  }
  if (query.duplicateStripe) {
    list = list.filter((m) =>
      m.issues.some((i) => i.code === "STRIPE_CUSTOMER_ASSIGNED_TO_MULTIPLE_AIRTABLE_RECORDS")
    );
  }
  if (query.city) {
    const c = query.city.toLowerCase();
    list = list.filter((m) => m.city.toLowerCase() === c);
  }
  if (query.cities && query.cities.length > 0) {
    const set = new Set(query.cities.map((c) => c.toLowerCase()));
    list = list.filter((m) => set.has(m.city.toLowerCase()));
  }
  if (query.membership) {
    list = list.filter(
      (m) => m.membership.toLowerCase() === query.membership!.toLowerCase()
    );
  }
  if (query.payment) {
    list = list.filter((m) => m.payment.toLowerCase() === query.payment!.toLowerCase());
  }
  if (query.severity) {
    list = list.filter((m) => m.highestSeverity === query.severity);
  }
  if (query.issueCode) {
    list = list.filter((m) => m.issues.some((i) => i.code === query.issueCode));
  }
  if (query.slackIdentityState) {
    list = list.filter((m) => m.slackIdentityState === query.slackIdentityState);
  }
  if (query.serviceAccess === "current") {
    list = list.filter((m) => m.hasCurrentServiceAccess);
  } else if (query.serviceAccess === "expired") {
    list = list.filter((m) => !m.hasCurrentServiceAccess);
  } else if (query.serviceAccess === "grace") {
    list = list.filter(isGracePeriod);
  } else if (query.serviceAccess === "invalid_date") {
    list = list.filter((m) =>
      m.issues.some((i) => i.code === "INVALID_SERVICE_ACCESS_DATE")
    );
  }
  if (query.accessEndingDays && query.accessEndingDays > 0) {
    const now = Date.now();
    const horizon = now + query.accessEndingDays * 86400000;
    list = list.filter((m) => {
      const t = parseDateMs(m.serviceAccessUntil);
      if (t == null) return false;
      return t >= now && t <= horizon && m.hasCurrentServiceAccess;
    });
  }
  if (query.dateJoinedFrom) {
    const from = parseDateMs(query.dateJoinedFrom);
    if (from != null) {
      list = list.filter((m) => {
        const t = parseDateMs(m.dateJoined);
        return t != null && t >= from;
      });
    }
  }
  if (query.dateJoinedTo) {
    const to = parseDateMs(query.dateJoinedTo);
    if (to != null) {
      list = list.filter((m) => {
        const t = parseDateMs(m.dateJoined);
        return t != null && t <= to;
      });
    }
  }
  if (query.cancellationFrom) {
    const from = parseDateMs(query.cancellationFrom);
    if (from != null) {
      list = list.filter((m) => {
        const t = parseDateMs(m.cancellationDate);
        return t != null && t >= from;
      });
    }
  }
  if (query.cancellationTo) {
    const to = parseDateMs(query.cancellationTo);
    if (to != null) {
      list = list.filter((m) => {
        const t = parseDateMs(m.cancellationDate);
        return t != null && t <= to;
      });
    }
  }
  if (query.q) {
    const q = query.q.toLowerCase();
    list = list.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.primaryEmail.toLowerCase().includes(q) ||
        m.slackEmail.toLowerCase().includes(q) ||
        m.stripeCustomerId.toLowerCase().includes(q) ||
        m.activeSlackUserId.toLowerCase().includes(q) ||
        (m.airtableRecordId || "").toLowerCase().includes(q)
    );
  }
  return list;
}

/** Distinct filter option metadata from a full member list (not a page slice). */
export function buildMemberFilterOptions(members: MemberHealthRow[]): {
  cities: string[];
  memberships: string[];
  payments: string[];
  issueCodes: string[];
  slackIdentityStates: string[];
} {
  const cities = new Set<string>();
  const memberships = new Set<string>();
  const payments = new Set<string>();
  const issueCodes = new Set<string>();
  const slackIdentityStates = new Set<string>();
  for (const m of members) {
    if (m.city.trim()) cities.add(m.city);
    if (m.membership.trim()) memberships.add(m.membership);
    if (m.payment.trim()) payments.add(m.payment);
    slackIdentityStates.add(m.slackIdentityState);
    for (const i of m.issues) issueCodes.add(i.code);
  }
  return {
    cities: [...cities].sort((a, b) => a.localeCompare(b)),
    memberships: [...memberships].sort(),
    payments: [...payments].sort(),
    issueCodes: [...issueCodes].sort(),
    slackIdentityStates: [...slackIdentityStates].sort(),
  };
}

export function memberEligibleForSlackOutreach(m: MemberHealthRow): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!m.airtableRecordId) reasons.push("No Airtable member");
  if (!m.hasCurrentServiceAccess) reasons.push("No current service access");
  if (!m.primaryEmail || !isValidEmail(m.primaryEmail)) reasons.push("Invalid primary email");
  if (
    m.slackIdentityState === "matched_primary_email" ||
    m.slackIdentityState === "matched_slack_email"
  ) {
    reasons.push("Already matched to active Slack user");
  }
  if (!m.city.trim()) reasons.push("City missing");
  if (!m.cityChannelId) reasons.push("City Slack channel not configured");
  if (!getAllMembersChannelConfig().id) reasons.push("SLACK_ALL_MEMBERS_CHANNEL_ID missing");
  if (!getSlackInviteUrl()) reasons.push("SLACK_WORKSPACE_INVITE_URL / SLACK_JOIN_URL missing");
  return { ok: reasons.length === 0, reasons };
}
