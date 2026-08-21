/**
 * Slack access removal queue — eligibility, plans, audited actions.
 * Never removes members with valid Service access until.
 * Never trusts client-provided access fields as authoritative.
 */
import { randomUUID } from "crypto";
import { createSlackClient } from "@/lib/integrations/slack";
import { db } from "@/db";
import { slackAccessActions } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  scanMemberHealth,
  getAllMembersChannelConfig,
} from "@/lib/ops/member-health";
import type { MemberHealthRow } from "@/lib/ops/member-health-types";
import { resolveMemberForOutreach } from "@/lib/ops/resolve-member-for-outreach";
import { sortByDateJoinedDesc } from "@/lib/ops/slack-community";

export type RemovalReadiness =
  | "ready_for_review"
  | "access_date_invalid"
  | "slack_identity_unresolved"
  | "already_deactivated"
  | "no_longer_in_wlth_channels"
  | "removal_partially_completed"
  | "removal_failed"
  | "still_has_access";

export type RemovalQueueRow = {
  member: MemberHealthRow;
  daysExpired: number | null;
  readiness: RemovalReadiness;
  currentChannels: string[];
  lastRemovalAttempt: string | null;
  lastRemovalStatus: string | null;
};

export type SlackRemovalCapabilities = {
  canKickFromChannels: boolean;
  canDeactivateWorkspaceUser: boolean;
  deactivateReason: string;
  scopes: string[];
};

export type SlackScopeCapabilities = {
  canKickFromChannels: boolean;
  canInviteToChannels: boolean;
  canReadChannels: boolean;
};

/**
 * Pure mapping from bot OAuth scopes to what the community operations can do.
 * Kept free of env access so it is unit-testable.
 */
export function classifySlackScopes(scopes: string[]): SlackScopeCapabilities {
  return {
    canKickFromChannels:
      scopes.includes("channels:write") ||
      scopes.includes("groups:write") ||
      scopes.includes("channels:manage"),
    canInviteToChannels:
      scopes.includes("groups:write") || scopes.includes("channels:manage"),
    canReadChannels:
      scopes.includes("channels:read") || scopes.includes("groups:read"),
  };
}

export async function detectSlackRemovalCapabilities(): Promise<SlackRemovalCapabilities> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) {
    return {
      canKickFromChannels: false,
      canDeactivateWorkspaceUser: false,
      deactivateReason: "SLACK_BOT_TOKEN not configured",
      scopes: [],
    };
  }
  try {
    const slack = createSlackClient({ botToken: token });
    const auth = await slack.authTest();
    const scopes = auth.scopes || [];
    const canKick = classifySlackScopes(scopes).canKickFromChannels;
    // Deactivation needs a real admin token with admin.users:write (Enterprise Grid).
    let hasAdminRemove = false;
    let deactivateReason = "";
    const adminToken = process.env.SLACK_ADMIN_USER_TOKEN?.trim();
    if (adminToken) {
      try {
        const admin = createSlackClient({ botToken: adminToken });
        const adminAuth = await admin.authTest();
        hasAdminRemove = (adminAuth.scopes || []).includes("admin.users:write");
        if (!hasAdminRemove) {
          deactivateReason =
            "SLACK_ADMIN_USER_TOKEN is configured but lacks admin.users:write. Ordinary bot tokens cannot deactivate workspace users (Enterprise Grid / admin API required).";
        }
      } catch (e) {
        deactivateReason =
          e instanceof Error ? e.message : "Admin token check failed";
      }
    } else {
      deactivateReason =
        "Workspace deactivation requires SLACK_ADMIN_USER_TOKEN with admin.users:write (Enterprise Grid / admin API). Ordinary bot tokens cannot deactivate users. Use Copy emails / Export CSV / Open Slack Admin instead.";
    }
    return {
      canKickFromChannels: canKick,
      canDeactivateWorkspaceUser: hasAdminRemove,
      deactivateReason,
      scopes,
    };
  } catch (e) {
    return {
      canKickFromChannels: false,
      canDeactivateWorkspaceUser: false,
      deactivateReason: e instanceof Error ? e.message : "Slack auth failed",
      scopes: [],
    };
  }
}

/**
 * Paused members (intro pause or billing pause) stay in the community —
 * they are never queued for removal.
 */
export function isPausedMember(m: MemberHealthRow): boolean {
  if (
    m.introPauseState === "paused" ||
    m.introPauseState === "paused_expired" ||
    m.introPauseState === "excluded"
  ) {
    return true;
  }
  if (m.stripeSubscriptionStatus.trim().toLowerCase() === "paused") {
    return true;
  }
  return false;
}

function daysExpired(until: string, ref: Date): number | null {
  if (!until?.trim()) return null;
  const d = new Date(until);
  if (Number.isNaN(d.getTime())) return null;
  const ms = ref.getTime() - d.getTime();
  if (ms < 0) return null;
  return Math.floor(ms / 86400000);
}

export function classifyRemovalReadiness(m: MemberHealthRow): RemovalReadiness {
  if (m.hasCurrentServiceAccess) return "still_has_access";
  if (m.issues.some((i) => i.code === "INVALID_SERVICE_ACCESS_DATE")) {
    return "access_date_invalid";
  }
  if (!m.serviceAccessUntil?.trim()) return "access_date_invalid";
  const until = new Date(m.serviceAccessUntil);
  if (Number.isNaN(until.getTime())) return "access_date_invalid";

  if (m.slackIdentityState === "deactivated") return "already_deactivated";
  if (
    m.slackIdentityState !== "matched_primary_email" &&
    m.slackIdentityState !== "matched_slack_email"
  ) {
    return "slack_identity_unresolved";
  }

  const inCity = m.cityChannelMembership === "member";
  const inAll = m.allMembersChannelMembership === "member";
  // If channels not checked, still ready for review (workspace presence via identity)
  if (
    m.cityChannelMembership !== "not_checked" &&
    m.allMembersChannelMembership !== "not_checked" &&
    !inCity &&
    !inAll &&
    m.cityChannelMembership !== "error"
  ) {
    // May still be in workspace; flag for review if expired issue present
    if (!m.issues.some((i) => i.code === "EXPIRED_MEMBER_STILL_IN_SLACK_WORKSPACE")) {
      return "no_longer_in_wlth_channels";
    }
  }

  return "ready_for_review";
}

export async function buildRemovalQueue(): Promise<{
  rows: RemovalQueueRow[];
  scannedAt: string;
  capabilities: SlackRemovalCapabilities;
}> {
  const scan = await scanMemberHealth({
    includeSlack: true,
    includeChannelMembership: true,
  });
  const ref = new Date(scan.summary.referenceDate || Date.now());
  const capabilities = await detectSlackRemovalCapabilities();

  const candidates = scan.members.filter((m) => {
    if (m.hasCurrentServiceAccess) return false;
    // Paused members stay in the community — never queued for removal.
    if (isPausedMember(m)) return false;
    if (m.membership === "Active" && m.payment === "Paid") return false;
    if (!m.serviceAccessUntil?.trim()) return false;
    const until = new Date(m.serviceAccessUntil);
    if (Number.isNaN(until.getTime())) {
      return m.issues.some((i) => i.code === "INVALID_SERVICE_ACCESS_DATE");
    }
    if (until >= ref) return false;
    return (
      m.slackIdentityState === "matched_primary_email" ||
      m.slackIdentityState === "matched_slack_email" ||
      m.slackIdentityState === "deactivated" ||
      m.issues.some((i) => i.code === "EXPIRED_MEMBER_STILL_IN_SLACK_WORKSPACE")
    );
  });

  const rows: RemovalQueueRow[] = [];
  for (const member of candidates) {
    let lastRemovalAttempt: string | null = null;
    let lastRemovalStatus: string | null = null;
    try {
      if (member.airtableRecordId) {
        const recent = await db
          .select()
          .from(slackAccessActions)
          .where(eq(slackAccessActions.airtableRecordId, member.airtableRecordId))
          .limit(5);
        const sorted = [...recent].sort(
          (a, b) => b.startedAt.getTime() - a.startedAt.getTime()
        );
        if (sorted[0]) {
          lastRemovalAttempt = sorted[0].startedAt.toISOString();
          lastRemovalStatus = sorted[0].status;
        }
      }
    } catch {
      /* table may not exist yet */
    }

    let readiness = classifyRemovalReadiness(member);
    if (lastRemovalStatus === "partial") readiness = "removal_partially_completed";
    if (lastRemovalStatus === "failed") readiness = "removal_failed";

    // Accounts that are already deactivated in Slack are already removed —
    // not part of the "needs removal" list.
    if (readiness === "already_deactivated") continue;

    const currentChannels: string[] = [];
    if (member.cityChannelMembership === "member" && member.cityChannelName) {
      currentChannels.push(member.cityChannelName);
    }
    if (member.allMembersChannelMembership === "member") {
      currentChannels.push(
        getAllMembersChannelConfig().name || "introductions"
      );
    }

    rows.push({
      member,
      daysExpired: daysExpired(member.serviceAccessUntil, ref),
      readiness,
      currentChannels,
      lastRemovalAttempt,
      lastRemovalStatus,
    });
  }

  // Date joined latest → oldest (missing dates sink to the bottom).
  sortByDateJoinedDesc(rows, (r) => r.member.dateJoined);

  return {
    rows,
    scannedAt: scan.summary.scannedAt,
    capabilities,
  };
}

export type RemovalPlan = {
  airtableRecordId: string;
  slackUserId: string;
  eligible: boolean;
  exclusionReason?: string;
  channelsToRemove: Array<{ id: string; name: string }>;
  canDeactivate: boolean;
  memberName: string;
  email: string;
};

/**
 * Fresh server-side revalidation before any removal mutation.
 */
export async function buildRemovalPlan(
  airtableRecordId: string,
  capabilities: SlackRemovalCapabilities
): Promise<RemovalPlan> {
  const resolved = await resolveMemberForOutreach(airtableRecordId, {
    checkCooldown: false,
  });
  // Re-scan membership via full path for channel state when possible
  const scan = await scanMemberHealth({
    includeSlack: true,
    includeChannelMembership: true,
  });
  const member =
    scan.members.find((m) => m.airtableRecordId === airtableRecordId) ||
    resolved.member;

  if (member.hasCurrentServiceAccess) {
    return {
      airtableRecordId,
      slackUserId: member.activeSlackUserId,
      eligible: false,
      exclusionReason: "Member still has valid service access (revalidated)",
      channelsToRemove: [],
      canDeactivate: false,
      memberName: member.name,
      email: member.primaryEmail,
    };
  }

  if (
    member.slackIdentityState !== "matched_primary_email" &&
    member.slackIdentityState !== "matched_slack_email"
  ) {
    return {
      airtableRecordId,
      slackUserId: member.activeSlackUserId,
      eligible: false,
      exclusionReason: "Slack identity unresolved",
      channelsToRemove: [],
      canDeactivate: false,
      memberName: member.name,
      email: member.primaryEmail,
    };
  }

  const channelsToRemove: Array<{ id: string; name: string }> = [];
  if (member.cityChannelMembership === "member" && member.cityChannelId) {
    channelsToRemove.push({
      id: member.cityChannelId,
      name: member.cityChannelName || member.cityChannelId,
    });
  }
  const allCfg = getAllMembersChannelConfig();
  if (member.allMembersChannelMembership === "member" && allCfg.id) {
    channelsToRemove.push({ id: allCfg.id, name: allCfg.name || "introductions" });
  }

  return {
    airtableRecordId,
    slackUserId: member.activeSlackUserId,
    eligible: true,
    channelsToRemove,
    canDeactivate: capabilities.canDeactivateWorkspaceUser,
    memberName: member.name,
    email: member.primaryEmail,
  };
}

export async function executeChannelRemovals(input: {
  airtableRecordId: string;
  channelIds: string[];
  clerkUserId: string;
  runtimeMode: string;
  idempotencyKey: string;
}): Promise<{
  status: string;
  results: Array<{ channelId: string; ok: boolean; error?: string }>;
  error?: string;
}> {
  const capabilities = await detectSlackRemovalCapabilities();
  const plan = await buildRemovalPlan(input.airtableRecordId, capabilities);

  if (!plan.eligible) {
    const id = randomUUID();
    try {
      await db.insert(slackAccessActions).values({
        id,
        actionType: "channel_remove",
        airtableRecordId: input.airtableRecordId,
        slackUserId: plan.slackUserId || null,
        targetChannelIds: JSON.stringify(input.channelIds),
        status: plan.exclusionReason?.includes("service access")
          ? "skipped_revalidated_access"
          : "skipped_unresolved_identity",
        error: plan.exclusionReason || null,
        initiatedByClerkUserId: input.clerkUserId,
        runtimeMode: input.runtimeMode,
        idempotencyKey: input.idempotencyKey,
        completedAt: new Date(),
      });
    } catch {
      /* ignore audit write failure after skip */
    }
    return {
      status: plan.exclusionReason?.includes("service access")
        ? "skipped_revalidated_access"
        : "skipped_unresolved_identity",
      results: [],
      error: plan.exclusionReason,
    };
  }

  if (!capabilities.canKickFromChannels) {
    return {
      status: "failed",
      results: [],
      error:
        "Bot lacks channels:write / groups:write scope to remove users from channels. Invite bot with write scopes or use Slack Admin manually.",
    };
  }

  const allowed = new Set(plan.channelsToRemove.map((c) => c.id));
  const targets = input.channelIds.filter((id) => allowed.has(id));
  if (targets.length === 0) {
    return {
      status: "already_removed",
      results: [],
      error: "No matching channels to remove (already removed or not a member)",
    };
  }

  const rowId = randomUUID();
  try {
    await db.insert(slackAccessActions).values({
      id: rowId,
      actionType: "channel_remove",
      airtableRecordId: input.airtableRecordId,
      slackUserId: plan.slackUserId,
      targetChannelIds: JSON.stringify(targets),
      status: "running",
      initiatedByClerkUserId: input.clerkUserId,
      runtimeMode: input.runtimeMode,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique|duplicate/i.test(msg)) {
      return { status: "failed", results: [], error: "Duplicate idempotency key" };
    }
  }

  const slack = createSlackClient({ botToken: process.env.SLACK_BOT_TOKEN! });
  const results: Array<{ channelId: string; ok: boolean; error?: string }> = [];

  // conversations.kick via low-level — extend client if needed
  for (const channelId of targets) {
    try {
      const res = await fetch("https://slack.com/api/conversations.kick", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ channel: channelId, user: plan.slackUserId }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        results.push({
          channelId,
          ok: false,
          error: data.error || "kick failed",
        });
      } else {
        results.push({ channelId, ok: true });
      }
    } catch (e) {
      results.push({
        channelId,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const status =
    okCount === results.length
      ? "completed"
      : okCount === 0
        ? "failed"
        : "partial";

  try {
    await db
      .update(slackAccessActions)
      .set({
        status,
        resultJson: JSON.stringify(results),
        error: status === "failed" ? results.map((r) => r.error).join("; ") : null,
        completedAt: new Date(),
      })
      .where(eq(slackAccessActions.id, rowId));
  } catch {
    /* ignore */
  }

  void slack;
  return { status, results };
}

export async function executeWorkspaceDeactivation(input: {
  airtableRecordId: string;
  clerkUserId: string;
  runtimeMode: string;
  idempotencyKey: string;
}): Promise<{ status: string; error?: string }> {
  const capabilities = await detectSlackRemovalCapabilities();
  const plan = await buildRemovalPlan(input.airtableRecordId, capabilities);

  if (!plan.eligible) {
    return {
      status: "skipped_revalidated",
      error: plan.exclusionReason || "Member not eligible for removal",
    };
  }
  if (!plan.slackUserId) {
    return { status: "skipped_revalidated", error: "No Slack user id resolved" };
  }
  if (!capabilities.canDeactivateWorkspaceUser) {
    return { status: "failed", error: capabilities.deactivateReason };
  }

  const rowId = randomUUID();
  try {
    await db.insert(slackAccessActions).values({
      id: rowId,
      actionType: "workspace_deactivate",
      airtableRecordId: input.airtableRecordId,
      slackUserId: plan.slackUserId,
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
    await slack.deactivateUser(plan.slackUserId);
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
