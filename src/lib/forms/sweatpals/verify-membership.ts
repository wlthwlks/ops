/**
 * SweatPals membership verification (server-side).
 *
 * Flow: the signup widget forwards SweatPals checkout events (email typed in
 * the widget, purchase) → this module looks the member up on SweatPals via the
 * external API (lookup-only), upserts rows into `sweatpals_memberships`, and
 * mirrors the derived state to the existing Airtable billing columns
 * (Membership / Payment / Service access until) so every existing reader
 * (widgets, scripts, crons) keeps working unchanged.
 *
 * SweatPals remains the source of truth; this is the linking layer between
 * SweatPals and our member records.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { sweatpalsMemberships } from "@/db/schema";
import {
  getMemberMemberships,
  getSweatpalsApiConfig,
  SweatpalsApiError,
  type SweatpalsMembershipItem,
  type SweatpalsMembershipsPage,
} from "@/lib/integrations/sweatpals";
import { MEMBER_FIELDS, MEMBERS_TABLE } from "@/lib/ops/airtable-fields";
import {
  findMemberByMemberstackId,
  getFormsAirtableClient,
} from "@/lib/forms/airtable/members-sync";
import { stripComputedMemberWriteFields } from "@/lib/forms/airtable/write-guards";
import { sanitizeMembersWriteFields } from "@/lib/ops/airtable-fields";
import { getFormFeatureFlags } from "@/lib/forms/feature-flags";
import { isInProgressOnboarding } from "@/lib/forms/onboarding/onboarding-status";
import type { AirtableClient } from "@/lib/integrations/airtable";

export type SweatpalsVerifyInput = {
  /** Our member account id (Memberstack id). */
  memberstackId: string;
  /** Our member's email — fallback lookup when the widget email is missing. */
  memberEmail?: string;
  /** Email typed inside the SweatPals checkout — authoritative lookup key. */
  lookupEmail?: string;
  /** Phone as typed in the SweatPals checkout. */
  lookupPhone?: string;
};

export type SweatpalsVerifyResult = {
  success: boolean;
  /**
   * active | paused | inactive | unresolved | not_configured | api_error |
   * airtable_member_not_found
   */
  status: string;
  /** True when SweatPals reports at least one active membership. */
  membershipConfirmed: boolean;
  active: boolean;
  paused: boolean;
  count: number;
  shadowed: boolean;
  reason?: string;
  sweeatpalsMemberId?: string;
};

type LookupOutcome =
  | { kind: "resolved"; page: SweatpalsMembershipsPage; via: string }
  | { kind: "not_found"; via: string };

function lookupCandidates(input: SweatpalsVerifyInput): {
  key: string;
  email?: string;
  phone?: string;
}[] {
  const out: { key: string; email?: string; phone?: string }[] = [];
  const seen = new Set<string>();
  const push = (key: string, email?: string, phone?: string) => {
    if (email) email = email.trim().toLowerCase();
    if (phone) phone = phone.trim();
    const dedupe = `${key}:${email ?? ""}:${phone ?? ""}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    if (email || phone) out.push({ key, email, phone });
  };
  push("widget_email", input.lookupEmail);
  push("member_email", input.memberEmail);
  push("widget_phone", undefined, input.lookupPhone);
  return out;
}

async function lookupSweatpals(
  input: SweatpalsVerifyInput
): Promise<LookupOutcome | { kind: "error"; message: string }> {
  for (const candidate of lookupCandidates(input)) {
    try {
      const page = await getMemberMemberships({
        email: candidate.email,
        phone: candidate.phone,
        pageSize: 100,
      });
      if (page === null) {
        // 404 — member unresolved for this community; try the next key.
        continue;
      }
      return { kind: "resolved", page, via: candidate.key };
    } catch (e) {
      if (e instanceof SweatpalsApiError) {
        return { kind: "error", message: e.message };
      }
      return {
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
  return { kind: "not_found", via: "all" };
}

function isoDateOrNull(raw: string | null | undefined): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Upsert the SweatPals list into `sweatpals_memberships`, keyed by SweatPals id. */
async function upsertMembershipsRows(input: {
  memberstackId: string;
  items: SweatpalsMembershipItem[];
  viaEmail?: string | null;
  viaPhone?: string | null;
}): Promise<void> {
  if (input.items.length === 0) return;
  const rows = input.items.map((item) => ({
    id: item.id,
    memberId: input.memberstackId,
    membershipId: item.membershipId || null,
    membershipTierId: item.membershipTierId || null,
    membershipName: item.membershipName || null,
    active: Boolean(item.active),
    paused: Boolean(item.paused),
    pauseFuturePayments: Boolean(item.pauseFuturePayments),
    isClaimed: Boolean(item.isClaimed),
    actualFrom: item.actualFrom ? new Date(item.actualFrom) : null,
    actualTo: item.actualTo ? new Date(item.actualTo) : null,
    expireDate: item.expireDate ? new Date(item.expireDate) : null,
    cancellationEffectiveAt: item.cancellationEffectiveAt
      ? new Date(item.cancellationEffectiveAt)
      : null,
    sweatpalsEmail: input.viaEmail || null,
    sweatpalsPhone: input.viaPhone || null,
    lastSyncedAt: new Date(),
  }));

  await db
    .insert(sweatpalsMemberships)
    .values(rows)
    .onConflictDoUpdate({
      target: sweatpalsMemberships.id,
      set: {
        memberId: sql`excluded.member_id`,
        membershipId: sql`excluded.membership_id`,
        membershipTierId: sql`excluded.membership_tier_id`,
        membershipName: sql`excluded.membership_name`,
        active: sql`excluded.active`,
        paused: sql`excluded.paused`,
        pauseFuturePayments: sql`excluded.pause_future_payments`,
        isClaimed: sql`excluded.is_claimed`,
        actualFrom: sql`excluded.actual_from`,
        actualTo: sql`excluded.actual_to`,
        expireDate: sql`excluded.expire_date`,
        cancellationEffectiveAt: sql`excluded.cancellation_effective_at`,
        sweatpalsEmail: sql`excluded.sweatpals_email`,
        sweatpalsPhone: sql`excluded.sweatpals_phone`,
        lastSyncedAt: sql`excluded.last_synced_at`,
      },
    });
}

function deriveState(items: SweatpalsMembershipItem[]): {
  active: boolean;
  paused: boolean;
  accessUntil: string | null;
  cancelled: boolean;
  activeItem: SweatpalsMembershipItem | null;
} {
  const activeItems = items.filter((i) => i.active);
  if (activeItems.length > 0) {
    const sorted = [...activeItems].sort(
      (a, b) =>
        new Date(b.actualTo || 0).getTime() - new Date(a.actualTo || 0).getTime()
    );
    const best = sorted[0];
    return {
      active: true,
      paused: false,
      accessUntil: isoDateOrNull(best.actualTo || best.expireDate),
      cancelled: false,
      activeItem: best,
    };
  }
  const paused = items.some((i) => i.paused || i.pauseFuturePayments);
  const cancelled = items.some((i) => i.cancellationEffectiveAt);
  const latest = items
    .filter((i) => i.actualTo)
    .sort(
      (a, b) =>
        new Date(b.actualTo || 0).getTime() - new Date(a.actualTo || 0).getTime()
    )[0];
  return {
    active: false,
    paused,
    accessUntil: isoDateOrNull(latest?.actualTo),
    cancelled,
    activeItem: null,
  };
}

/** Billing mirror writes always apply unless full MAKE_SHADOW_MODE. */
function canWriteBillingToAirtable(): boolean {
  return !getFormFeatureFlags().makeShadowMode;
}

async function mirrorToAirtable(input: {
  memberstackId: string;
  state: ReturnType<typeof deriveState>;
  activeMembershipId?: string;
  airtable?: AirtableClient;
}): Promise<{ status: string; shadowed: boolean }> {
  const airtable = input.airtable ?? getFormsAirtableClient();
  const matches = await findMemberByMemberstackId(input.memberstackId, airtable);
  if (matches.length === 0) {
    return { status: "airtable_member_not_found", shadowed: false };
  }
  const record = matches[0];

  const patch: Record<string, unknown> = {
    [MEMBER_FIELDS.billingLastSyncedAt]: new Date().toISOString(),
  };
  if (input.state.active) {
    patch[MEMBER_FIELDS.membership] = "Active";
    patch[MEMBER_FIELDS.payment] = "Paid";
    if (input.state.accessUntil) {
      patch[MEMBER_FIELDS.serviceAccessUntil] = input.state.accessUntil;
    }
  } else if (input.state.paused) {
    patch[MEMBER_FIELDS.membership] = "Active";
    patch[MEMBER_FIELDS.payment] = "Paid";
    if (input.state.accessUntil) {
      patch[MEMBER_FIELDS.serviceAccessUntil] = input.state.accessUntil;
    }
  } else if (input.state.cancelled) {
    patch[MEMBER_FIELDS.membership] = "Cancelled";
  } else {
    patch[MEMBER_FIELDS.membership] = "Expired";
  }

  const currentStatus = String(
    record.fields[MEMBER_FIELDS.onboardingStatus] ?? ""
  ).trim();
  if (input.state.active && isInProgressOnboarding(currentStatus)) {
    patch[MEMBER_FIELDS.onboardingStatus] = "PAYMENT_CONFIRMED";
  }

  const safe = sanitizeMembersWriteFields(
    stripComputedMemberWriteFields(patch),
    "update"
  );

  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(safe)) {
    const from = record.fields[k] ?? null;
    if (String(from ?? "") !== String(v ?? "")) {
      changed[k] = { from, to: v };
    }
  }
  if (Object.keys(changed).length > 0) {
    console.error(
      JSON.stringify({
        event: "billing_write",
        source: "sweatpals_verify",
        memberstackId: input.memberstackId,
        airtableRecordId: record.id,
        changed,
      })
    );
  }

  if (!canWriteBillingToAirtable()) {
    return { status: "shadowed", shadowed: true };
  }

  await airtable.updateRecords(
    MEMBERS_TABLE,
    [{ id: record.id, fields: safe }],
    { typecast: true }
  );
  return { status: "updated", shadowed: false };
}

export async function verifySweatpalsMembershipForMember(
  input: SweatpalsVerifyInput
): Promise<SweatpalsVerifyResult> {
  const memberstackId = input.memberstackId.trim();
  if (!memberstackId) {
    return {
      success: false,
      status: "invalid_input",
      membershipConfirmed: false,
      active: false,
      paused: false,
      count: 0,
      shadowed: false,
      reason: "Missing member identity",
    };
  }

  // Fail closed but clearly when the SweatPals key is not provisioned yet.
  try {
    getSweatpalsApiConfig();
  } catch {
    return {
      success: false,
      status: "not_configured",
      membershipConfirmed: false,
      active: false,
      paused: false,
      count: 0,
      shadowed: false,
      reason: "SweatPals API is not configured (SWEATPALS_API_KEY / SWEATPALS_COMMUNITY_ID)",
    };
  }

  const outcome = await lookupSweatpals(input);
  if (outcome.kind === "error") {
    console.error(
      JSON.stringify({
        event: "sweatpals_lookup_error",
        memberstackId,
        error: outcome.message,
      })
    );
    return {
      success: false,
      status: "api_error",
      membershipConfirmed: false,
      active: false,
      paused: false,
      count: 0,
      shadowed: false,
      reason: outcome.message,
    };
  }
  if (outcome.kind === "not_found") {
    return {
      success: true,
      status: "unresolved",
      membershipConfirmed: false,
      active: false,
      paused: false,
      count: 0,
      shadowed: false,
      reason: "No SweatPals membership found for this member",
    };
  }

  const items = outcome.page.list;
  const state = deriveState(items);

  await upsertMembershipsRows({
    memberstackId,
    items,
    viaEmail: outcome.via.startsWith("widget_email") || outcome.via === "member_email"
      ? (input.lookupEmail || input.memberEmail || "").trim().toLowerCase() || null
      : null,
    viaPhone: outcome.via === "widget_phone" ? (input.lookupPhone || "").trim() || null : null,
  });

  const mirror = await mirrorToAirtable({
    memberstackId,
    state,
    activeMembershipId: state.activeItem?.id,
  });

  return {
    success: true,
    status: state.active ? "active" : state.paused ? "paused" : mirror.status === "airtable_member_not_found" ? mirror.status : "inactive",
    membershipConfirmed: state.active,
    active: state.active,
    paused: state.paused,
    count: items.length,
    shadowed: mirror.shadowed,
    sweeatpalsMemberId: state.activeItem?.id,
    reason: mirror.status === "airtable_member_not_found"
      ? "SweatPals membership found, but no Airtable member record exists yet"
      : undefined,
  };
}
