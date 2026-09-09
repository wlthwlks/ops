import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  introductionRuns,
  introductionGroups,
  introductionGroupMembers,
  introductionDeliveries,
  type IntroductionGroupMember,
} from "@/db/schema";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { MEMBERS_TABLE, MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { deliveryKeyFor } from "./freeze";
import { isValidEmail, memberKey } from "./member-eligibility";

/**
 * Retry a failed introduction group. Re-fetches the failed members from
 * Airtable by their record id (NOT by the stored email snapshot — the
 * stored address may itself be the reason the send failed), refreshes the
 * member/delivery rows with the current Airtable email, and re-queues the
 * group so the delivery worker can claim and send it again.
 */

export class ResendGroupError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ResendGroupError";
  }
}

export interface ResendGroupResult {
  groupId: string;
  runId: string;
  reQueuedDeliveries: number;
  refreshedMembers: Array<{
    airtableRecordId: string | null;
    oldEmail: string;
    newEmail: string;
  }>;
  skippedDeliveries: Array<{
    deliveryId: string;
    reason: string;
  }>;
}

interface DeliveryWithMember {
  deliveryId: string;
  recipientEmail: string;
  airtableRecordId: string | null;
  originalToJson: string | null;
  deliverToEmail: string;
}

function freshAirtableClient() {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    throw new ResendGroupError(
      "AIRTABLE_NOT_CONFIGURED",
      "Airtable credentials are not configured"
    );
  }
  return createAirtableClient({ apiKey: token, baseId });
}

export async function reQueueFailedGroupDeliveries(
  db: AppDb,
  groupId: string
): Promise<ResendGroupResult> {
  const groupRows = await db
    .select()
    .from(introductionGroups)
    .where(eq(introductionGroups.id, groupId))
    .limit(1);
  const group = groupRows[0];
  if (!group) {
    throw new ResendGroupError("GROUP_NOT_FOUND", `Group ${groupId} not found`);
  }

  const runRows = await db
    .select()
    .from(introductionRuns)
    .where(eq(introductionRuns.id, group.runId))
    .limit(1);
  const run = runRows[0];
  if (!run) {
    throw new ResendGroupError(
      "RUN_NOT_FOUND",
      `Run ${group.runId} not found for group ${groupId}`
    );
  }
  if (run.deliveryMode === "simulation") {
    throw new ResendGroupError(
      "GROUP_SIMULATION_MODE",
      "This run is in simulation mode and cannot be resent"
    );
  }

  const failedDeliveries = await db
    .select()
    .from(introductionDeliveries)
    .where(
      and(eq(introductionDeliveries.groupId, groupId), eq(introductionDeliveries.status, "failed"))
    );
  if (failedDeliveries.length === 0) {
    throw new ResendGroupError(
      "NO_FAILED_DELIVERIES",
      "Group has no failed deliveries to retry"
    );
  }

  const memberRows = await db
    .select()
    .from(introductionGroupMembers)
    .where(eq(introductionGroupMembers.groupId, groupId));
  const memberByEmail = new Map<string, IntroductionGroupMember>();
  const memberByRecordId = new Map<string, IntroductionGroupMember>();
  for (const member of memberRows) {
    if (member.emailSnapshot) {
      memberByEmail.set(member.emailSnapshot.trim().toLowerCase(), member);
    }
    if (member.airtableRecordId) {
      memberByRecordId.set(member.airtableRecordId, member);
    }
  }

  const deliveries: DeliveryWithMember[] = failedDeliveries.map((delivery) => {
    const member =
      (delivery.airtableRecordId
        ? memberByRecordId.get(delivery.airtableRecordId)
        : undefined) ??
      memberByEmail.get(delivery.recipientEmail.trim().toLowerCase());
    return {
      deliveryId: delivery.id,
      recipientEmail: delivery.recipientEmail,
      airtableRecordId:
        delivery.airtableRecordId ?? member?.airtableRecordId ?? null,
      originalToJson: delivery.originalToJson,
      deliverToEmail: delivery.deliverToEmail,
    };
  });

  // Fresh member data from Airtable, resolved strictly by record id.
  const recordIds = [
    ...new Set(
      deliveries
        .map((d) => d.airtableRecordId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const emailByRecordId = new Map<string, string>();
  if (recordIds.length > 0) {
    const filter =
      recordIds.length === 1
        ? `RECORD_ID() = "${recordIds[0]}"`
        : `OR(${recordIds.map((id) => `RECORD_ID() = "${id}"`).join(",")})`;
    const airtable = freshAirtableClient();
    const records = await airtable.listRecords(MEMBERS_TABLE, {
      fields: [MEMBER_FIELDS.email, MEMBER_FIELDS.slackEmail],
      filterByFormula: filter,
    });
    for (const record of records) {
      const email = String(record.fields[MEMBER_FIELDS.email] ?? "").trim().toLowerCase();
      if (email) emailByRecordId.set(record.id, email);
    }
  }

  const refreshedMembers: ResendGroupResult["refreshedMembers"] = [];
  const skippedDeliveries: ResendGroupResult["skippedDeliveries"] = [];
  let reQueued = 0;

  for (const delivery of deliveries) {
    const recordId = delivery.airtableRecordId;
    if (!recordId) {
      skippedDeliveries.push({
        deliveryId: delivery.deliveryId,
        reason: "No Airtable record id stored for this delivery",
      });
      continue;
    }
    const newEmail = emailByRecordId.get(recordId);
    if (!newEmail || !isValidEmail(newEmail)) {
      skippedDeliveries.push({
        deliveryId: delivery.deliveryId,
        reason: newEmail
          ? `Airtable email "${newEmail}" is not a valid address`
          : "Member has no email in Airtable",
      });
      continue;
    }

    // Redirected modes keep their redirect target; the original recipient
    // list is updated so the audit trail reflects the fresh address.
    let originalToJson = delivery.originalToJson;
    if (originalToJson) {
      try {
        const parsed = JSON.parse(originalToJson) as unknown;
        if (Array.isArray(parsed)) {
          originalToJson = JSON.stringify(
            parsed.map((entry) =>
              String(entry).trim().toLowerCase() ===
              delivery.recipientEmail.trim().toLowerCase()
                ? newEmail
                : entry
            )
          );
        }
      } catch {
        originalToJson = null;
      }
    }

    await db
      .update(introductionDeliveries)
      .set({
        recipientEmail: newEmail,
        deliverToEmail: delivery.originalToJson ? delivery.deliverToEmail : newEmail,
        originalToJson,
        deliveryKey: deliveryKeyFor(groupId, newEmail),
        status: "pending",
        attemptCount: 0,
        error: null,
        nextRetryAt: null,
        claimedAt: null,
        sentAt: null,
        completedAt: null,
      })
      .where(eq(introductionDeliveries.id, delivery.deliveryId));
    reQueued += 1;
    refreshedMembers.push({
      airtableRecordId: recordId,
      oldEmail: delivery.recipientEmail,
      newEmail,
    });

    // Keep the group member row consistent with the delivery row.
    const member = memberByRecordId.get(recordId);
    if (member && member.emailSnapshot.trim().toLowerCase() !== newEmail) {
      let snapshotJson = member.memberSnapshotJson;
      if (snapshotJson) {
        try {
          const snapshot = JSON.parse(snapshotJson) as Record<string, unknown>;
          snapshot.email = newEmail;
          snapshot.key = memberKey(newEmail, recordId);
          snapshotJson = JSON.stringify(snapshot);
        } catch {
          // leave the snapshot untouched
        }
      }
      await db
        .update(introductionGroupMembers)
        .set({ emailSnapshot: newEmail, memberSnapshotJson: snapshotJson })
        .where(eq(introductionGroupMembers.id, member.id));
    }
  }

  if (reQueued === 0) {
    throw new ResendGroupError(
      "NO_DELIVERIES_REQUEUED",
      skippedDeliveries[0]?.reason ?? "No deliveries could be re-queued"
    );
  }

  await db
    .update(introductionGroups)
    .set({ status: "approved", sendError: null, claimedAt: null, attemptCount: 0 })
    .where(eq(introductionGroups.id, groupId));

  if (run.status !== "approved") {
    await db
      .update(introductionRuns)
      .set({ status: "approved", completedAt: null })
      .where(eq(introductionRuns.id, run.id));
  }

  return {
    groupId,
    runId: run.id,
    reQueuedDeliveries: reQueued,
    refreshedMembers,
    skippedDeliveries,
  };
}
