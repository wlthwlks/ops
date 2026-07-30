/**
 * Workspace Slack users with reverse channel membership index.
 * One users.list + one conversations.members per relevant channel.
 */
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createSlackClient, type SlackUser } from "@/lib/integrations/slack";
import {
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
  buildSlackMaps,
} from "@/lib/ops/member-health";
import { hasServiceAccess } from "@/lib/introduction/service-access";
import { normalizeEmailStrict } from "@/lib/billing/reconcile-stripe-customers";

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

export type WorkspaceUserRow = {
  slackUserId: string;
  name: string;
  email: string;
  slackAccountStatus: "active" | "deactivated" | "bot" | "app";
  airtableRecordId: string;
  airtableMatch: "matched" | "ambiguous" | "none";
  memberName: string;
  city: string;
  membership: string;
  payment: string;
  serviceAccessUntil: string;
  serviceAccessState:
    | "current"
    | "grace"
    | "expired"
    | "invalid_date"
    | "no_member"
    | "not_applicable";
  channels: Array<{
    id: string;
    name: string;
    membership: "member" | "not_checked" | "not_visible";
  }>;
  channelCount: number;
  recommendedAction: string;
};

export type WorkspaceUsersResult = {
  scannedAt: string;
  users: WorkspaceUserRow[];
  channelsChecked: Array<{ id: string; name: string; visible: boolean; error?: string }>;
  warnings: string[];
  reverseIndexBuilt: true;
  channelMembershipCalls: number;
};

export async function scanWorkspaceUsers(): Promise<WorkspaceUsersResult> {
  const warnings: string[] = [];
  const scannedAt = new Date().toISOString();
  const referenceDate = new Date();

  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!token || !baseId) throw new Error("Airtable is not configured");
  if (!slackToken) throw new Error("SLACK_BOT_TOKEN is not configured");

  const airtable = createAirtableClient({ apiKey: token, baseId });
  const slack = createSlackClient({ botToken: slackToken });

  let memberRecords = await airtable.listRecords(MEMBERS_TABLE, {
    fields: MEMBER_LIST_FIELDS,
  }).catch((e) => {
    const schema = toAirtableSchemaError(MEMBERS_TABLE, e);
    if (schema) throw schema;
    throw e;
  });

  let channelRecords = await airtable.listRecords(SLACK_CHANNELS_TABLE, {
    fields: SLACK_CHANNEL_LIST_FIELDS,
  }).catch((e) => {
    const schema = toAirtableSchemaError(SLACK_CHANNELS_TABLE, e);
    if (schema) throw schema;
    throw e;
  });

  const slackUsers = await slack.listUsers();
  const maps = buildSlackMaps(slackUsers);

  type Snap = {
    id: string;
    name: string;
    email: string;
    city: string;
    membership: string;
    payment: string;
    until: string;
    hasAccess: boolean;
    identity: ReturnType<typeof resolveSlackIdentity>;
  };

  const snaps: Snap[] = [];
  for (const r of memberRecords) {
    const name = fieldStr(r.fields, MEMBER_FIELDS.name);
    const email = fieldStr(r.fields, MEMBER_FIELDS.email);
    const slackEmail = fieldStr(r.fields, MEMBER_FIELDS.slackEmail);
    const city = fieldStr(r.fields, MEMBER_FIELDS.city);
    const membership = fieldStr(r.fields, MEMBER_FIELDS.membership);
    const payment = fieldStr(r.fields, MEMBER_FIELDS.payment);
    const until = fieldStr(r.fields, MEMBER_FIELDS.serviceAccessUntil);
    const identity = resolveSlackIdentity({
      primaryEmail: email,
      slackEmail,
      name,
      ...maps,
    });
    snaps.push({
      id: r.id,
      name,
      email,
      city,
      membership,
      payment,
      until,
      hasAccess: hasServiceAccess(membership, payment, until || null, referenceDate),
      identity,
    });
  }

  const slackIdToSnaps = new Map<string, Snap[]>();
  for (const s of snaps) {
    const uid = s.identity.user?.id;
    if (
      !uid ||
      (s.identity.state !== "matched_primary_email" &&
        s.identity.state !== "matched_slack_email")
    ) {
      continue;
    }
    const list = slackIdToSnaps.get(uid) || [];
    list.push(s);
    slackIdToSnaps.set(uid, list);
  }

  const allMembers = getAllMembersChannelConfig();
  const channelDefs: Array<{ id: string; name: string }> = [];
  for (const ch of channelRecords) {
    const id = fieldStr(ch.fields, SLACK_CHANNEL_FIELDS.slackChannelId);
    const name = fieldStr(ch.fields, SLACK_CHANNEL_FIELDS.name);
    if (id) channelDefs.push({ id, name: name || id });
  }
  if (allMembers.id && !channelDefs.some((c) => c.id === allMembers.id)) {
    channelDefs.unshift({ id: allMembers.id, name: allMembers.name || "all-wlth-wlks" });
  }

  // Reverse index: userId → channel memberships (one call per channel)
  const userToChannels = new Map<string, Array<{ id: string; name: string; membership: "member" | "not_checked" | "not_visible" }>>();
  const channelsChecked: WorkspaceUsersResult["channelsChecked"] = [];
  let channelMembershipCalls = 0;

  for (const ch of channelDefs) {
    try {
      const members = await slack.getConversationMembers(ch.id);
      channelMembershipCalls++;
      channelsChecked.push({ id: ch.id, name: ch.name, visible: true });
      for (const uid of members) {
        const list = userToChannels.get(uid) || [];
        list.push({ id: ch.id, name: ch.name, membership: "member" });
        userToChannels.set(uid, list);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      channelsChecked.push({
        id: ch.id,
        name: ch.name,
        visible: false,
        error: msg.slice(0, 160),
      });
      warnings.push(`Channel ${ch.name} (${ch.id}) not visible: ${msg.slice(0, 120)}`);
      // Mark not_checked for all users — do not pretend no access
      for (const u of slackUsers) {
        if (u.deleted || u.isBot || u.isAppUser) continue;
        const list = userToChannels.get(u.id) || [];
        list.push({ id: ch.id, name: ch.name, membership: "not_visible" });
        userToChannels.set(u.id, list);
      }
    }
  }

  const users: WorkspaceUserRow[] = [];
  for (const u of slackUsers) {
    if (u.isBot || u.isAppUser || u.id === "USLACKBOT") continue;
    if (u.deleted) continue;

    const matches = slackIdToSnaps.get(u.id) || [];
    let airtableMatch: WorkspaceUserRow["airtableMatch"] = "none";
    let snap: Snap | null = null;
    if (matches.length > 1) {
      airtableMatch = "ambiguous";
      snap = matches[0];
    } else if (matches.length === 1) {
      airtableMatch = "matched";
      snap = matches[0];
    }

    let serviceAccessState: WorkspaceUserRow["serviceAccessState"] = "no_member";
    if (snap) {
      const untilDate = snap.until ? new Date(snap.until) : null;
      if (snap.until && untilDate && Number.isNaN(untilDate.getTime())) {
        serviceAccessState = "invalid_date";
      } else if (snap.hasAccess) {
        serviceAccessState =
          snap.membership === "Active" && snap.payment === "Paid"
            ? "current"
            : "grace";
      } else {
        serviceAccessState = "expired";
      }
    }

    const channels = userToChannels.get(u.id) || [];
    const memberChannels = channels.filter((c) => c.membership === "member");

    let recommendedAction = "No action required";
    if (airtableMatch === "none") {
      recommendedAction = "Review unmatched Slack user";
    } else if (airtableMatch === "ambiguous") {
      recommendedAction = "Resolve ambiguous Airtable match";
    } else if (serviceAccessState === "expired") {
      recommendedAction = "Review for Slack access removal";
    } else if (serviceAccessState === "invalid_date") {
      recommendedAction = "Fix Service access until in Airtable";
    }

    users.push({
      slackUserId: u.id,
      name: u.realName || u.name,
      email: u.email || "",
      slackAccountStatus: "active",
      airtableRecordId: snap?.id || "",
      airtableMatch,
      memberName: snap?.name || "",
      city: snap?.city || "",
      membership: snap?.membership || "",
      payment: snap?.payment || "",
      serviceAccessUntil: snap?.until || "",
      serviceAccessState,
      channels,
      channelCount: memberChannels.length,
      recommendedAction,
    });
  }

  users.sort((a, b) => a.name.localeCompare(b.name));

  return {
    scannedAt,
    users,
    channelsChecked,
    warnings,
    reverseIndexBuilt: true,
    channelMembershipCalls,
  };
}

export function filterWorkspaceUsers(
  users: WorkspaceUserRow[],
  query: {
    q?: string;
    channelId?: string;
    noConfiguredChannel?: boolean;
    expiredOnly?: boolean;
    noAirtableMatch?: boolean;
  }
): WorkspaceUserRow[] {
  let list = users;
  if (query.q) {
    const q = query.q.toLowerCase();
    list = list.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.slackUserId.toLowerCase().includes(q) ||
        u.memberName.toLowerCase().includes(q)
    );
  }
  if (query.channelId) {
    list = list.filter((u) =>
      u.channels.some((c) => c.id === query.channelId && c.membership === "member")
    );
  }
  if (query.noConfiguredChannel) {
    list = list.filter((u) => !u.channels.some((c) => c.membership === "member"));
  }
  if (query.expiredOnly) {
    list = list.filter((u) => u.serviceAccessState === "expired");
  }
  if (query.noAirtableMatch) {
    list = list.filter((u) => u.airtableMatch === "none");
  }
  return list;
}

// keep import used for type-only safety
void normalizeEmailStrict;
