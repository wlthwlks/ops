/**
 * Memberstack webhook business handlers.
 * Exact event type strings are normalized (catalog may vary).
 */
import {
  findMemberByMemberstackId,
  upsertMinimalSignupMember,
  updateMemberBilling,
  updateMemberProfile,
} from "@/lib/forms/airtable/members-sync";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { canApplyMemberstackWebhooks } from "@/lib/forms/feature-flags";
import { recordIntegrationError } from "@/lib/forms/webhooks/store";
import { FormsError } from "@/lib/forms/errors";

function normalizeEventType(type: string): string {
  return type.toLowerCase().replace(/_/g, ".");
}

function pickMember(payload: Record<string, unknown>) {
  const data = (payload.data as Record<string, unknown>) || payload;
  const member = (data.member as Record<string, unknown>) || data;
  const id = String(member.id || member.memberId || data.memberId || "").trim();
  const email = String(member.email || (member.auth as { email?: string })?.email || "")
    .trim()
    .toLowerCase();
  const custom = (member.customFields as Record<string, unknown>) || {};
  return {
    id,
    email,
    firstName: String(custom["first-name"] || custom.firstName || member.firstName || "").trim(),
    lastName: String(custom["last-name"] || custom.lastName || member.lastName || "").trim(),
    planId: String(
      data.planId || (data.plan as { id?: string })?.id || member.planId || ""
    ).trim(),
    stripeCustomerId: String(
      member.stripeCustomerId ||
        data.stripeCustomerId ||
        (data.stripe as { customerId?: string })?.customerId ||
        ""
    ).trim(),
  };
}

export async function handleMemberstackEvent(input: {
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<{ processed: boolean; status: string; reason: string }> {
  if (!canApplyMemberstackWebhooks()) {
    return {
      processed: false,
      status: "ignored_flag_off",
      reason: "NEW_MEMBERSTACK_WEBHOOKS_ENABLED is false (or shadow mode)",
    };
  }

  const type = normalizeEventType(input.eventType);
  const m = pickMember(input.payload);

  if (type.includes("member.created") || type.endsWith("member.created")) {
    if (!m.id || !m.email) {
      throw new FormsError("WEBHOOK_PAYLOAD_INVALID", "member.created missing id/email");
    }
    await upsertMinimalSignupMember({
      memberstackId: m.id,
      email: m.email,
      firstName: m.firstName || "Member",
      lastName: m.lastName || "",
      source: "memberstack_webhook",
    });
    return { processed: true, status: "succeeded", reason: "Minimal member ensured" };
  }

  if (type.includes("member.updated")) {
    if (!m.id) throw new FormsError("WEBHOOK_PAYLOAD_INVALID", "member.updated missing id");
    const found = await findMemberByMemberstackId(m.id);
    if (found.length === 0) {
      await recordIntegrationError({
        code: "MEMBERSTACK_MEMBER_NOT_FOUND",
        source: "memberstack",
        operation: input.eventType,
        title: "Memberstack update without Airtable member",
        message: m.id,
        memberstackId: m.id,
      });
      return { processed: true, status: "failed", reason: "Airtable member not found" };
    }
    const patch: Record<string, unknown> = {};
    if (m.email) patch[MEMBER_FIELDS.email] = m.email;
    if (m.firstName) patch[MEMBER_FIELDS.firstName] = m.firstName;
    if (m.lastName) patch[MEMBER_FIELDS.lastName] = m.lastName;
    if (Object.keys(patch).length === 0) {
      return { processed: true, status: "ignored", reason: "No-op update" };
    }
    await updateMemberProfile({ memberstackId: m.id, patch });
    return { processed: true, status: "succeeded", reason: "Identity reconciled" };
  }

  if (type.includes("plan.added") || type.includes("plan.created")) {
    if (!m.id) throw new FormsError("WEBHOOK_PAYLOAD_INVALID", "plan event missing member id");
    const found = await findMemberByMemberstackId(m.id);
    if (found.length === 0) {
      await recordIntegrationError({
        code: "MEMBERSTACK_MEMBER_NOT_FOUND",
        source: "memberstack",
        operation: input.eventType,
        title: "Plan added but Airtable member missing",
        message: m.id,
        memberstackId: m.id,
        retryable: true,
      });
      return { processed: true, status: "pending_dependency", reason: "Member missing" };
    }
    const patch: Record<string, unknown> = {
      [MEMBER_FIELDS.membership]: "Active",
      [MEMBER_FIELDS.payment]: "Paid",
      [MEMBER_FIELDS.onboardingStatus]: "PAYMENT_CONFIRMED",
    };
    if (m.stripeCustomerId.startsWith("cus_")) {
      patch[MEMBER_FIELDS.stripeCustomerId] = m.stripeCustomerId;
      await updateMemberBilling({
        stripeCustomerId: m.stripeCustomerId,
        patch,
      });
    } else {
      await updateMemberProfile({ memberstackId: m.id, patch });
    }
    return { processed: true, status: "succeeded", reason: "Plan added reconciled" };
  }

  if (type.includes("plan.canceled") || type.includes("plan.cancelled")) {
    // Reconciliation only — Stripe subscription state is authoritative for access end
    if (m.stripeCustomerId.startsWith("cus_")) {
      await updateMemberBilling({
        stripeCustomerId: m.stripeCustomerId,
        patch: {
          [MEMBER_FIELDS.cancelAtPeriodEnd]: "true",
          [MEMBER_FIELDS.cancellationRequestedAt]: new Date().toISOString(),
        },
      });
    }
    return { processed: true, status: "succeeded", reason: "Plan cancel noted" };
  }

  if (type.includes("member.deleted")) {
    if (m.id) {
      await updateMemberProfile({
        memberstackId: m.id,
        patch: {
          [MEMBER_FIELDS.onboardingStatus]: "ACCOUNT_DELETED",
          [MEMBER_FIELDS.lastFormSource]: "memberstack_deleted",
        },
      }).catch(async () => {
        await recordIntegrationError({
          code: "MEMBERSTACK_MEMBER_NOT_FOUND",
          source: "memberstack",
          operation: input.eventType,
          title: "Member deleted — no Airtable row",
          message: m.id,
          memberstackId: m.id,
        });
      });
    }
    return { processed: true, status: "succeeded", reason: "Soft-deleted mark" };
  }

  return {
    processed: false,
    status: "ignored",
    reason: `Unsupported Memberstack event: ${input.eventType}`,
  };
}
