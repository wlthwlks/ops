/**
 * SweatPals membership verification + reconciliation (server-side).
 *
 * SweatPals is the source of truth for membership state. This module:
 *   1. looks a member up on SweatPals via the external API (lookup-only),
 *   2. upserts rows into `sweatpals_memberships` (keyed by SweatPals id),
 *   3. invalidates rows SweatPals no longer lists for the same email,
 *   4. mirrors the derived state to the existing Airtable billing columns
 *      (Membership / Payment / Service access until) so every existing
 *      reader (widgets, scripts, crons) keeps working unchanged.
 *
 * `verifySweatpalsMembershipForMember` is the signup-payment path (member
 * identity known). `reconcileSweatpalsMember` is the gating/reconcile path
 * (may only know the SweatPals email) — same logic, mirror falls back to
 * finding the Airtable member by normalized email.
 */
import { and, eq, notInArray, sql } from "drizzle-orm";
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
  findMemberByNormalizedEmail,
  getFormsAirtableClient,
} from "@/lib/forms/airtable/members-sync";
import { stripComputedMemberWriteFields } from "@/lib/forms/airtable/write-guards";
import { sanitizeMembersWriteFields } from "@/lib/ops/airtable-fields";
import { getFormFeatureFlags } from "@/lib/forms/feature-flags";
import { isInProgressOnboarding } from "@/lib/forms/onboarding/onboarding-status";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";

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
   * airtable_member_not_found | airtable_member_conflict
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

export type SweatpalsDerivedState = {
  active: boolean;
  paused: boolean;
  cancelled: boolean;
  /** ISO date (YYYY-MM-DD) of the authoritative access window end. */
  accessUntil: string | null;
  activeItem: SweatpalsMembershipItem | null;
};

type LookupOutcome =
  | {
      kind: "resolved";
      page: SweatpalsMembershipsPage;
      via: "email" | "phone";
      email?: string;
      phone?: string;
    }
  | { kind: "not_found"; via: string };

function lookupCandidates(
  emails: (string | undefined)[],
  phone?: string
): { key: string; email?: string; phone?: string }[] {
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
  for (const email of emails) push("email", email);
  push("phone", undefined, phone);
  return out;
}

async function lookupSweatpals(
  emails: (string | undefined)[],
  phone?: string
): Promise<LookupOutcome | { kind: "error"; message: string }> {
  for (const candidate of lookupCandidates(emails, phone)) {
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
      return {
        kind: "resolved",
        page,
        via: candidate.email ? "email" : "phone",
        email: candidate.email,
        phone: candidate.phone,
      };
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
  memberstackId?: string | null;
  items: SweatpalsMembershipItem[];
  viaEmail?: string | null;
  viaPhone?: string | null;
}): Promise<void> {
  if (input.items.length === 0) return;
  const rows = input.items.map((item) => ({
    id: item.id,
    memberId: input.memberstackId || null,
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
        // Preserve an existing member linkage when the reconcile only knows the email.
        memberId: sql`coalesce(excluded.member_id, sweatpals_memberships.member_id)`,
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

/**
 * SweatPals no longer lists these memberships for the resolved email — mark
 * them inactive so access gating never trusts a removed membership. When the
 * resolved list is empty, every row for that email is invalidated.
 */
async function invalidateMissingRows(
  email: string,
  listedIds: string[]
): Promise<void> {
  await db
    .update(sweatpalsMemberships)
    .set({ active: false, lastSyncedAt: new Date() })
    .where(
      and(
        eq(sweatpalsMemberships.sweatpalsEmail, email),
        listedIds.length > 0
          ? notInArray(sweatpalsMemberships.id, listedIds)
          : undefined
      )
    );
}

export function deriveSweatpalsState(
  items: SweatpalsMembershipItem[]
): SweatpalsDerivedState {
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
      cancelled: false,
      accessUntil: isoDateOrNull(best.actualTo || best.expireDate),
      activeItem: best,
    };
  }
  const now = new Date();
  // A pause only counts while its access window is still open — a paused
  // membership whose window already ended is simply inactive (expired).
  const windowEnded = (i: SweatpalsMembershipItem): boolean =>
    Boolean(i.actualTo && new Date(i.actualTo).getTime() <= now.getTime());
  const paused = items.some(
    (i) => (i.paused || i.pauseFuturePayments) && !windowEnded(i)
  );
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
    cancelled,
    accessUntil: isoDateOrNull(latest?.actualTo),
    activeItem: null,
  };
}

/** Billing mirror writes always apply unless full MAKE_SHADOW_MODE. */
function canWriteBillingToAirtable(): boolean {
  return !getFormFeatureFlags().makeShadowMode;
}

export type SweatpalsMirrorInput = {
  memberstackId?: string;
  /** Fallback identity when the member linkage is unknown (reconcile path). */
  email?: string;
  state: SweatpalsDerivedState;
  /** Compute + report the patch but never write Airtable. */
  dryRun?: boolean;
  airtable?: AirtableClient;
};

export type SweatpalsMirrorResult = {
  status:
    | "updated"
    | "shadowed"
    | "dry_run"
    | "airtable_member_not_found"
    | "airtable_member_conflict";
  shadowed: boolean;
  recordId: string | null;
  changed: Record<string, { from: unknown; to: unknown }>;
};

async function findMirrorTarget(
  input: { memberstackId?: string; email?: string },
  airtable: AirtableClient
): Promise<{ record: AirtableRecord; status: string } | null> {
  if (input.memberstackId) {
    const byMs = await findMemberByMemberstackId(input.memberstackId, airtable);
    if (byMs.length === 1) return { record: byMs[0], status: "by_memberstack_id" };
    if (byMs.length > 1) return { record: byMs[0], status: "conflict" };
  }
  if (input.email) {
    const byEmail = await findMemberByNormalizedEmail(input.email, airtable);
    if (byEmail.length === 1) return { record: byEmail[0], status: "by_email" };
    if (byEmail.length > 1) return { record: byEmail[0], status: "conflict" };
  }
  return null;
}

export async function mirrorSweatpalsStateToAirtable(
  input: SweatpalsMirrorInput
): Promise<SweatpalsMirrorResult> {
  const airtable = input.airtable ?? getFormsAirtableClient();
  const target = await findMirrorTarget(input, airtable);
  if (!target) {
    return {
      status: "airtable_member_not_found",
      shadowed: false,
      recordId: null,
      changed: {},
    };
  }
  if (target.status === "conflict") {
    return {
      status: "airtable_member_conflict",
      shadowed: false,
      recordId: null,
      changed: {},
    };
  }
  const record = target.record;

  const patch: Record<string, unknown> = {
    [MEMBER_FIELDS.billingLastSyncedAt]: new Date().toISOString(),
  };
  if (input.state.active || input.state.paused) {
    patch[MEMBER_FIELDS.membership] = "Active";
    patch[MEMBER_FIELDS.payment] = "Paid";
    if (input.state.accessUntil) {
      patch[MEMBER_FIELDS.serviceAccessUntil] = input.state.accessUntil;
    }
  } else {
    patch[MEMBER_FIELDS.membership] = input.state.cancelled
      ? "Cancelled"
      : "Expired";
    // SweatPals is the source of truth: enforce its access window end so
    // gating revokes access the moment SweatPals says it ended.
    if (input.state.accessUntil) {
      patch[MEMBER_FIELDS.serviceAccessUntil] = input.state.accessUntil;
    }
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
        source: "sweatpals_mirror",
        airtableRecordId: record.id,
        changed,
      })
    );
  }

  if (input.dryRun) {
    return { status: "dry_run", shadowed: false, recordId: record.id, changed };
  }
  if (!canWriteBillingToAirtable()) {
    return { status: "shadowed", shadowed: true, recordId: record.id, changed };
  }

  await airtable.updateRecords(
    MEMBERS_TABLE,
    [{ id: record.id, fields: safe }],
    { typecast: true }
  );
  return { status: "updated", shadowed: false, recordId: record.id, changed };
}

export type SweatpalsReconcileInput = {
  memberstackId?: string;
  /** Lookup emails, most authoritative first (widget-typed, member email…). */
  emails?: (string | undefined)[];
  phone?: string;
  /** Mirror fallback identity (usually the resolved lookup email). */
  mirrorEmail?: string;
  dryRun?: boolean;
  airtable?: AirtableClient;
};

export type SweatpalsReconcileResult = SweatpalsVerifyResult & {
  mirrorStatus: string;
  mirrorRecordId: string | null;
  changedCount: number;
  /** ISO date (YYYY-MM-DD) of the authoritative access window end. */
  accessUntil: string | null;
  /** Name of the active membership tier (when active). */
  membershipName: string | null;
};

/**
 * Shared core for the signup-verify and reconcile paths.
 * Lookup → upsert rows → invalidate removed rows → mirror to Airtable.
 */
export async function reconcileSweatpalsMember(
  input: SweatpalsReconcileInput
): Promise<SweatpalsReconcileResult> {
  const emails = (input.emails ?? []).map((e) => (e ? e.trim() : undefined));

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
      reason:
        "SweatPals API is not configured (SWEATPALS_API_KEY)",
      mirrorStatus: "not_configured",
      mirrorRecordId: null,
      changedCount: 0,
      accessUntil: null,
      membershipName: null,
    };
  }

  const outcome = await lookupSweatpals(emails, input.phone);
  if (outcome.kind === "error") {
    console.error(
      JSON.stringify({
        event: "sweatpals_lookup_error",
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
      mirrorStatus: "api_error",
      mirrorRecordId: null,
      changedCount: 0,
      accessUntil: null,
      membershipName: null,
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
      mirrorStatus: "unresolved",
      mirrorRecordId: null,
      changedCount: 0,
      accessUntil: null,
      membershipName: null,
    };
  }

  const items = outcome.page.list;
  const state = deriveSweatpalsState(items);

  const resolvedEmail = outcome.via === "email" ? outcome.email : undefined;
  const resolvedPhone = outcome.via === "phone" ? outcome.phone : undefined;

  await upsertMembershipsRows({
    memberstackId: input.memberstackId || null,
    items,
    viaEmail: resolvedEmail || null,
    viaPhone: resolvedPhone || null,
  });

  const invalidationEmail =
    resolvedEmail || input.mirrorEmail?.toLowerCase().trim() || null;
  if (invalidationEmail) {
    await invalidateMissingRows(invalidationEmail, items.map((i) => i.id));
  }

  const mirror = await mirrorSweatpalsStateToAirtable({
    memberstackId: input.memberstackId || undefined,
    email: resolvedEmail || input.mirrorEmail,
    state,
    dryRun: input.dryRun,
    airtable: input.airtable,
  });

  const baseStatus = state.active
    ? "active"
    : state.paused
      ? "paused"
      : "inactive";
  const status =
    baseStatus !== "inactive" || mirror.status === "updated" || mirror.status === "shadowed" || mirror.status === "dry_run"
      ? baseStatus
      : mirror.status;

  return {
    success: true,
    status,
    membershipConfirmed: state.active,
    active: state.active,
    paused: state.paused,
    count: items.length,
    shadowed: mirror.shadowed,
    sweeatpalsMemberId: state.activeItem?.id,
    reason:
      mirror.status === "airtable_member_not_found"
        ? "SweatPals membership found, but no Airtable member record exists yet"
        : mirror.status === "airtable_member_conflict"
          ? "Multiple Airtable members match this email — mirroring skipped"
          : undefined,
    mirrorStatus: mirror.status,
    mirrorRecordId: mirror.recordId,
    changedCount: Object.keys(mirror.changed).length,
    accessUntil: state.accessUntil,
    membershipName: state.activeItem?.membershipName || null,
  };
}

/** Signup payment path — member identity known. */
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

  const result = await reconcileSweatpalsMember({
    memberstackId,
    emails: [input.lookupEmail, input.memberEmail],
    phone: input.lookupPhone,
  });

  return {
    success: result.success,
    status: result.status,
    membershipConfirmed: result.membershipConfirmed,
    active: result.active,
    paused: result.paused,
    count: result.count,
    shadowed: result.shadowed,
    reason: result.reason,
    sweeatpalsMemberId: result.sweeatpalsMemberId,
  };
}
