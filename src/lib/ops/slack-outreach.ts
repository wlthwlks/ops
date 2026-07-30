/**
 * Slack joining reminder emails via Resend.
 * Never invites via Slack API. Never creates Airtable members.
 */
import { createResendClient } from "@/lib/integrations/resend";
import {
  buildSlackChannelUrl,
  getAllMembersChannelConfig,
  getSlackInviteUrl,
  memberEligibleForSlackOutreach,
} from "@/lib/ops/member-health";
import type { MemberHealthRow } from "@/lib/ops/member-health-types";

export function getOutreachCooldownDays(): number {
  const raw = process.env.SLACK_OUTREACH_COOLDOWN_DAYS;
  if (!raw) return 7;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type OutreachEmailPreview = {
  recipient: string;
  subject: string;
  memberName: string;
  city: string;
  workspaceJoinUrl: string;
  cityChannelName: string;
  cityChannelUrl: string | null;
  allMembersChannelName: string;
  allMembersChannelUrl: string | null;
  html: string;
  text: string;
  missingConfig: string[];
  eligible: boolean;
  eligibilityReasons: string[];
};

export function buildSlackJoinEmailPreview(member: MemberHealthRow): OutreachEmailPreview {
  const missingConfig: string[] = [];
  const workspaceJoinUrl = getSlackInviteUrl();
  if (!workspaceJoinUrl) missingConfig.push("SLACK_WORKSPACE_INVITE_URL or SLACK_JOIN_URL");

  const allMembers = getAllMembersChannelConfig();
  if (!allMembers.id) missingConfig.push("SLACK_ALL_MEMBERS_CHANNEL_ID");

  if (!process.env.RESEND_API_KEY) missingConfig.push("RESEND_API_KEY");
  if (!process.env.RESEND_FROM_EMAIL) missingConfig.push("RESEND_FROM_EMAIL");

  const cityChannelUrl = member.cityChannelId
    ? buildSlackChannelUrl(member.cityChannelId)
    : null;
  const allMembersChannelUrl = allMembers.id
    ? buildSlackChannelUrl(allMembers.id)
    : null;

  if (member.cityChannelId && !cityChannelUrl) {
    missingConfig.push("SLACK_WORKSPACE_URL (for channel deep links)");
  }

  const eligibility = memberEligibleForSlackOutreach(member);
  const support = (process.env.OPS_SUPPORT_EMAIL || "").trim();

  const safeName = escapeHtml(member.name || "there");
  const safeCity = escapeHtml(member.city || "your city");
  const cityName = escapeHtml(member.cityChannelName || member.city || "your city channel");
  const allName = escapeHtml(allMembers.name);

  const subject = "Join your WLTH WLKS Slack community";

  const html = `
<div style="font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; color: #111; max-width: 560px;">
  <p>Hi ${safeName},</p>
  <p>Welcome to WLTH WLKS. Our community lives on Slack — it is where introductions, city conversations and events happen.</p>
  <p>Please complete these steps:</p>
  <ol>
    <li><strong>Join the WLTH WLKS Slack workspace</strong><br/>
      <a href="${escapeHtml(workspaceJoinUrl)}" style="display:inline-block;margin:8px 0;padding:10px 16px;background:#4A154B;color:#fff;text-decoration:none;border-radius:6px;">Join Slack workspace</a><br/>
      <span style="font-size:12px;color:#555;">${escapeHtml(workspaceJoinUrl)}</span>
    </li>
    <li><strong>Join your city channel</strong> (${cityName})
      ${cityChannelUrl ? `<br/><a href="${escapeHtml(cityChannelUrl)}">Open city channel</a>` : ""}
    </li>
    <li><strong>Join ${allName}</strong>
      ${allMembersChannelUrl ? `<br/><a href="${escapeHtml(allMembersChannelUrl)}">Open ${allName}</a>` : ""}
    </li>
  </ol>
  <p>Once you are in Slack, you will receive community introductions and city updates there.</p>
  ${support ? `<p>Questions? Reply to this email or write to ${escapeHtml(support)}.</p>` : "<p>Questions? Just reply to this email.</p>"}
  <p>— WLTH WLKS</p>
</div>`.trim();

  const text = [
    `Hi ${member.name || "there"},`,
    "",
    "Welcome to WLTH WLKS. Our community lives on Slack.",
    "",
    `1. Join the workspace: ${workspaceJoinUrl}`,
    `2. Join your city channel (${member.cityChannelName || member.city})`,
    `3. Join ${allMembers.name}`,
    "",
    support ? `Questions? ${support}` : "Questions? Reply to this email.",
    "",
    "— WLTH WLKS",
  ].join("\n");

  return {
    recipient: member.primaryEmail,
    subject,
    memberName: member.name,
    city: member.city,
    workspaceJoinUrl,
    cityChannelName: member.cityChannelName || member.city,
    cityChannelUrl,
    allMembersChannelName: allMembers.name,
    allMembersChannelUrl,
    html,
    text,
    missingConfig,
    eligible: eligibility.ok && missingConfig.length === 0,
    eligibilityReasons: [...eligibility.reasons, ...missingConfig.map((c) => `Missing ${c}`)],
  };
}

export async function sendSlackJoinEmail(input: {
  member: MemberHealthRow;
  replyTo?: string;
}): Promise<{ ok: true; resendMessageId: string } | { ok: false; error: string }> {
  const preview = buildSlackJoinEmailPreview(input.member);
  if (!preview.eligible) {
    return { ok: false, error: preview.eligibilityReasons.join("; ") };
  }
  const apiKey = process.env.RESEND_API_KEY!;
  const fromEmail = process.env.RESEND_FROM_EMAIL!;
  const client = createResendClient({ apiKey, fromEmail });
  const support = (process.env.OPS_SUPPORT_EMAIL || "").trim();
  const result = await client.sendEmail(preview.recipient, preview.subject, preview.html, {
    replyTo: input.replyTo || support || undefined,
  });
  if (!result?.id) {
    return { ok: false, error: "Resend did not accept the message" };
  }
  return { ok: true, resendMessageId: result.id };
}

