/**
 * Slack Community operations — identity linking, invites and channel adds.
 * The Slack workspace is a community space only: no business-critical state
 * lives here. All mutations are live-admin gated by the API routes.
 */
import { createAirtableClient } from "@/lib/integrations/airtable";
import {
  createSlackClient,
  type SlackUser,
} from "@/lib/integrations/slack";
import {
  MEMBER_FIELDS,
  MEMBER_LIST_FIELDS,
  MEMBERS_TABLE,
} from "@/lib/ops/airtable-fields";
import {
  buildSlackMaps,
  memberEligibleForSlackOutreach,
  scanMemberHealth,
} from "@/lib/ops/member-health";
import type { MemberHealthRow } from "@/lib/ops/member-health-types";
import {
  classifySlackScopes,
  detectSlackRemovalCapabilities,
  type SlackRemovalCapabilities,
} from "@/lib/ops/slack-removal";
import { getOutreachCooldownDays } from "@/lib/ops/slack-outreach";
import { db } from "@/db";
import { memberOutreach } from "@/db/schema";
import { slackAccessActions } from "@/db/schema";
import { and, eq, gte } from "drizzle-orm";
import { randomUUID } from "crypto";

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Short-lived in-memory cache for the workspace user list. users.list over a
 * large workspace is the slowest part of every community scan — share it
 * across the link/compare/invite builders instead of re-fetching per tab.
 */
let workspaceUsersCache: { at: number; users: SlackUser[] } | null = null;
const WORKSPACE_USERS_TTL_MS = 60_000;

async function listWorkspaceUsersCached(): Promise<SlackUser[]> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not configured");
  if (workspaceUsersCache && Date.now() - workspaceUsersCache.at < WORKSPACE_USERS_TTL_MS) {
    return workspaceUsersCache.users;
  }
  const slack = createSlackClient({ botToken: token });
  const users = await slack.listUsers();
  workspaceUsersCache = { at: Date.now(), users };
  return users;
}

function splitWords(name: string): Set<string> {
  return new Set(
    normalizeName(name)
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
}

export function sortByDateJoinedDesc<T>(rows: T[], getDate: (row: T) => string): T[] {
  const parse = (v: string): number => {
    if (!v?.trim()) return Number.NEGATIVE_INFINITY;
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  return [...rows].sort((a, b) => {
    const diff = parse(getDate(b)) - parse(getDate(a));
    if (diff !== 0) return diff;
    return 0;
  });
}

export type SlackCommunityCapabilities = SlackRemovalCapabilities & {
  canInviteToChannels: boolean;
  inviteToChannelsReason: string;
  canInviteToWorkspace: boolean;
  inviteToWorkspaceReason: string;
  canReactivateUsers: boolean;
  reactivateReason: string;
};

/**
 * Combined capability probe: bot scopes via auth.test + optional admin token.
 * Never trusts client input; failures degrade to explicit reasons.
 */
export async function detectSlackCommunityCapabilities(): Promise<SlackCommunityCapabilities> {
  const removal = await detectSlackRemovalCapabilities();
  const scopes = removal.scopes;
  const scopeCaps = classifySlackScopes(scopes);

  const canInviteToChannels = scopeCaps.canInviteToChannels;
  const inviteToChannelsReason = canInviteToChannels
    ? ""
    : "Bot needs groups:write or channels:manage (and membership in private channels) to add people to private city channels.";

  let canInviteToWorkspace = false;
  let inviteToWorkspaceReason = "";
  let canReactivateUsers = false;
  let reactivateReason = "";
  const adminToken = process.env.SLACK_ADMIN_USER_TOKEN?.trim();
  if (!adminToken) {
    inviteToWorkspaceReason =
      "SLACK_ADMIN_USER_TOKEN is not configured — workspace invites go out by email (join link). API workspace invite needs an Enterprise Grid admin token with admin.users:write.";
    reactivateReason =
      "SLACK_ADMIN_USER_TOKEN is not configured — reactivate deactivated accounts manually in Slack Admin.";
  } else {
    try {
      const admin = createSlackClient({ botToken: adminToken });
      const auth = await admin.authTest();
      const adminWrite = (auth.scopes || []).includes("admin.users:write");
      canInviteToWorkspace = adminWrite;
      canReactivateUsers = adminWrite;
      inviteToWorkspaceReason = adminWrite
        ? ""
        : "Admin token is present but lacks admin.users:write — workspace invites go out by email (join link).";
      reactivateReason = adminWrite
        ? ""
        : "Admin token is present but lacks admin.users:write — reactivate deactivated accounts manually in Slack Admin.";
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Admin token check failed";
      inviteToWorkspaceReason = msg;
      reactivateReason = msg;
    }
  }

  return {
    ...removal,
    canInviteToChannels,
    inviteToChannelsReason,
    canInviteToWorkspace,
    inviteToWorkspaceReason,
    canReactivateUsers,
    reactivateReason,
  };
}

export type LinkCandidate = {
  slackUserId: string;
  name: string;
  email: string;
};

export type LinkSuggestion = {
  slackUserId: string;
  slackEmail: string;
  slackName: string;
  confidence: "high" | "low";
  kind: "primary_email" | "exact_name" | "ambiguous_name";
};

export type LinkRow = {
  airtableRecordId: string;
  name: string;
  primaryEmail: string;
  city: string;
  membership: string;
  payment: string;
  dateJoined: string;
  suggestion: LinkSuggestion | null;
  candidates: LinkCandidate[];
};

export type LinkQueueResult = {
  scannedAt: string;
  rows: LinkRow[];
  memberCount: number;
  slackUserCount: number;
  options: {
    cities: string[];
    memberships: string[];
    payments: string[];
  };
};

function scoreNameOverlap(memberName: string, slackName: string): number {
  const a = splitWords(memberName);
  const b = splitWords(slackName);
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const w of a) if (b.has(w)) overlap++;
  return overlap;
}

/** Top scored name candidates for the compare picker. */
function findCandidates(
  memberName: string,
  activeUsers: SlackUser[],
  excludeIds: Set<string>,
  limit = 5
): LinkCandidate[] {
  const memberWords = splitWords(memberName);
  if (memberWords.size === 0) return [];
  const scored: Array<{ u: SlackUser; score: number }> = [];
  for (const u of activeUsers) {
    if (excludeIds.has(u.id)) continue;
    const score = scoreNameOverlap(memberName, u.realName || u.name || "");
    if (score > 0) scored.push({ u, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ u }) => ({
    slackUserId: u.id,
    name: u.realName || u.name || "",
    email: u.email,
  }));
}

/**
 * Build the Slack Email linking queue: members whose "Slack Email" field is
 * empty, each with a best-guess suggestion plus name-scored candidates.
 * Ordered by Date joined latest → oldest.
 */
export async function buildLinkQueue(): Promise<LinkQueueResult> {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!token || !baseId) throw new Error("Airtable is not configured");
  if (!slackToken) throw new Error("SLACK_BOT_TOKEN is not configured");

  const airtable = createAirtableClient({ apiKey: token, baseId });

  const [memberRecords, slackUsers] = await Promise.all([
    airtable.listRecords(MEMBERS_TABLE, {
      fields: MEMBER_LIST_FIELDS,
      // Only members with an empty "Slack Email" can be linked — filter
      // server-side so large bases don't blow the function timeout.
      filterByFormula: 'OR({Slack Email} = "", {Slack Email} = BLANK())',
    }),
    listWorkspaceUsersCached(),
  ]);
  const activeUsers = slackUsers.filter(
    (u) => !u.deleted && !u.isBot && !u.isAppUser
  );
  const maps = buildSlackMaps(activeUsers);

  const cities = new Set<string>();
  const memberships = new Set<string>();
  const payments = new Set<string>();

  const rows: LinkRow[] = [];
  for (const r of memberRecords) {
    const name = fieldStr(r.fields, MEMBER_FIELDS.name);
    const primaryEmail = fieldStr(r.fields, MEMBER_FIELDS.email);
    const slackEmail = fieldStr(r.fields, MEMBER_FIELDS.slackEmail);
    const city = fieldStr(r.fields, MEMBER_FIELDS.city);
    const membership = fieldStr(r.fields, MEMBER_FIELDS.membership);
    const payment = fieldStr(r.fields, MEMBER_FIELDS.payment);
    const dateJoined = fieldStr(r.fields, MEMBER_FIELDS.dateJoined);

    if (city) cities.add(city);
    if (membership) memberships.add(membership);
    if (payment) payments.add(payment);

    // Only members without a Slack Email field are linkable
    if (slackEmail) continue;

    let suggestion: LinkSuggestion | null = null;
    const exclude = new Set<string>();

    const primaryNorm = primaryEmail.trim().toLowerCase();
    if (primaryNorm) {
      const hits = (maps.emailToUser.get(primaryNorm) || []).filter(
        (u) => !u.deleted && !u.isBot && !u.isAppUser
      );
      if (hits.length === 1) {
        const u = hits[0];
        suggestion = {
          slackUserId: u.id,
          slackEmail: primaryNorm,
          slackName: u.realName || u.name,
          confidence: "high",
          kind: "primary_email",
        };
        exclude.add(u.id);
      }
    }

    if (!suggestion) {
      const normName = normalizeName(name);
      if (normName) {
        const byName = (maps.nameToUser.get(normName) || []).filter(
          (u) => !u.deleted && !u.isBot && !u.isAppUser
        );
        if (byName.length === 1) {
          const u = byName[0];
          suggestion = {
            slackUserId: u.id,
            slackEmail: u.email,
            slackName: u.realName || u.name,
            confidence: "high",
            kind: "exact_name",
          };
          exclude.add(u.id);
        } else if (byName.length > 1) {
          suggestion = {
            slackUserId: byName[0].id,
            slackEmail: byName[0].email,
            slackName: byName[0].realName || byName[0].name,
            confidence: "low",
            kind: "ambiguous_name",
          };
          for (const u of byName) exclude.add(u.id);
        }
      }
    }

    const candidates = [
      ...(suggestion
        ? [
            {
              slackUserId: suggestion.slackUserId,
              name: suggestion.slackName,
              email: suggestion.slackEmail,
            },
          ]
        : []),
      ...findCandidates(name, activeUsers, exclude, 5),
    ].slice(0, 6);

    rows.push({
      airtableRecordId: r.id,
      name,
      primaryEmail,
      city,
      membership,
      payment,
      dateJoined,
      suggestion,
      candidates,
    });
  }

  sortByDateJoinedDesc(rows, (r) => r.dateJoined);

  return {
    scannedAt: new Date().toISOString(),
    rows,
    memberCount: memberRecords.length,
    slackUserCount: activeUsers.length,
    options: {
      cities: [...cities].sort((a, b) => a.localeCompare(b)),
      memberships: [...memberships].sort(),
      payments: [...payments].sort(),
    },
  };
}

/** Slack profile fields worth showing next to the Airtable record. */
export function pickSlackProfileFields(u: SlackUser): Array<{ label: string; value: string }> {
  return [
    { label: "Display name", value: u.displayName || u.realName || "—" },
    { label: "Full name", value: u.realName || "—" },
    { label: "Username", value: u.name || "—" },
    { label: "Email", value: u.email || "—" },
    { label: "Title", value: u.title || "—" },
    { label: "Phone", value: u.phone || "—" },
    {
      label: "Status",
      value: u.statusText
        ? `${u.statusEmoji ? `${u.statusEmoji} ` : ""}${u.statusText}`
        : "—",
    },
    {
      label: "Role",
      value: [
        u.isOwner ? "Owner" : "",
        u.isAdmin ? "Admin" : "",
        u.isRestricted ? "Restricted" : "",
        u.isUltraRestricted ? "Ultra-restricted" : "",
      ]
        .filter(Boolean)
        .join(", ") || "Member",
    },
    { label: "Timezone", value: u.tz || "—" },
    { label: "Slack ID", value: u.id },
  ];
}

export type CompareResult = {
  airtable: {
    recordId: string;
    fields: Array<{ label: string; value: string }>;
  };
  slack: {
    fields: Array<{ label: string; value: string }>;
    channels: string[];
  } | null;
  candidates: LinkCandidate[];
  currentSlackEmail: string;
};

export async function buildCompare(
  airtableRecordId: string,
  slackUserId: string
): Promise<CompareResult> {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!token || !baseId) throw new Error("Airtable is not configured");
  if (!slackToken) throw new Error("SLACK_BOT_TOKEN is not configured");

  const airtable = createAirtableClient({ apiKey: token, baseId });
  const slack = createSlackClient({ botToken: slackToken });

  const [record, users] = await Promise.all([
    airtable.getRecord(MEMBERS_TABLE, airtableRecordId),
    listWorkspaceUsersCached(),
  ]);
  const activeUsers = users.filter((u) => !u.deleted && !u.isBot && !u.isAppUser);
  const target = activeUsers.find((u) => u.id === slackUserId) || null;
  const profile = target ? await slack.getUserInfo(slackUserId) : null;

  const name = fieldStr(record.fields, MEMBER_FIELDS.name);
  const airtableFields: Array<{ label: string; value: string }> = [
    { label: "Name", value: name || "—" },
    { label: "Email", value: fieldStr(record.fields, MEMBER_FIELDS.email) || "—" },
    {
      label: "Slack Email (current)",
      value: fieldStr(record.fields, MEMBER_FIELDS.slackEmail) || "—",
    },
    { label: "City", value: fieldStr(record.fields, MEMBER_FIELDS.city) || "—" },
    { label: "Membership", value: fieldStr(record.fields, MEMBER_FIELDS.membership) || "—" },
    { label: "Payment", value: fieldStr(record.fields, MEMBER_FIELDS.payment) || "—" },
    {
      label: "Service access until",
      value: fieldStr(record.fields, MEMBER_FIELDS.serviceAccessUntil) || "—",
    },
    { label: "Date joined", value: fieldStr(record.fields, MEMBER_FIELDS.dateJoined) || "—" },
    {
      label: "Cancellation date",
      value: fieldStr(record.fields, MEMBER_FIELDS.cancellationDate) || "—",
    },
    {
      label: "Stripe Customer ID",
      value: fieldStr(record.fields, MEMBER_FIELDS.stripeCustomerId) || "—",
    },
    {
      label: "Recurring intro status",
      value: fieldStr(record.fields, MEMBER_FIELDS.recurringIntroStatus) || "—",
    },
    { label: "Industry", value: fieldStr(record.fields, MEMBER_FIELDS.industry) || "—" },
    { label: "Business name", value: fieldStr(record.fields, MEMBER_FIELDS.businessName) || "—" },
    {
      label: "Business website",
      value: fieldStr(record.fields, MEMBER_FIELDS.businessWebsite) || "—",
    },
  ];

  const candidates = findCandidates(name, activeUsers, new Set(), 8);
  if (
    target &&
    !candidates.some((c) => c.slackUserId === target.id)
  ) {
    candidates.unshift({
      slackUserId: target.id,
      name: target.realName || target.name || "",
      email: target.email,
    });
  }

  return {
    airtable: { recordId: record.id, fields: airtableFields },
    slack: profile ? { fields: pickSlackProfileFields(profile), channels: [] } : null,
    candidates,
    currentSlackEmail: fieldStr(record.fields, MEMBER_FIELDS.slackEmail),
  };
}

export type InviteRow = {
  member: MemberHealthRow;
  cooldownActive: boolean;
  lastInvitedAt: string | null;
  eligibilityReasons: string[];
  /** Account exists in the workspace but is deactivated — reactivate, don't email-invite. */
  deactivated: boolean;
};

/** Identity states that qualify a current-access member for the invite queue. */
export function isInviteCandidateIdentityState(
  state: MemberHealthRow["slackIdentityState"]
): boolean {
  return (
    state === "not_found" ||
    state === "stale_slack_email" ||
    state === "deactivated"
  );
}

export type ChannelAddRow = {
  member: MemberHealthRow;
};

export type InviteQueueResult = {
  scannedAt: string;
  inviteRows: InviteRow[];
  channelAddRows: ChannelAddRow[];
  options: {
    cities: string[];
    memberships: string[];
    payments: string[];
  };
};

/**
 * Build the invite queue: current-access members not present in the Slack
 * workspace (invite them), plus members who are in the workspace but missing
 * from their private city channel (add them). Date joined latest → oldest.
 */
export async function buildInviteQueue(): Promise<InviteQueueResult> {
  const scan = await scanMemberHealth({
    includeSlack: true,
    includeChannelMembership: true,
  });

  const cooldownDays = getOutreachCooldownDays();
  const cooldownSince = new Date(Date.now() - cooldownDays * 86400000);

  // One query for recent slack_join sends, grouped per member.
  const lastInviteByMember = new Map<string, { at: string }>();
  try {
    const recent = await db
      .select({
        airtableRecordId: memberOutreach.airtableRecordId,
        createdAt: memberOutreach.createdAt,
        sentAt: memberOutreach.sentAt,
        status: memberOutreach.status,
      })
      .from(memberOutreach)
      .where(
        and(
          eq(memberOutreach.outreachType, "slack_join"),
          eq(memberOutreach.status, "sent"),
          gte(memberOutreach.createdAt, cooldownSince)
        )
      );
    for (const r of recent) {
      const at = r.sentAt?.toISOString() || r.createdAt.toISOString();
      const existing = lastInviteByMember.get(r.airtableRecordId);
      if (!existing || at > existing.at) {
        lastInviteByMember.set(r.airtableRecordId, { at });
      }
    }
  } catch {
    /* table may not exist yet */
  }

  const inviteRows: InviteRow[] = [];
  const channelAddRows: ChannelAddRow[] = [];

  for (const m of scan.members) {
    if (!m.airtableRecordId) continue;
    if (!m.hasCurrentServiceAccess) continue;

    const matched =
      m.slackIdentityState === "matched_primary_email" ||
      m.slackIdentityState === "matched_slack_email";

    if (matched) {
      if (m.cityChannelId && m.cityChannelMembership === "not_member") {
        channelAddRows.push({ member: m });
      }
      continue;
    }

    // Not matched — invite only when we are confident they are not in the
    // workspace under another identity (name-only matches go to linking).
    // Deactivated accounts are in the workspace but cannot sign in: surface
    // them here so they can be reactivated instead of email-invited.
    if (isInviteCandidateIdentityState(m.slackIdentityState)) {
      const deactivated = m.slackIdentityState === "deactivated";
      const eligibility = deactivated
        ? { reasons: [] }
        : memberEligibleForSlackOutreach(m);
      const lastInvited = lastInviteByMember.get(m.airtableRecordId)?.at || null;
      inviteRows.push({
        member: m,
        cooldownActive: Boolean(lastInvited),
        lastInvitedAt: lastInvited,
        eligibilityReasons: eligibility.reasons,
        deactivated,
      });
    }
  }

  sortByDateJoinedDesc(inviteRows, (r) => r.member.dateJoined);
  sortByDateJoinedDesc(channelAddRows, (r) => r.member.dateJoined);

  const cities = new Set<string>();
  const memberships = new Set<string>();
  const payments = new Set<string>();
  for (const r of [...inviteRows, ...channelAddRows]) {
    if (r.member.city.trim()) cities.add(r.member.city);
    if (r.member.membership.trim()) memberships.add(r.member.membership);
    if (r.member.payment.trim()) payments.add(r.member.payment);
  }

  return {
    scannedAt: scan.summary.scannedAt,
    inviteRows,
    channelAddRows,
    options: {
      cities: [...cities].sort((a, b) => a.localeCompare(b)),
      memberships: [...memberships].sort(),
      payments: [...payments].sort(),
    },
  };
}

export type ChannelInvitePlan = {
  airtableRecordId: string;
  eligible: boolean;
  exclusionReason?: string;
  slackUserId: string;
  channelId: string;
  channelName: string;
  memberName: string;
};

/**
 * Fresh server-side revalidation before any channel invite mutation.
 * Only current-access members who are in the workspace but missing from
 * their private city channel qualify.
 */
export async function buildChannelInvitePlan(
  airtableRecordId: string
): Promise<ChannelInvitePlan> {
  const scan = await scanMemberHealth({
    includeSlack: true,
    includeChannelMembership: true,
  });
  const member = scan.members.find((m) => m.airtableRecordId === airtableRecordId);

  if (!member) {
    return {
      airtableRecordId,
      eligible: false,
      exclusionReason: "Member not found in Airtable",
      slackUserId: "",
      channelId: "",
      channelName: "",
      memberName: "",
    };
  }
  if (!member.hasCurrentServiceAccess) {
    return {
      airtableRecordId,
      eligible: false,
      exclusionReason: "Member no longer has current service access (revalidated)",
      slackUserId: member.activeSlackUserId,
      channelId: member.cityChannelId,
      channelName: member.cityChannelName,
      memberName: member.name,
    };
  }
  if (
    member.slackIdentityState !== "matched_primary_email" &&
    member.slackIdentityState !== "matched_slack_email"
  ) {
    return {
      airtableRecordId,
      eligible: false,
      exclusionReason: "Slack identity is not resolved to an active workspace user",
      slackUserId: member.activeSlackUserId,
      channelId: member.cityChannelId,
      channelName: member.cityChannelName,
      memberName: member.name,
    };
  }
  if (!member.cityChannelId) {
    return {
      airtableRecordId,
      eligible: false,
      exclusionReason: "City Slack channel not configured for this member",
      slackUserId: member.activeSlackUserId,
      channelId: "",
      channelName: "",
      memberName: member.name,
    };
  }
  if (member.cityChannelMembership === "member") {
    return {
      airtableRecordId,
      eligible: false,
      exclusionReason: "Already a member of the city channel",
      slackUserId: member.activeSlackUserId,
      channelId: member.cityChannelId,
      channelName: member.cityChannelName,
      memberName: member.name,
    };
  }

  return {
    airtableRecordId,
    eligible: true,
    slackUserId: member.activeSlackUserId,
    channelId: member.cityChannelId,
    channelName: member.cityChannelName,
    memberName: member.name,
  };
}

export async function executeChannelInvite(input: {
  airtableRecordId: string;
  clerkUserId: string;
  runtimeMode: string;
  idempotencyKey: string;
}): Promise<{ status: string; error?: string }> {
  const capabilities = await detectSlackCommunityCapabilities();
  const plan = await buildChannelInvitePlan(input.airtableRecordId);

  if (!plan.eligible) {
    return {
      status: "skipped_revalidated",
      error: plan.exclusionReason || "Member not eligible for channel invite",
    };
  }
  if (!capabilities.canInviteToChannels) {
    return { status: "failed", error: capabilities.inviteToChannelsReason };
  }

  const rowId = randomUUID();
  try {
    await db.insert(slackAccessActions).values({
      id: rowId,
      actionType: "channel_invite",
      airtableRecordId: input.airtableRecordId,
      slackUserId: plan.slackUserId,
      targetChannelIds: JSON.stringify([plan.channelId]),
      status: "running",
      initiatedByClerkUserId: input.clerkUserId,
      runtimeMode: input.runtimeMode,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique|duplicate/i.test(msg)) {
      return { status: "failed", error: "Duplicate idempotency key" };
    }
  }

  try {
    const slack = createSlackClient({ botToken: process.env.SLACK_BOT_TOKEN! });
    await slack.inviteToChannel(plan.channelId, plan.slackUserId);
    await db
      .update(slackAccessActions)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(slackAccessActions.id, rowId));
    return { status: "completed" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await db
        .update(slackAccessActions)
        .set({ status: "failed", error: msg, completedAt: new Date() })
        .where(eq(slackAccessActions.id, rowId));
    } catch {
      /* ignore */
    }
    return { status: "failed", error: msg };
  }
}

/**
 * Reactivate a deactivated workspace account (admin.users.setRegular).
 * Revalidates current access + deactivated identity before calling Slack.
 */
export async function executeWorkspaceReactivation(input: {
  airtableRecordId: string;
  clerkUserId: string;
  runtimeMode: string;
  idempotencyKey: string;
}): Promise<{ status: string; error?: string }> {
  const capabilities = await detectSlackCommunityCapabilities();
  const scan = await scanMemberHealth({
    includeSlack: true,
    includeChannelMembership: false,
  });
  const member = scan.members.find(
    (m) => m.airtableRecordId === input.airtableRecordId
  );

  if (!member) {
    return { status: "skipped_revalidated", error: "Member not found in Airtable" };
  }
  if (!member.hasCurrentServiceAccess) {
    return {
      status: "skipped_revalidated",
      error: "Member no longer has current service access (revalidated)",
    };
  }
  if (member.slackIdentityState !== "deactivated") {
    return {
      status: "skipped_revalidated",
      error: "Slack identity is not a deactivated account (revalidated)",
    };
  }
  const slackUserId = member.activeSlackUserId;
  if (!slackUserId) {
    return {
      status: "skipped_revalidated",
      error: "No Slack user id resolved for the deactivated account",
    };
  }
  if (!capabilities.canReactivateUsers) {
    return { status: "failed", error: capabilities.reactivateReason };
  }

  const rowId = randomUUID();
  try {
    await db.insert(slackAccessActions).values({
      id: rowId,
      actionType: "workspace_reactivate",
      airtableRecordId: input.airtableRecordId,
      slackUserId,
      status: "running",
      initiatedByClerkUserId: input.clerkUserId,
      runtimeMode: input.runtimeMode,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique|duplicate/i.test(msg)) {
      return { status: "failed", error: "Duplicate idempotency key" };
    }
  }

  try {
    const slack = createSlackClient({
      botToken: process.env.SLACK_BOT_TOKEN!,
      adminToken: process.env.SLACK_ADMIN_USER_TOKEN,
    });
    await slack.reactivateUser(slackUserId);
    await db
      .update(slackAccessActions)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(slackAccessActions.id, rowId));
    return { status: "completed" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await db
        .update(slackAccessActions)
        .set({ status: "failed", error: msg, completedAt: new Date() })
        .where(eq(slackAccessActions.id, rowId));
    } catch {
      /* ignore */
    }
    return { status: "failed", error: msg };
  }
}
