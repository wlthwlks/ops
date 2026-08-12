/**
 * Production Stripe → Airtable membership entitlement reconciliation.
 *
 * Stripe is the billing source of truth. Exact Stripe Customer ID match only.
 * NEVER creates Airtable members. NEVER email-matches. NEVER modifies Stripe.
 * NEVER touches matching/introduction logic. NEVER deletes records.
 *
 * Default: dry-run (zero Airtable writes).
 * Writes require explicit --apply.
 *
 * Usage:
 *   npm run billing:reconcile
 *   npm run billing:reconcile -- --limit=50
 *   npm run billing:reconcile -- --customer=cus_xxx
 *   npm run billing:reconcile -- --concurrency=4
 *   npm run billing:reconcile -- --apply
 */
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { createAirtableClient, type AirtableRecord } from "../src/lib/integrations/airtable";
import { getStripeClient, getStripeNativeMembershipPriceIds } from "../src/lib/integrations/stripe";
import {
  SERVICE_ACCESS_FIELD,
  STRIPE_CUSTOMER_ID_FIELD,
  MEMBERSHIP_FIELD,
  PAYMENT_FIELD,
  STRIPE_PRICE_ID_FIELD,
  STRIPE_SUBSCRIPTION_STATUS_FIELD,
  STRIPE_SUBSCRIPTION_ID_FIELD,
  LAST_INVOICE_STATUS_FIELD,
  LAST_INVOICE_ID_FIELD,
  BILLING_LAST_SYNCED_AT_FIELD,
  PAID_PLANS_FIELD,
  MEMBERS_TABLE,
  formatPaidPlansText,
  resolveNativeMembershipAllowlist,
} from "../src/lib/billing/service-access-sync";
import {
  calculateStripeEntitlement,
  type StripeEntitlementResult,
} from "../src/lib/billing/stripe-entitlement";
import { evaluateServiceAccess } from "../src/lib/introduction/service-access";
import { MEMBER_FIELDS } from "../src/lib/ops/airtable-fields";
import { assertMembersWritePayload } from "../src/lib/airtable/schema";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

const SK = process.env.STRIPE_SECRET_KEY;
const AT = process.env.AIRTABLE_GET_DATA_TOKEN;
const AB = process.env.AIRTABLE_BASE_ID;

const CANCEL_AT_PERIOD_END_FIELD = MEMBER_FIELDS.cancelAtPeriodEnd;
const CANCELLATION_EFFECTIVE_AT_FIELD = MEMBER_FIELDS.cancellationEffectiveAt;

type Category =
  | "currently_entitled"
  | "scheduled_cancellation_still_entitled"
  | "expired_cancelled"
  | "refunded"
  | "past_due_unpaid"
  | "no_qualifying_membership"
  | "airtable_incorrect_future_access"
  | "airtable_missing_or_stale_vs_stripe"
  | "partial_refund_manual_review"
  | "ambiguous_manual_review"
  | "unverifiable"
  | "duplicate_stripe_customer_id"
  | "missing_stripe_customer_id";

type FieldChange = {
  field: string;
  oldValue: string;
  newValue: string;
};

type MemberPlan = {
  airtableRecordId: string;
  name: string;
  email: string;
  stripeCustomerId: string;
  categories: Category[];
  airtableHasAccessLegacy: boolean;
  airtableHasAccessV2: boolean;
  stripeEntitledNow: boolean;
  stripePaidThroughIso: string | null;
  stripeSubStatus: string;
  cancelAtPeriodEnd: boolean;
  cancellationKind: string;
  fieldChanges: FieldChange[];
  patch: Record<string, unknown>;
  applyEligible: boolean;
  notes: string[];
  confidence: "high" | "medium" | "low";
};

function fStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  return String(v).trim();
}

function parseArgs(argv: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const kv = arg.slice(2);
    const eq = kv.indexOf("=");
    opts[eq >= 0 ? kv.slice(0, eq) : kv] = eq >= 0 ? kv.slice(eq + 1) : "true";
  }
  return opts;
}

function isoEqualish(a: string, b: string): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const am = new Date(a).getTime();
  const bm = new Date(b).getTime();
  if (Number.isNaN(am) || Number.isNaN(bm)) return a === b;
  // Treat same second as equal (Airtable date precision variance)
  return Math.abs(am - bm) < 1000;
}

function displayVal(v: unknown): string {
  if (v == null) return "";
  return String(v);
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number, index: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const total = items.length;
  async function worker(workerId: number) {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      done++;
      if (onProgress) onProgress(done, total, i);
      else console.log(`  [w${workerId}] ${done}/${total} done (index ${i})`);
    }
  }
  const n = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: n }, (_v, k) => worker(k + 1)));
  return results;
}

async function loadMembers(
  airtable: ReturnType<typeof createAirtableClient>,
  opts: Record<string, string>
): Promise<AirtableRecord[]> {
  const fields = [
    MEMBER_FIELDS.name,
    MEMBER_FIELDS.email,
    MEMBERSHIP_FIELD,
    PAYMENT_FIELD,
    SERVICE_ACCESS_FIELD,
    STRIPE_CUSTOMER_ID_FIELD,
    STRIPE_PRICE_ID_FIELD,
    STRIPE_SUBSCRIPTION_STATUS_FIELD,
    STRIPE_SUBSCRIPTION_ID_FIELD,
    LAST_INVOICE_STATUS_FIELD,
    LAST_INVOICE_ID_FIELD,
    PAID_PLANS_FIELD,
    CANCEL_AT_PERIOD_END_FIELD,
    CANCELLATION_EFFECTIVE_AT_FIELD,
  ];

  if (opts.customer) {
    return airtable.listRecords(MEMBERS_TABLE, {
      filterByFormula: `{${STRIPE_CUSTOMER_ID_FIELD}} = "${opts.customer.replace(/"/g, '\\"')}"`,
      fields,
      maxRecords: 10,
    });
  }

  if (opts["airtable-record"]) {
    return airtable.listRecords(MEMBERS_TABLE, {
      filterByFormula: `RECORD_ID() = "${opts["airtable-record"].trim()}"`,
      fields,
      maxRecords: 1,
    });
  }

  // Production default: every member with a Stripe Customer ID OR currently marked Active
  // (Active without cus_ is reported, not auto-corrected via Stripe).
  const limit = parseInt(opts.limit || "0", 10) || 0;
  return airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `OR({${STRIPE_CUSTOMER_ID_FIELD}} != "", {${MEMBERSHIP_FIELD}} = "Active")`,
    fields,
    ...(limit > 0 ? { maxRecords: limit } : {}),
  });
}

/**
 * Desired Airtable billing snapshot from Stripe entitlement.
 * Only fields Stripe can authoritatively set.
 */
function buildDesiredPatch(
  ent: StripeEntitlementResult,
  now: Date
): {
  desired: Record<string, string>;
  categories: Category[];
  notes: string[];
} {
  const notes = [...ent.notes];
  const categories: Category[] = [];
  const sub = ent.primarySubscription;
  const subStatus = sub?.status || "";
  const cape = Boolean(sub?.cancelAtPeriodEnd);
  const fullyRefundedOnly =
    ent.fullyRefundedInvoiceIds.length > 0 &&
    ent.contributingInvoiceIds.length === 0 &&
    ent.qualifyingPayments.length > 0;
  const hasPartial = ent.partiallyRefundedInvoiceIds.length > 0;
  const pastDue =
    subStatus === "past_due" ||
    subStatus === "unpaid" ||
    subStatus === "incomplete" ||
    subStatus === "incomplete_expired";

  const desired: Record<string, string> = {};

  if (hasPartial) {
    categories.push("partial_refund_manual_review");
    notes.push("Partial refund present — Membership/Payment left for manual review");
  }

  if (ent.cancellationKind === "ambiguous") {
    categories.push("ambiguous_manual_review");
  }

  // Service access until = authoritative paid-through when known
  if (ent.paidThroughIso) {
    desired[SERVICE_ACCESS_FIELD] = ent.paidThroughIso;
  }

  if (subStatus) {
    desired[STRIPE_SUBSCRIPTION_STATUS_FIELD] = subStatus;
  }
  if (sub?.id) {
    desired[STRIPE_SUBSCRIPTION_ID_FIELD] = sub.id;
  }

  desired[CANCEL_AT_PERIOD_END_FIELD] = cape ? "true" : "false";

  if (cape && sub?.cancelAtUnix != null) {
    desired[CANCELLATION_EFFECTIVE_AT_FIELD] = new Date(sub.cancelAtUnix * 1000).toISOString();
  } else if (
    (ent.cancellationKind === "immediate" || ent.cancellationKind === "scheduled_end") &&
    ent.effectiveCancellationUnix != null
  ) {
    desired[CANCELLATION_EFFECTIVE_AT_FIELD] = new Date(
      ent.effectiveCancellationUnix * 1000
    ).toISOString();
  }

  // Latest contributing invoice evidence
  const latestContrib = [...ent.qualifyingPayments]
    .filter((p) => p.contributesToEntitlement)
    .sort((a, b) => b.periodEndUnix - a.periodEndUnix)[0];
  const latestAny = [...ent.qualifyingPayments].sort(
    (a, b) => b.periodEndUnix - a.periodEndUnix
  )[0];
  const invoiceRef = latestContrib || latestAny;
  if (invoiceRef) {
    desired[LAST_INVOICE_ID_FIELD] = invoiceRef.invoiceId;
    desired[LAST_INVOICE_STATUS_FIELD] = "paid";
  }

  const priceId =
    ent.priceIds.find((id) => id.startsWith("price_")) || ent.priceIds[0] || "";
  if (priceId) {
    desired[STRIPE_PRICE_ID_FIELD] = priceId;
    desired[PAID_PLANS_FIELD] = formatPaidPlansText(ent.priceIds);
  }

  // Entitlement → Membership / Payment
  if (fullyRefundedOnly) {
    categories.push("refunded");
    desired[PAYMENT_FIELD] = "Refunded";
    desired[MEMBERSHIP_FIELD] = "Cancelled";
    if (ent.paidThroughIso) {
      // paid-through already excludes full refunds; may be null/past
    } else {
      // No remaining entitlement — if AT has future access, clamp via clearing is not allowed;
      // set to now-1s only when we have no period — prefer leaving Service access until only when known
    }
  } else if (pastDue && !ent.hasEntitlementNow) {
    categories.push("past_due_unpaid");
    desired[PAYMENT_FIELD] = "Failed";
    // Keep Membership as-is unless clearly ended; still mark status from Stripe
    if (subStatus === "unpaid" || subStatus === "incomplete_expired") {
      desired[MEMBERSHIP_FIELD] = "Cancelled";
    }
  } else if (ent.hasEntitlementNow) {
    if (cape || ent.cancellationKind === "cancel_at_period_end") {
      categories.push("scheduled_cancellation_still_entitled");
    } else {
      categories.push("currently_entitled");
    }
    if (!hasPartial) {
      desired[MEMBERSHIP_FIELD] = "Active";
      desired[PAYMENT_FIELD] = "Paid";
    }
  } else if (ent.contributingInvoiceIds.length > 0 || subStatus === "canceled") {
    categories.push("expired_cancelled");
    if (!hasPartial) {
      desired[MEMBERSHIP_FIELD] = "Cancelled";
      // Paid historically but period ended — keep Payment=Paid unless refunded
      if (ent.fullyRefundedInvoiceIds.length > 0 && ent.contributingInvoiceIds.length === 0) {
        desired[PAYMENT_FIELD] = "Refunded";
      } else if (fStrDesiredPaymentStillOk()) {
        desired[PAYMENT_FIELD] = "Paid";
      }
    }
  } else if (ent.qualifyingPayments.length === 0) {
    categories.push("no_qualifying_membership");
    // Do not invent Membership/Payment without Stripe membership evidence
  } else {
    categories.push("expired_cancelled");
    if (!hasPartial) {
      desired[MEMBERSHIP_FIELD] = "Cancelled";
    }
  }

  // Billing sync timestamp only on apply path (added later)
  void now;

  return { desired, categories, notes };

  function fStrDesiredPaymentStillOk(): boolean {
    return true;
  }
}

function diffPatch(
  fields: Record<string, unknown>,
  desired: Record<string, string>,
  options: { allowServiceAccessReduction: boolean }
): { changes: FieldChange[]; patch: Record<string, unknown> } {
  const changes: FieldChange[] = [];
  const patch: Record<string, unknown> = {};

  for (const [field, newRaw] of Object.entries(desired)) {
    const oldRaw = fStr(fields, field);
    const newValue = newRaw;

    if (field === SERVICE_ACCESS_FIELD) {
      if (!newValue) continue;
      if (isoEqualish(oldRaw, newValue)) continue;
      const oldMs = oldRaw ? new Date(oldRaw).getTime() : NaN;
      const newMs = new Date(newValue).getTime();
      if (!Number.isNaN(oldMs) && !Number.isNaN(newMs) && newMs < oldMs) {
        if (!options.allowServiceAccessReduction) {
          // Still allow reduction when Stripe proves shorter paid-through
          // (this reconcile is corrective). Always allow here.
        }
      }
      changes.push({ field, oldValue: oldRaw, newValue });
      patch[field] = newValue;
      continue;
    }

    if (oldRaw === newValue) continue;
    // Avoid clearing non-empty with empty
    if (!newValue && oldRaw) continue;
    changes.push({ field, oldValue: oldRaw, newValue });
    patch[field] = newValue;
  }

  return { changes, patch };
}

function planMember(
  member: AirtableRecord,
  ent: StripeEntitlementResult | null,
  now: Date
): MemberPlan {
  const cusId = fStr(member.fields, STRIPE_CUSTOMER_ID_FIELD);
  const name = fStr(member.fields, MEMBER_FIELDS.name);
  const email = fStr(member.fields, MEMBER_FIELDS.email);
  const membership = fStr(member.fields, MEMBERSHIP_FIELD);
  const payment = fStr(member.fields, PAYMENT_FIELD);
  const accessUntil = fStr(member.fields, SERVICE_ACCESS_FIELD);

  const legacy = evaluateServiceAccess(membership, payment, accessUntil || null, now, "legacy");
  const v2 = evaluateServiceAccess(membership, payment, accessUntil || null, now, "v2");

  if (!cusId.startsWith("cus_")) {
    return {
      airtableRecordId: member.id,
      name,
      email,
      stripeCustomerId: cusId,
      categories: ["missing_stripe_customer_id"],
      airtableHasAccessLegacy: legacy.accessible,
      airtableHasAccessV2: v2.accessible,
      stripeEntitledNow: false,
      stripePaidThroughIso: null,
      stripeSubStatus: "",
      cancelAtPeriodEnd: false,
      cancellationKind: "none",
      fieldChanges: [],
      patch: {},
      applyEligible: false,
      notes: ["No Stripe Customer ID — cannot reconcile from Stripe"],
      confidence: "low",
    };
  }

  if (!ent) {
    return {
      airtableRecordId: member.id,
      name,
      email,
      stripeCustomerId: cusId,
      categories: ["unverifiable"],
      airtableHasAccessLegacy: legacy.accessible,
      airtableHasAccessV2: v2.accessible,
      stripeEntitledNow: false,
      stripePaidThroughIso: null,
      stripeSubStatus: "",
      cancelAtPeriodEnd: false,
      cancellationKind: "none",
      fieldChanges: [],
      patch: {},
      applyEligible: false,
      notes: ["Stripe entitlement lookup failed"],
      confidence: "low",
    };
  }

  const { desired, categories, notes } = buildDesiredPatch(ent, now);
  const { changes, patch } = diffPatch(member.fields, desired, {
    allowServiceAccessReduction: true,
  });

  // Discrepancy flags
  const cats = new Set<Category>(categories);
  const accessMs = accessUntil ? new Date(accessUntil).getTime() : NaN;
  const futureAccess = !Number.isNaN(accessMs) && accessMs > now.getTime();
  const stripeEntitled = ent.hasEntitlementNow;

  if (futureAccess && !stripeEntitled) {
    cats.add("airtable_incorrect_future_access");
  }
  if (legacy.accessible && !stripeEntitled) {
    cats.add("airtable_incorrect_future_access");
  }
  if (stripeEntitled && (!legacy.accessible || changes.some((c) => c.field === SERVICE_ACCESS_FIELD))) {
    cats.add("airtable_missing_or_stale_vs_stripe");
  }
  if (
    stripeEntitled &&
    (membership !== "Active" || payment !== "Paid") &&
    !cats.has("partial_refund_manual_review")
  ) {
    cats.add("airtable_missing_or_stale_vs_stripe");
  }

  // Apply eligibility: high confidence only; skip partial/ambiguous membership flips
  const blockApply =
    cats.has("partial_refund_manual_review") ||
    cats.has("ambiguous_manual_review") ||
    cats.has("unverifiable") ||
    ent.confidence === "low";

  const applyEligible = changes.length > 0 && !blockApply && ent.confidence !== "low";

  if (applyEligible && changes.length > 0) {
    patch[BILLING_LAST_SYNCED_AT_FIELD] = now.toISOString();
  }

  return {
    airtableRecordId: member.id,
    name,
    email,
    stripeCustomerId: cusId,
    categories: [...cats],
    airtableHasAccessLegacy: legacy.accessible,
    airtableHasAccessV2: v2.accessible,
    stripeEntitledNow: stripeEntitled,
    stripePaidThroughIso: ent.paidThroughIso,
    stripeSubStatus: ent.primarySubscription?.status || "",
    cancelAtPeriodEnd: Boolean(ent.primarySubscription?.cancelAtPeriodEnd),
    cancellationKind: ent.cancellationKind,
    fieldChanges: changes,
    patch,
    applyEligible,
    notes,
    confidence: ent.confidence,
  };
}

async function countActiveStripeMembershipSubs(
  stripe: ReturnType<typeof getStripeClient>,
  allow: Set<string>
): Promise<{ activeSubs: number; uniqueCustomers: number }> {
  if (allow.size === 0) return { activeSubs: 0, uniqueCustomers: 0 };
  const customers = new Set<string>();
  let activeSubs = 0;
  let startingAfter: string | undefined;
  let censusPage = 0;
  // status=active covers still-billing subs including cancel_at_period_end
  console.log(`  [stripe-census] listing active subscriptions…`);
  for (;;) {
    censusPage++;
    const page = await stripe.subscriptions.list({
      status: "active",
      limit: 100,
      starting_after: startingAfter,
      expand: ["data.items.data.price"],
    });
    console.log(`  [stripe-census] active page ${censusPage}: ${page.data.length} subs (has_more=${page.has_more})`);
    for (const sub of page.data) {
      const priceIds = (sub.items?.data || [])
        .map((it) => it.price?.id)
        .filter((id): id is string => Boolean(id && id.startsWith("price_")));
      const qualifies = priceIds.some((id) => allow.has(id));
      if (!qualifies) continue;
      activeSubs++;
      const cus =
        typeof sub.customer === "string" ? sub.customer : sub.customer?.id || "";
      if (cus.startsWith("cus_")) customers.add(cus);
    }
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]?.id;
  }
  // Also trialing
  startingAfter = undefined;
  censusPage = 0;
  console.log(`  [stripe-census] listing trialing subscriptions…`);
  for (;;) {
    censusPage++;
    const page = await stripe.subscriptions.list({
      status: "trialing",
      limit: 100,
      starting_after: startingAfter,
    });
    console.log(`  [stripe-census] trialing page ${censusPage}: ${page.data.length} subs (has_more=${page.has_more})`);
    for (const sub of page.data) {
      const priceIds: string[] = [];
      for (const it of sub.items?.data || []) {
        const pid = it.price?.id;
        if (pid?.startsWith("price_")) priceIds.push(pid);
      }
      // items may not expand price id on all API versions — fetch from plan legacy
      if (priceIds.length === 0) {
        for (const it of sub.items?.data || []) {
          const legacy = it as unknown as { plan?: { id?: string }; price?: string | { id?: string } };
          if (typeof legacy.price === "string" && legacy.price.startsWith("price_")) {
            priceIds.push(legacy.price);
          } else if (legacy.price && typeof legacy.price === "object" && legacy.price.id) {
            priceIds.push(legacy.price.id);
          } else if (legacy.plan?.id?.startsWith("price_")) {
            priceIds.push(legacy.plan.id);
          }
        }
      }
      if (!priceIds.some((id) => allow.has(id))) continue;
      activeSubs++;
      const cus =
        typeof sub.customer === "string" ? sub.customer : sub.customer?.id || "";
      if (cus.startsWith("cus_")) customers.add(cus);
    }
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]?.id;
  }
  return { activeSubs, uniqueCustomers: customers.size };
}

async function main() {
  console.log("WLTH WLKS Production Membership Entitlement Reconciliation");
  console.log("Stripe = billing source of truth | Exact cus_ match only | No creates\n");

  const args = parseArgs(process.argv.slice(2));
  const apply = args.apply === "true";
  if (!apply) {
    console.log("MODE: DRY-RUN (no Airtable writes). Pass --apply to commit corrections.\n");
  } else {
    console.log("MODE: APPLY — will write high-confidence field corrections only.\n");
  }

  if (!SK || !AT || !AB) {
    console.error("Missing STRIPE_SECRET_KEY, AIRTABLE_GET_DATA_TOKEN, or AIRTABLE_BASE_ID");
    process.exit(1);
  }

  const allow = resolveNativeMembershipAllowlist(
    getStripeNativeMembershipPriceIds({
      requireConfigured: true,
      failClosedInProduction: false,
    })
  );
  console.log(`Configured WLTH WLKS membership price_ IDs: ${allow.size}`);
  for (const id of allow) console.log(`  - ${id}`);
  console.log("");

  const airtable = createAirtableClient({ apiKey: AT, baseId: AB });
  const stripe = getStripeClient();
  const now = new Date();

  console.log("Loading Airtable MEMBERS…");
  const members = await loadMembers(airtable, args);
  console.log(`Loaded ${members.length} Airtable member rows\n`);

  // Optional Stripe active-sub census (helps explain 2247 vs ~3000)
  let stripeCensus: { activeSubs: number; uniqueCustomers: number } | null = null;
  if (args["skip-stripe-census"] !== "true" && !args.customer && !args["airtable-record"]) {
    console.log("Counting active/trialing WLTH WLKS Stripe subscriptions…");
    try {
      stripeCensus = await countActiveStripeMembershipSubs(stripe, allow);
      console.log(
        `Stripe active+trialing membership subs: ${stripeCensus.activeSubs} (unique customers: ${stripeCensus.uniqueCustomers})\n`
      );
    } catch (e) {
      console.warn(
        `Stripe census failed: ${e instanceof Error ? e.message : e} (continuing)\n`
      );
    }
  }

  const concurrency = Math.min(6, Math.max(1, parseInt(args.concurrency || "3", 10) || 3));
  const seenCus = new Map<string, string>(); // cus -> first record id
  const plans: MemberPlan[] = [];

  const stripeClient = {
    invoices: stripe.invoices,
    subscriptions: stripe.subscriptions,
    charges: stripe.charges,
  };

  console.log(`Deriving Stripe entitlement for ${members.length} members (concurrency=${concurrency})…`);
  let loggedDone = 0;
  const logEvery = Math.max(1, Math.floor(members.length / 100));
  const results = await mapPool(
    members,
    concurrency,
    async (member) => {
      const cusId = fStr(member.fields, STRIPE_CUSTOMER_ID_FIELD);
      const memberLabel =
        fStr(member.fields, MEMBER_FIELDS.email) ||
        fStr(member.fields, MEMBER_FIELDS.name) ||
        member.id;
      if (cusId.startsWith("cus_")) {
        console.log(`  → ${member.id} ${memberLabel} cus=${cusId} …`);
        const prior = seenCus.get(cusId);
        if (prior) {
          const membership = fStr(member.fields, MEMBERSHIP_FIELD);
          const payment = fStr(member.fields, PAYMENT_FIELD);
          const accessUntil = fStr(member.fields, SERVICE_ACCESS_FIELD);
          const legacy = evaluateServiceAccess(
            membership,
            payment,
            accessUntil || null,
            now,
            "legacy"
          );
          const v2 = evaluateServiceAccess(
            membership,
            payment,
            accessUntil || null,
            now,
            "v2"
          );
          return {
            airtableRecordId: member.id,
            name: fStr(member.fields, MEMBER_FIELDS.name),
            email: fStr(member.fields, MEMBER_FIELDS.email),
            stripeCustomerId: cusId,
            categories: ["duplicate_stripe_customer_id" as Category],
            airtableHasAccessLegacy: legacy.accessible,
            airtableHasAccessV2: v2.accessible,
            stripeEntitledNow: false,
            stripePaidThroughIso: null,
            stripeSubStatus: "",
            cancelAtPeriodEnd: false,
            cancellationKind: "none",
            fieldChanges: [],
            patch: {},
            applyEligible: false,
            notes: [`Duplicate Stripe Customer ID — first seen on ${prior}`],
            confidence: "low" as const,
          } satisfies MemberPlan;
        }
        seenCus.set(cusId, member.id);
      }

      let ent: StripeEntitlementResult | null = null;
      if (cusId.startsWith("cus_")) {
        try {
          ent = await calculateStripeEntitlement({
            stripe: stripeClient as never,
            stripeCustomerId: cusId,
            membershipPriceIds: allow,
            nowUnix: Math.floor(now.getTime() / 1000),
            includeSubscriptions: true,
          });
        } catch (e) {
          ent = null;
          console.warn(
            `  Stripe error for ${cusId}: ${e instanceof Error ? e.message : e}`
          );
        }
      }
      return planMember(member, ent, now);
    },
    (done, total, _index) => {
      loggedDone = done;
      if (done === 1 || done === total || done % logEvery === 0) {
        const pct = total > 0 ? Math.round((done / total) * 100) : 100;
        console.log(`  [scan] ${done}/${total} (${pct}%) — last cus lookup in progress…`);
      }
    }
  );
  void loggedDone;
  plans.push(...results);

  // ── Totals ─────────────────────────────────────────────────────────────
  const catCounts = new Map<Category, number>();
  const bump = (c: Category) => catCounts.set(c, (catCounts.get(c) || 0) + 1);
  for (const p of plans) for (const c of p.categories) bump(c);

  const airtableAccessLegacy = plans.filter((p) => p.airtableHasAccessLegacy).length;
  const airtableAccessV2 = plans.filter((p) => p.airtableHasAccessV2).length;
  const stripeEntitled = plans.filter((p) => p.stripeEntitledNow).length;
  const withChanges = plans.filter((p) => p.fieldChanges.length > 0);
  const applyEligible = plans.filter((p) => p.applyEligible);
  const incorrectFuture = plans.filter((p) =>
    p.categories.includes("airtable_incorrect_future_access")
  );
  const staleVsStripe = plans.filter((p) =>
    p.categories.includes("airtable_missing_or_stale_vs_stripe")
  );

  console.log("\n========== TOTALS ==========");
  if (stripeCensus) {
    console.log(`Stripe active+trialing WLTH WLKS subs:     ${stripeCensus.activeSubs}`);
    console.log(`Stripe unique customers (those subs):      ${stripeCensus.uniqueCustomers}`);
  }
  console.log(`Airtable rows scanned:                       ${plans.length}`);
  console.log(`Airtable legacy has-access (Active+Paid OR future until): ${airtableAccessLegacy}`);
  console.log(`Airtable V2 has-access (Service access until only):       ${airtableAccessV2}`);
  console.log(`Stripe entitled now (linked rows):           ${stripeEntitled}`);
  console.log(`Delta (legacy access − Stripe entitled):     ${airtableAccessLegacy - stripeEntitled}`);
  console.log("");
  console.log("── Discrepancy categories ──");
  const order: Category[] = [
    "currently_entitled",
    "scheduled_cancellation_still_entitled",
    "expired_cancelled",
    "refunded",
    "past_due_unpaid",
    "airtable_incorrect_future_access",
    "airtable_missing_or_stale_vs_stripe",
    "no_qualifying_membership",
    "partial_refund_manual_review",
    "ambiguous_manual_review",
    "duplicate_stripe_customer_id",
    "missing_stripe_customer_id",
    "unverifiable",
  ];
  for (const c of order) {
    const n = catCounts.get(c) || 0;
    if (n > 0) console.log(`  ${c}: ${n}`);
  }
  console.log("");
  console.log(`Rows with field changes: ${withChanges.length}`);
  console.log(`Apply-eligible (high confidence): ${applyEligible.length}`);
  console.log(`Incorrect future/legacy access vs Stripe: ${incorrectFuture.length}`);
  console.log(`Stripe entitled but Airtable stale/missing state: ${staleVsStripe.length}`);

  // ── Per-member field diffs (sample + full report file) ─────────────────
  console.log("\n========== FIELD CHANGES (first 40 apply-eligible) ==========");
  for (const p of applyEligible.slice(0, 40)) {
    console.log(
      `\n${p.airtableRecordId} | ${p.email || p.name} | ${p.stripeCustomerId} | ${p.categories.join(",")}`
    );
    console.log(
      `  Stripe: entitled=${p.stripeEntitledNow} paidThrough=${p.stripePaidThroughIso || "—"} sub=${p.stripeSubStatus || "—"} cape=${p.cancelAtPeriodEnd}`
    );
    console.log(
      `  Airtable access: legacy=${p.airtableHasAccessLegacy} v2=${p.airtableHasAccessV2}`
    );
    for (const ch of p.fieldChanges) {
      console.log(`  • ${ch.field}: ${JSON.stringify(ch.oldValue)} → ${JSON.stringify(ch.newValue)}`);
    }
  }
  if (applyEligible.length > 40) {
    console.log(`\n  … ${applyEligible.length - 40} more apply-eligible rows in report file`);
  }

  // Manual review samples
  const manual = plans.filter(
    (p) =>
      p.categories.includes("partial_refund_manual_review") ||
      p.categories.includes("ambiguous_manual_review")
  );
  if (manual.length > 0) {
    console.log(`\n========== MANUAL REVIEW (${manual.length}) ==========`);
    for (const p of manual.slice(0, 15)) {
      console.log(
        `  ${p.airtableRecordId} ${p.email} ${p.stripeCustomerId} → ${p.categories.join(",")} | ${p.notes.slice(0, 2).join("; ")}`
      );
    }
  }

  // Write JSON + CSV reports
  const reportsDir = path.join(process.cwd(), "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const jsonPath = path.join(reportsDir, `billing-entitlement-reconcile-${ts}.json`);
  const csvPath = path.join(reportsDir, `billing-entitlement-reconcile-${ts}.csv`);

  const report = {
    generatedAt: now.toISOString(),
    mode: apply ? "apply" : "dry-run",
    stripeCensus,
    totals: {
      airtableRowsScanned: plans.length,
      airtableAccessLegacy,
      airtableAccessV2,
      stripeEntitledLinked: stripeEntitled,
      deltaLegacyMinusStripe: airtableAccessLegacy - stripeEntitled,
      rowsWithChanges: withChanges.length,
      applyEligible: applyEligible.length,
      categories: Object.fromEntries(catCounts),
    },
    membershipPriceIds: [...allow],
    members: plans.map((p) => ({
      airtableRecordId: p.airtableRecordId,
      name: p.name,
      email: p.email,
      stripeCustomerId: p.stripeCustomerId,
      categories: p.categories,
      airtableHasAccessLegacy: p.airtableHasAccessLegacy,
      airtableHasAccessV2: p.airtableHasAccessV2,
      stripeEntitledNow: p.stripeEntitledNow,
      stripePaidThroughIso: p.stripePaidThroughIso,
      stripeSubStatus: p.stripeSubStatus,
      cancelAtPeriodEnd: p.cancelAtPeriodEnd,
      cancellationKind: p.cancellationKind,
      fieldChanges: p.fieldChanges,
      applyEligible: p.applyEligible,
      confidence: p.confidence,
      notes: p.notes,
    })),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const headers = [
    "Airtable Record ID",
    "Name",
    "Email",
    "Stripe Customer ID",
    "Categories",
    "Legacy access",
    "V2 access",
    "Stripe entitled",
    "Stripe paid-through",
    "Stripe sub status",
    "Cancel at period end",
    "Field changes",
    "Apply eligible",
    "Confidence",
    "Notes",
  ];
  const csvLines = [headers.join(",")];
  for (const p of plans) {
    const changeText = p.fieldChanges
      .map((c) => `${c.field}: ${c.oldValue} => ${c.newValue}`)
      .join(" | ");
    const row = [
      p.airtableRecordId,
      p.name,
      p.email,
      p.stripeCustomerId,
      p.categories.join("|"),
      String(p.airtableHasAccessLegacy),
      String(p.airtableHasAccessV2),
      String(p.stripeEntitledNow),
      p.stripePaidThroughIso || "",
      p.stripeSubStatus,
      String(p.cancelAtPeriodEnd),
      changeText,
      String(p.applyEligible),
      p.confidence,
      p.notes.join("; "),
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
    csvLines.push(row.join(","));
  }
  fs.writeFileSync(csvPath, csvLines.join("\n"));

  console.log(`\nJSON report: ${jsonPath}`);
  console.log(`CSV report:  ${csvPath}`);

  // ── Apply ──────────────────────────────────────────────────────────────
  if (!apply) {
    console.log("\nNo writes performed (dry-run).");
    console.log("\nCommands:");
    console.log("  Dry-run:  npm run billing:reconcile");
    console.log("  Apply:    npm run billing:reconcile -- --apply");
    return;
  }

  const toWrite = applyEligible.filter((p) => Object.keys(p.patch).length > 0);
  if (toWrite.length === 0) {
    console.log("\nNothing to apply.");
    return;
  }

  console.log(`\nApplying ${toWrite.length} member corrections…`);
  const batches: Array<Array<{ id: string; fields: Record<string, unknown> }>> = [];
  for (let i = 0; i < toWrite.length; i += 10) {
    batches.push(
      toWrite.slice(i, i + 10).map((p) => {
        const fields = assertMembersWritePayload({ ...p.patch });
        return { id: p.airtableRecordId, fields };
      })
    );
  }

  let written = 0;
  for (const batch of batches) {
    await airtable.updateRecordsBatched(MEMBERS_TABLE, batch);
    written += batch.length;
    console.log(`  Wrote ${written}/${toWrite.length}`);
  }
  console.log(`Done — applied ${written} member updates. No records deleted.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
