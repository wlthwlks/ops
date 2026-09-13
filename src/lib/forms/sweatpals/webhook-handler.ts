/**
 * SweatPals webhook business handlers.
 *
 * SweatPals sends membership lifecycle events (created/updated/paused/
 * cancelled/payment state) for our community. The handler extracts the buyer
 * identity (email / phone / userToMembershipId), then runs the same
 * reconcile pipeline as the signup and cron paths — SweatPals external API
 * lookup → local snapshot upsert → Airtable billing mirror. The external API
 * lookup (by email/phone) remains the source of truth; webhooks only
 * trigger the sync so state changes propagate immediately instead of on the
 * daily reconcile.
 */
import { db } from "@/db";
import { sweatpalsMemberships } from "@/db/schema";
import { eq } from "drizzle-orm";
import { canApplySweatpalsWebhooks } from "@/lib/forms/feature-flags";
import { reconcileSweatpalsMember } from "@/lib/forms/sweatpals/verify-membership";

export function normalizeSweatpalsEventType(type: string): string {
  return type.toLowerCase().replace(/_/g, ".").trim();
}

function isRelevantSweatpalsEvent(eventType: string): boolean {
  return /^(membership|payment|billing|subscription)/.test(eventType);
}

/** SweatPals envelopes may nest under data/payload; flatten for extraction. */
export function unwrapSweatpalsEnvelope(
  payload: Record<string, unknown>
): Record<string, unknown> {
  if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload.data as Record<string, unknown>;
  }
  if (
    payload.payload &&
    typeof payload.payload === "object" &&
    !Array.isArray(payload.payload)
  ) {
    return payload.payload as Record<string, unknown>;
  }
  return payload;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

export type SweatpalsWebhookIdentity = {
  email: string;
  phone: string;
  userToMembershipId: string;
  membershipId: string;
  membershipTierId: string;
  communityId: string;
};

export function pickSweatpalsIdentity(
  payload: Record<string, unknown>
): SweatpalsWebhookIdentity {
  const data = unwrapSweatpalsEnvelope(payload);
  const member =
    data.member && typeof data.member === "object" && !Array.isArray(data.member)
      ? (data.member as Record<string, unknown>)
      : data;
  const membership =
    data.membership && typeof data.membership === "object" && !Array.isArray(data.membership)
      ? (data.membership as Record<string, unknown>)
      : {};

  return {
    email: firstString(member, [
      "email",
      "memberEmail",
      "member_email",
      "buyerEmail",
      "customerEmail",
      "customer_email",
    ]).toLowerCase(),
    phone: firstString(member, ["phone", "memberPhone", "member_phone", "phoneNumber", "phone_number"]),
    userToMembershipId: firstString(data, [
      "userToMembershipId",
      "user_to_membership_id",
      "id",
    ]) || firstString(membership, ["userToMembershipId", "user_to_membership_id"]),
    membershipId: firstString(data, ["membershipId", "membership_id"]) ||
      firstString(membership, ["membershipId", "membership_id", "id"]),
    membershipTierId: firstString(data, ["membershipTierId", "membership_tier_id", "tierId", "tier_id"]) ||
      firstString(membership, ["membershipTierId", "membership_tier_id", "tierId", "tier_id"]),
    communityId: firstString(data, ["communityId", "community_id"]),
  };
}

/** Resolve local linkage (memberId / stored email) for a userToMembershipId. */
export async function findSweatpalsRowById(
  userToMembershipId: string
): Promise<{
  memberId: string | null;
  sweatpalsEmail: string | null;
  sweatpalsPhone: string | null;
} | null> {
  try {
    const rows = await db
      .select({
        memberId: sweatpalsMemberships.memberId,
        sweatpalsEmail: sweatpalsMemberships.sweatpalsEmail,
        sweatpalsPhone: sweatpalsMemberships.sweatpalsPhone,
      })
      .from(sweatpalsMemberships)
      .where(eq(sweatpalsMemberships.id, userToMembershipId))
      .limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function handleSweatpalsEvent(input: {
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<{ processed: boolean; status: string; reason: string }> {
  if (!canApplySweatpalsWebhooks()) {
    return {
      processed: false,
      status: "ignored_flag_off",
      reason: "SWEATPALS_WEBHOOKS_ENABLED is false (or shadow mode)",
    };
  }

  const normalized = normalizeSweatpalsEventType(input.eventType);
  if (!normalized) {
    return { processed: false, status: "ignored_no_type", reason: "Missing event type" };
  }
  if (!isRelevantSweatpalsEvent(normalized)) {
    return {
      processed: false,
      status: "ignored_irrelevant",
      reason: `Event type not membership-related: ${normalized}`,
    };
  }

  const identity = pickSweatpalsIdentity(input.payload);

  let memberstackId: string | undefined;
  const emails: (string | undefined)[] = [];
  let phone: string | undefined;

  if (identity.email) emails.push(identity.email);
  if (identity.userToMembershipId) {
    const row = await findSweatpalsRowById(identity.userToMembershipId);
    if (row) {
      if (row.memberId) memberstackId = row.memberId;
      if (row.sweatpalsEmail) emails.push(row.sweatpalsEmail);
      if (row.sweatpalsPhone) phone = row.sweatpalsPhone;
    }
  }
  if (identity.phone) phone = identity.phone;

  if (emails.length === 0 && !phone) {
    return {
      processed: false,
      status: "ignored_no_identity",
      reason: "No email/phone/userToMembershipId identity in payload",
    };
  }

  const result = await reconcileSweatpalsMember({
    memberstackId,
    emails,
    phone,
    mirrorEmail: emails[0],
    dryRun: false,
  });

  if (result.status === "api_error" || result.status === "not_configured") {
    return {
      processed: false,
      status: "failed",
      reason: result.reason || result.status,
    };
  }

  return {
    processed: true,
    status: "succeeded",
    reason: `sync=${result.status} mirror=${result.mirrorStatus}`,
  };
}
