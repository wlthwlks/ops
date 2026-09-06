import { eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  introductionRuns,
  introductionGroups,
  introductionGroupMembers,
  introductionDeliveries,
  type IntroductionGroupMember,
} from "@/db/schema";
import { createResendClient } from "@/lib/integrations/resend";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { MEMBERS_TABLE, MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { getGlobalIntroductionConfig } from "./settings";
import { isValidEmail, memberKey } from "./member-eligibility";
import type { PlanMemberRegistryEntry } from "./plan";

/**
 * Resend a single member's introduction email on demand. Reuses the group's
 * frozen subject/html snapshots (the exact same email), refreshes the
 * member's current address from Airtable by record id, and sends directly
 * through Resend. A new delivery row records the resend in the ledger so
 * provider webhook events still attach by message id.
 */

export class ResendMemberError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ResendMemberError";
  }
}

export interface ResendMemberResult {
  groupId: string;
  deliveryId: string;
  to: string;
  resendMessageId: string | null;
  replyTo: string[];
  refreshedEmail: { oldEmail: string; newEmail: string } | null;
}

function parseSnapshot(member: IntroductionGroupMember): PlanMemberRegistryEntry | null {
  if (!member.memberSnapshotJson) return null;
  try {
    return JSON.parse(member.memberSnapshotJson) as PlanMemberRegistryEntry;
  } catch {
    return null;
  }
}

function memberMatches(member: IntroductionGroupMember, requestedKey: string): boolean {
  const snapshot = parseSnapshot(member);
  const keys = new Set([
    snapshot?.key,
    memberKey(snapshot?.email ?? member.emailSnapshot, snapshot?.airtableRecordId ?? member.airtableRecordId),
    member.emailSnapshot.trim().toLowerCase(),
  ]);
  return keys.has(requestedKey);
}

function parseOriginalTo(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through
  }
  return null;
}

export async function resendGroupMemberEmail(
  db: AppDb,
  groupId: string,
  requestedMemberKey: string
): Promise<ResendMemberResult> {
  const groupRows = await db
    .select()
    .from(introductionGroups)
    .where(eq(introductionGroups.id, groupId))
    .limit(1);
  const group = groupRows[0];
  if (!group) {
    throw new ResendMemberError("GROUP_NOT_FOUND", `Group ${groupId} not found`);
  }

  const runRows = await db
    .select()
    .from(introductionRuns)
    .where(eq(introductionRuns.id, group.runId))
    .limit(1);
  const run = runRows[0];
  if (!run) {
    throw new ResendMemberError(
      "RUN_NOT_FOUND",
      `Run ${group.runId} not found for group ${groupId}`
    );
  }
  if (run.deliveryMode === "simulation") {
    throw new ResendMemberError(
      "GROUP_SIMULATION_MODE",
      "This run is in simulation mode and cannot be resent"
    );
  }

  if (!group.emailHtmlSnapshot) {
    throw new ResendMemberError(
      "GROUP_NOT_RENDERED",
      `Group ${groupId} has no frozen email to resend`
    );
  }

  const memberRows = await db
    .select()
    .from(introductionGroupMembers)
    .where(eq(introductionGroupMembers.groupId, groupId));
  const target = memberRows.find((member) => memberMatches(member, requestedMemberKey));
  if (!target) {
    throw new ResendMemberError(
      "MEMBER_NOT_FOUND",
      `No member "${requestedMemberKey}" in group ${groupId}`
    );
  }
  const targetSnapshot = parseSnapshot(target);

  // Fresh address from Airtable by record id — the stored snapshot may
  // itself be the reason the member never received the email.
  const oldEmail = (targetSnapshot?.email ?? target.emailSnapshot).trim().toLowerCase();
  let newEmail = oldEmail;
  if (target.airtableRecordId) {
    const token = process.env.AIRTABLE_GET_DATA_TOKEN;
    const baseId = process.env.AIRTABLE_BASE_ID;
    if (!token || !baseId) {
      throw new ResendMemberError(
        "AIRTABLE_NOT_CONFIGURED",
        "Airtable credentials are not configured"
      );
    }
    const airtable = createAirtableClient({ apiKey: token, baseId });
    const records = await airtable.listRecords(MEMBERS_TABLE, {
      fields: [MEMBER_FIELDS.email, MEMBER_FIELDS.slackEmail],
      filterByFormula: `RECORD_ID() = "${target.airtableRecordId}"`,
    });
    const fresh = records[0]
      ? String(records[0].fields[MEMBER_FIELDS.email] ?? "").trim().toLowerCase()
      : "";
    if (fresh) newEmail = fresh;
  }
  if (!isValidEmail(newEmail)) {
    throw new ResendMemberError(
      "MEMBER_EMAIL_INVALID",
      newEmail
        ? `Airtable email "${newEmail}" is not a valid address`
        : "Member has no email in Airtable"
    );
  }

  // Reply-to the rest of the group so "Reply all" still reaches everyone.
  const targetDeliveryRows = await db
    .select()
    .from(introductionDeliveries)
    .where(eq(introductionDeliveries.groupId, groupId));
  const targetDelivery =
    targetDeliveryRows.find(
      (delivery) =>
        (target.airtableRecordId && delivery.airtableRecordId === target.airtableRecordId) ||
        delivery.recipientEmail.trim().toLowerCase() === oldEmail
    ) ?? targetDeliveryRows[0];
  const originalTo = parseOriginalTo(targetDelivery?.originalToJson ?? null);
  let replyTo: string[];
  if (originalTo && originalTo.length > 0) {
    replyTo = originalTo.filter((addr) => addr.trim().toLowerCase() !== oldEmail);
  } else {
    replyTo = memberRows
      .filter((member) => member.id !== target.id)
      .map((member) => (parseSnapshot(member)?.email ?? member.emailSnapshot).trim().toLowerCase())
      .filter((email) => isValidEmail(email));
  }
  replyTo = [...new Set(replyTo)];

  // Redirected modes keep their redirect target; production goes straight
  // to the member. The audit trail keeps the fresh address.
  let originalToJson = targetDelivery?.originalToJson ?? null;
  if (originalToJson) {
    const parsed = parseOriginalTo(originalToJson);
    if (parsed) {
      originalToJson = JSON.stringify(
        parsed.map((entry) =>
          String(entry).trim().toLowerCase() === oldEmail ? newEmail : entry
        )
      );
    }
  }
  const deliverToEmail =
    originalToJson && targetDelivery ? targetDelivery.deliverToEmail : newEmail;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new ResendMemberError("RESEND_NOT_CONFIGURED", "RESEND_API_KEY is not configured");
  }
  const global = await getGlobalIntroductionConfig(db);
  const senderFrom = global.senderFrom;
  const subject = group.emailSubjectSnapshot ?? `Introductions for ${group.cityName ?? "your city"}`;
  const html = group.emailHtmlSnapshot;
  const deliveryId = crypto.randomUUID();

  const resend = createResendClient({ apiKey, fromEmail: senderFrom });
  const sent = await resend.sendEmailToMany({
    to: [deliverToEmail],
    from: senderFrom,
    subject,
    html,
    replyTo,
    idempotencyKey: `intro-resend-${deliveryId}`,
  });

  await db.insert(introductionDeliveries).values({
    id: deliveryId,
    runId: run.id,
    groupId: group.id,
    recipientEmail: newEmail,
    recipientName: targetSnapshot?.name ?? null,
    airtableRecordId: target.airtableRecordId,
    originalToJson,
    deliverToEmail,
    deliveryKey: `resend:${group.id}:${deliveryId}`,
    status: sent ? "sent" : "failed",
    resendMessageId: sent?.id ?? null,
    attemptCount: 0,
    error: sent ? null : "Resend send failure",
    sentAt: sent ? new Date() : null,
    completedAt: sent ? null : new Date(),
  });

  if (!sent) {
    throw new ResendMemberError(
      "SEND_FAILED",
      `Failed to resend the email to ${deliverToEmail}`
    );
  }

  return {
    groupId,
    deliveryId,
    to: deliverToEmail,
    resendMessageId: sent.id,
    replyTo,
    refreshedEmail: newEmail === oldEmail ? null : { oldEmail, newEmail },
  };
}
