/**
 * One-time historical repair helpers: link paying Stripe customers to Airtable
 * and optionally create missing Members. NEVER used by the Stripe webhook.
 */
import type Stripe from "stripe";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import {
  MEMBERS_TABLE,
  SERVICE_ACCESS_FIELD,
  STRIPE_CUSTOMER_ID_FIELD,
  MEMBERSHIP_FIELD,
  PAYMENT_FIELD,
  STRIPE_PRICE_ID_FIELD,
  PAID_PLANS_FIELD,
  STRIPE_SUBSCRIPTION_ID_FIELD,
  STRIPE_SUBSCRIPTION_STATUS_FIELD,
  LAST_INVOICE_ID_FIELD,
  LAST_INVOICE_STATUS_FIELD,
  BILLING_LAST_SYNCED_AT_FIELD,
  CANCEL_AT_PERIOD_END_FIELD,
  CANCELLATION_EFFECTIVE_AT_FIELD,
  CANCELLATION_DATE_FIELD,
  FIRST_NAME_FIELD,
  LAST_NAME_FIELD,
  computeLatestMembershipPeriodEndForCustomer,
  escapeAirtableFormulaString,
  formatPaidPlansText,
  isValidStripeCustomerId,
  maxPaidThroughDate,
  updateServiceAccessUntilForCustomer,
  type InvoiceBillingExtras,
} from "@/lib/billing/service-access-sync";
import {
  isValidEmail,
  maskEmail,
  normalizeEmailStrict,
} from "@/lib/billing/reconcile-stripe-customers";
import {
  PRIMARY_EMAIL_FIELD,
  extractStripeCustomerEmail,
  findAirtableMembersByPrimaryEmail,
} from "@/lib/billing/webhook-invoice-sync";

export type HistoricalRepairAction =
  | "would_update_access"
  | "updated_access"
  | "would_link_and_update"
  | "linked_and_updated"
  | "would_create_member"
  | "created_member"
  | "already_up_to_date"
  | "existing_later"
  | "skipped_no_email"
  | "skipped_invalid_email"
  | "skipped_email_conflict"
  | "skipped_customer_id_conflict"
  | "skipped_no_qualifying_invoice"
  | "skipped_no_period_end"
  | "skipped_create_not_enabled"
  | "error";

export type HistoricalRepairRow = {
  stripeCustomerId: string;
  emailMasked: string;
  airtableRecordId: string;
  action: HistoricalRepairAction;
  paidThrough: string;
  reason: string;
  updated: boolean;
  created: boolean;
  linked: boolean;
};

export function parseHistoricalRepairArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const applyLinks = argv.includes("--apply-links");
  const createMissing = argv.includes("--create-missing");
  const subscriptions = argv.includes("--subscriptions");
  // Writes only with --apply or --apply-links. create-missing requires --apply.
  const dryRun = !apply && !applyLinks;
  const canLink = apply || applyLinks;
  const canCreate = apply && createMissing;

  let limit: number | undefined;
  let stripeCustomerId: string | undefined;
  let output = subscriptions
    ? "tmp/active-subscription-sync.csv"
    : "tmp/historical-stripe-member-repair.csv";

  for (const arg of argv) {
    if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.slice("--limit=".length), 10);
    } else if (arg.startsWith("--stripe-customer-id=")) {
      stripeCustomerId = arg.slice("--stripe-customer-id=".length).trim();
    } else if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length).trim();
    }
  }

  if (createMissing && !apply) {
    throw new Error("--create-missing requires --apply (not available with --apply-links alone)");
  }

  return {
    apply,
    applyLinks,
    createMissing,
    subscriptions,
    dryRun,
    canLink,
    canCreate,
    limit,
    stripeCustomerId,
    output,
  };
}

export function namesFromStripeCustomer(
  customer: Stripe.Customer,
  email: string
): { firstName: string; lastName: string } {
  const n = typeof customer.name === "string" ? customer.name.trim() : "";
  if (n) {
    const parts = n.split(/\s+/);
    return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
  }
  const local = email.split("@")[0] || email;
  return { firstName: local, lastName: "" };
}

export function rowsToCsv(rows: HistoricalRepairRow[]): string {
  const headers = [
    "stripeCustomerId",
    "emailMasked",
    "airtableRecordId",
    "action",
    "paidThrough",
    "reason",
    "updated",
    "created",
    "linked",
  ];
  const escape = (v: string | boolean) => {
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.stripeCustomerId,
        r.emailMasked,
        r.airtableRecordId,
        r.action,
        r.paidThrough,
        r.reason,
        r.updated,
        r.created,
        r.linked,
      ]
        .map(escape)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

/** Minimal Stripe surface used by repair (tests may pass partial mocks). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StripeListClient = any;

/**
 * Derive Airtable Membership/Payment-related fields from a customer's Stripe
 * subscriptions (membership prices only). Used when the repair CLI creates a
 * missing member so the row reflects what Stripe says instead of defaulting
 * blank (= Active) in Airtable.
 */
export function deriveMemberStatusFromSubscriptions(
  subs: Stripe.Subscription[],
  membershipPriceIds: Set<string>
): {
  membership: "Active" | "Cancelled" | "Paused";
  stripeSubscriptionId: string;
  stripeSubscriptionStatus: string;
  cancelAtPeriodEnd: boolean;
  stripePriceId: string;
  /** YYYY-MM-DD of the latest membership sub cancellation, "" when active. */
  cancellationDate: string;
} {
  const membershipSubs = subs.filter((s) =>
    subscriptionItemPriceIds(s).some((id) => membershipPriceIds.has(id))
  );
  const latest = membershipSubs
    .slice()
    .sort((a, b) => {
      const ae = subscriptionCurrentPeriodEndUnix(a) ?? 0;
      const be = subscriptionCurrentPeriodEndUnix(b) ?? 0;
      return be - ae;
    })[0];
  // Pause collection keeps subscription status "active" — the pause only
  // exists in `pause_collection`, so paused subs must never count as active.
  const hasActive = membershipSubs.some(
    (s) =>
      (s.status === "active" || s.status === "trialing") &&
      s.pause_collection == null
  );
  const hasPausedOnly =
    !hasActive &&
    membershipSubs.some((s) => s.status === "paused" || s.pause_collection != null);
  const latestPaused =
    latest != null &&
    (latest.status === "paused" || latest.pause_collection != null);
  let cancellationDate = "";
  if (!hasActive && !hasPausedOnly) {
    const cancelledUnix = membershipSubs
      .map((s) =>
        typeof s.canceled_at === "number"
          ? s.canceled_at
          : typeof s.ended_at === "number"
            ? s.ended_at
            : null
      )
      .filter((u): u is number => u != null);
    if (cancelledUnix.length > 0) {
      cancellationDate = new Date(Math.max(...cancelledUnix) * 1000).toISOString().slice(0, 10);
    }
  }
  return {
    membership: hasActive ? "Active" : hasPausedOnly ? "Paused" : "Cancelled",
    stripeSubscriptionId: latest?.id ?? "",
    stripeSubscriptionStatus: latestPaused ? "paused" : latest?.status ?? "",
    cancelAtPeriodEnd: Boolean(latest?.cancel_at_period_end),
    stripePriceId: latest ? (subscriptionItemPriceIds(latest)[0] ?? "") : "",
    cancellationDate,
  };
}

/**
 * Load a customer's subscriptions (any status) and derive status fields for
 * a to-be-created Airtable member. `inspected` is false when the Stripe
 * subscription surface was unavailable — in that case callers must not write
 * status fields (we know nothing about the member's current state).
 */
async function fetchDerivedCreateStatus(
  stripe: StripeListClient,
  stripeCustomerId: string,
  membershipPriceIds: Set<string>
): Promise<{ inspected: boolean } & ReturnType<typeof deriveMemberStatusFromSubscriptions>> {
  let subs: Stripe.Subscription[] = [];
  let inspected = false;
  try {
    if (typeof stripe?.subscriptions?.list === "function") {
      const page = await stripe.subscriptions.list({
        customer: stripeCustomerId,
        status: "all",
        limit: 10,
      });
      if (Array.isArray(page?.data)) subs = page.data;
      inspected = true;
    }
  } catch {
    inspected = false;
  }
  return { inspected, ...deriveMemberStatusFromSubscriptions(subs, membershipPriceIds) };
}

/**
 * Repair one paying Stripe customer against Airtable.
 * Webhook must not call this with canCreate=true in production paths.
 */
export async function repairPayingStripeCustomer(input: {
  airtable: AirtableClient;
  stripe: StripeListClient;
  customer: Stripe.Customer;
  membershipPriceIds: Set<string>;
  canLink: boolean;
  canCreate: boolean;
  dryRun: boolean;
}): Promise<HistoricalRepairRow> {
  const { airtable, stripe, customer, membershipPriceIds, canLink, canCreate, dryRun } =
    input;
  const stripeCustomerId = customer.id;
  const rawEmail = extractStripeCustomerEmail(customer);
  const emailMasked = rawEmail ? maskEmail(rawEmail) : "";

  const empty = (action: HistoricalRepairAction, reason: string): HistoricalRepairRow => ({
    stripeCustomerId,
    emailMasked,
    airtableRecordId: "",
    action,
    paidThrough: "",
    reason,
    updated: false,
    created: false,
    linked: false,
  });

  if (!isValidStripeCustomerId(stripeCustomerId)) {
    return empty("error", "Invalid Stripe Customer ID");
  }

  const billing = await computeLatestMembershipPeriodEndForCustomer(
    stripe,
    stripeCustomerId,
    membershipPriceIds
  );
  if (billing.periodEndUnix == null) {
    return empty("skipped_no_qualifying_invoice", "No qualifying paid membership invoice");
  }

  const paidThrough = new Date(billing.periodEndUnix * 1000);
  const paidThroughIso = paidThrough.toISOString();

  // Prefer exact customer id match
  const byId = await airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `{${STRIPE_CUSTOMER_ID_FIELD}} = "${escapeAirtableFormulaString(stripeCustomerId)}"`,
    fields: [PRIMARY_EMAIL_FIELD, STRIPE_CUSTOMER_ID_FIELD, SERVICE_ACCESS_FIELD, "Name"],
  });

  if (byId.length > 0) {
    const sync = await updateServiceAccessUntilForCustomer({
      airtable,
      stripeCustomerId,
      paidThrough,
      stripeInvoiceId: "historical-repair",
      dryRun: dryRun || !canLink,
    });
    // When --apply-links only without access writes... actually canLink with apply-links
    // should also update access when ID already present. User said apply-links for linking;
    // full apply updates. For already-linked members, updating access is part of repair.
    // Use: write access when canLink OR canCreate path with apply. Simplest: write when !dryRun.
    // parseHistoricalRepairArgs: dryRun = !apply && !applyLinks
    // So apply-links enables writes for link+access on matched customers. Good.

    if (sync.status === "updated") {
      return {
        stripeCustomerId,
        emailMasked,
        airtableRecordId: sync.results[0]?.airtableRecordId ?? byId[0].id,
        action: dryRun ? "would_update_access" : "updated_access",
        paidThrough: paidThroughIso,
        reason: "Matched by Stripe Customer ID",
        updated: !dryRun && sync.airtableRecordsUpdated > 0,
        created: false,
        linked: false,
      };
    }
    if (sync.status === "already_up_to_date") {
      return {
        stripeCustomerId,
        emailMasked,
        airtableRecordId: byId[0].id,
        action: "already_up_to_date",
        paidThrough: paidThroughIso,
        reason: "Service access until already correct",
        updated: false,
        created: false,
        linked: false,
      };
    }
    if (sync.status === "existing_later") {
      return {
        stripeCustomerId,
        emailMasked,
        airtableRecordId: byId[0].id,
        action: "existing_later",
        paidThrough: paidThroughIso,
        reason: "Existing Service access until is later",
        updated: false,
        created: false,
        linked: false,
      };
    }
    return {
      stripeCustomerId,
      emailMasked,
      airtableRecordId: byId[0].id,
      action: sync.status === "invalid_existing_date" ? "error" : "already_up_to_date",
      paidThrough: paidThroughIso,
      reason: sync.results[0]?.reason ?? sync.status,
      updated: false,
      created: false,
      linked: false,
    };
  }

  if (!rawEmail) {
    return empty("skipped_no_email", "Stripe customer has no email");
  }
  if (!isValidEmail(rawEmail)) {
    return empty("skipped_invalid_email", "Stripe customer email invalid");
  }

  const byEmail = await findAirtableMembersByPrimaryEmail(airtable, rawEmail);
  if (byEmail.length > 1) {
    return empty(
      "skipped_email_conflict",
      `Multiple Airtable members for email (${byEmail.length})`
    );
  }

  if (byEmail.length === 1) {
    const rec = byEmail[0];
    const existingIdRaw = rec.fields[STRIPE_CUSTOMER_ID_FIELD];
    const existingId =
      existingIdRaw == null || existingIdRaw === ""
        ? ""
        : String(existingIdRaw).trim();

    if (existingId && existingId !== stripeCustomerId) {
      return {
        stripeCustomerId,
        emailMasked,
        airtableRecordId: rec.id,
        action: "skipped_customer_id_conflict",
        paidThrough: paidThroughIso,
        reason: "Member already has a different Stripe Customer ID",
        updated: false,
        created: false,
        linked: false,
      };
    }

    const needsLink = !existingId;
    if (needsLink && !canLink && dryRun) {
      // dry-run preview
      const oldRaw = rec.fields[SERVICE_ACCESS_FIELD];
      const oldValue = oldRaw == null || oldRaw === "" ? null : String(oldRaw);
      const comparison = maxPaidThroughDate(
        oldValue,
        Math.floor(paidThrough.getTime() / 1000)
      );
      return {
        stripeCustomerId,
        emailMasked,
        airtableRecordId: rec.id,
        action: "would_link_and_update",
        paidThrough: paidThroughIso,
        reason: comparison.shouldUpdate
          ? "Would link Stripe Customer ID and update access"
          : `Would link Stripe Customer ID (${comparison.reason})`,
        updated: false,
        created: false,
        linked: false,
      };
    }

    if (needsLink && !canLink) {
      return {
        stripeCustomerId,
        emailMasked,
        airtableRecordId: rec.id,
        action: "skipped_create_not_enabled",
        paidThrough: paidThroughIso,
        reason: "Linking disabled (pass --apply-links or --apply)",
        updated: false,
        created: false,
        linked: false,
      };
    }

    if (needsLink && canLink && !dryRun) {
      await airtable.updateRecordsBatched(MEMBERS_TABLE, [
        {
          id: rec.id,
          fields: { [STRIPE_CUSTOMER_ID_FIELD]: stripeCustomerId },
        },
      ]);
    }

    const sync = await updateServiceAccessUntilForCustomer({
      airtable,
      stripeCustomerId,
      paidThrough,
      stripeInvoiceId: "historical-repair",
      dryRun,
    });

    // dry-run with blank id: update by id finds nothing — still report would_link
    if (dryRun && needsLink) {
      return {
        stripeCustomerId,
        emailMasked,
        airtableRecordId: rec.id,
        action: "would_link_and_update",
        paidThrough: paidThroughIso,
        reason: "Would link Stripe Customer ID and update access",
        updated: false,
        created: false,
        linked: false,
      };
    }

    return {
      stripeCustomerId,
      emailMasked,
      airtableRecordId: rec.id,
      action: needsLink
        ? dryRun
          ? "would_link_and_update"
          : "linked_and_updated"
        : dryRun
          ? "would_update_access"
          : sync.airtableRecordsUpdated > 0
            ? "updated_access"
            : "already_up_to_date",
      paidThrough: paidThroughIso,
      reason: needsLink
        ? "Linked via unique primary email"
        : "Email match already had customer id",
      updated: !dryRun && (needsLink || sync.airtableRecordsUpdated > 0),
      created: false,
      linked: needsLink && !dryRun,
    };
  }

  // No Airtable member — create only when explicitly enabled (historical CLI only)
  if (!canCreate) {
    return empty(
      dryRun ? "would_create_member" : "skipped_create_not_enabled",
      dryRun
        ? "Would create Member (pass --apply --create-missing)"
        : "Create disabled (pass --apply --create-missing)"
    );
  }

  const names = namesFromStripeCustomer(customer, rawEmail);
  const derived = await fetchDerivedCreateStatus(stripe, stripeCustomerId, membershipPriceIds);
  const fields: Record<string, unknown> = {
    [PRIMARY_EMAIL_FIELD]: normalizeEmailStrict(rawEmail),
    [FIRST_NAME_FIELD]: names.firstName,
    [LAST_NAME_FIELD]: names.lastName,
    [STRIPE_CUSTOMER_ID_FIELD]: stripeCustomerId,
    [SERVICE_ACCESS_FIELD]: paidThroughIso,
    // Reflect what Stripe says instead of leaving blank (blank Membership
    // reads as Active in Airtable filters).
    ...(derived.inspected
      ? {
          [MEMBERSHIP_FIELD]: derived.membership,
          [PAYMENT_FIELD]: "Paid",
          [CANCEL_AT_PERIOD_END_FIELD]: derived.cancelAtPeriodEnd,
          ...(derived.stripeSubscriptionId
            ? { [STRIPE_SUBSCRIPTION_ID_FIELD]: derived.stripeSubscriptionId }
            : {}),
          ...(derived.stripeSubscriptionStatus
            ? { [STRIPE_SUBSCRIPTION_STATUS_FIELD]: derived.stripeSubscriptionStatus }
            : {}),
          ...(derived.stripePriceId ? { [STRIPE_PRICE_ID_FIELD]: derived.stripePriceId } : {}),
          ...(derived.cancellationDate
            ? { [CANCELLATION_DATE_FIELD]: derived.cancellationDate }
            : {}),
          ...(derived.membership === "Cancelled"
            ? { [CANCELLATION_EFFECTIVE_AT_FIELD]: paidThroughIso }
            : {}),
          [LAST_INVOICE_ID_FIELD]: "historical-repair",
          [LAST_INVOICE_STATUS_FIELD]: "paid",
          [BILLING_LAST_SYNCED_AT_FIELD]: new Date().toISOString(),
        }
      : {}),
  };

  if (dryRun) {
    return {
      stripeCustomerId,
      emailMasked,
      airtableRecordId: "",
      action: "would_create_member",
      paidThrough: paidThroughIso,
      reason: derived.inspected
        ? `Would create Airtable Member (membership=${derived.membership})`
        : "Would create Airtable Member",
      updated: false,
      created: false,
      linked: false,
    };
  }

  const created = await airtable.createRecords(MEMBERS_TABLE, [{ fields }]);
  return {
    stripeCustomerId,
    emailMasked,
    airtableRecordId: created[0]?.id ?? "",
    action: "created_member",
    paidThrough: paidThroughIso,
    reason: "Created Airtable Member (historical repair only)",
    updated: true,
    created: true,
    linked: true,
  };
}

/**
 * One qualifying active/trialing Stripe subscription per customer.
 * Customer is the expanded object (email + name available when possible).
 */
export type ActiveMembershipSubscription = {
  subscriptionId: string;
  subscriptionStatus: string;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string;
  customer: Stripe.Customer;
  priceIds: string[];
  currentPeriodEndUnix: number | null;
  /** sub.ended_at — set for fully ended (canceled) subscriptions. */
  endedAtUnix?: number | null;
  /** sub.canceled_at — when the customer cancelled. */
  canceledAtUnix?: number | null;
};

/** Extract price_… ids from a subscription's items (expanded or legacy shapes). */
export function subscriptionItemPriceIds(sub: Stripe.Subscription): string[] {
  const ids: string[] = [];
  for (const it of sub.items?.data || []) {
    if (it.price && typeof it.price === "object" && typeof it.price.id === "string") {
      if (it.price.id.startsWith("price_")) ids.push(it.price.id);
      continue;
    }
    const legacy = it as unknown as {
      plan?: { id?: string };
      price?: string | { id?: string };
    };
    if (typeof legacy.price === "string" && legacy.price.startsWith("price_")) {
      ids.push(legacy.price);
    } else if (legacy.price && typeof legacy.price === "object" && legacy.price.id) {
      ids.push(legacy.price.id);
    } else if (legacy.plan?.id?.startsWith("price_")) {
      ids.push(legacy.plan.id);
    }
  }
  return [...new Set(ids)];
}

export function subscriptionCurrentPeriodEndUnix(
  sub: Stripe.Subscription
): number | null {
  const s = sub as unknown as {
    current_period_end?: number;
    items?: { data?: Array<{ current_period_end?: number }> };
  };
  if (typeof s.current_period_end === "number") return s.current_period_end;
  const itemEnd = s.items?.data?.[0]?.current_period_end;
  return typeof itemEnd === "number" ? itemEnd : null;
}

export function subscriptionCustomerId(sub: Stripe.Subscription): string {
  const c = sub.customer;
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && typeof c.id === "string") return c.id;
  return "";
}

/**
 * Enumerate Stripe subscriptions whose items contain a configured membership
 * price_ id, deduped to ONE best subscription per customer (rank active >
 * trialing > canceled, then latest current_period_end). Used for the active
 * census (active+trialing) and for the churn census (canceled).
 */
export async function listActiveMembershipSubscriptions(
  stripe: StripeListClient,
  membershipPriceIds: Set<string>,
  options?: {
    statuses?: Array<"active" | "trialing" | "canceled">;
    /** Stop early after N qualifying customers. */
    limit?: number;
  }
): Promise<ActiveMembershipSubscription[]> {
  const allow = new Set(
    [...(membershipPriceIds ?? [])].filter((id) => id.startsWith("price_"))
  );
  if (allow.size === 0) return [];

  const statuses = options?.statuses ?? ["active", "trialing"];
  const best = new Map<string, ActiveMembershipSubscription>();

  const rankStatus = (status: string) =>
    status === "active" ? 0 : status === "trialing" ? 1 : 2;

  statusLoop: for (const status of statuses) {
    let startingAfter: string | undefined;
    while (true) {
      const page = await stripe.subscriptions.list({
        status,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
        expand: ["data.customer", "data.items.data.price"],
      });
      for (const sub of page.data) {
        // Pause collection keeps subscription status "active" — the pause only
        // exists in `pause_collection`. Paused subs are NOT qualifying active
        // memberships: including them makes paused members look like paying
        // members ("holes") and lets repairs un-pause them in Airtable.
        if (sub.pause_collection != null) continue;
        if (options?.limit && best.size >= options.limit) break statusLoop;
        const priceIds = subscriptionItemPriceIds(sub).filter((id) =>
          allow.has(id)
        );
        if (priceIds.length === 0) continue;
        const customerId = subscriptionCustomerId(sub);
        if (!customerId.startsWith("cus_")) continue;

        const currentPeriodEndUnix = subscriptionCurrentPeriodEndUnix(sub);
        const cand: ActiveMembershipSubscription = {
          subscriptionId: sub.id,
          subscriptionStatus: sub.status,
          cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
          stripeCustomerId: customerId,
          customer: resolveExpandedCustomer(sub, customerId),
          priceIds,
          currentPeriodEndUnix,
          endedAtUnix: typeof sub.ended_at === "number" ? sub.ended_at : null,
          canceledAtUnix: typeof sub.canceled_at === "number" ? sub.canceled_at : null,
        };

        const prev = best.get(customerId);
        if (!prev) {
          best.set(customerId, cand);
          continue;
        }
        const prevRank = rankStatus(prev.subscriptionStatus);
        const candRank = rankStatus(sub.status);
        const prevEnd = prev.currentPeriodEndUnix ?? 0;
        const candEnd = currentPeriodEndUnix ?? 0;
        if (candRank < prevRank || (candRank === prevRank && candEnd > prevEnd)) {
          best.set(customerId, cand);
        }
      }
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1]?.id;
    }
  }

  return [...best.values()];
}

function resolveExpandedCustomer(
  sub: Stripe.Subscription,
  fallbackId: string
): Stripe.Customer {
  const c = sub.customer;
  if (c && typeof c === "object" && !("deleted" in c)) {
    return c as Stripe.Customer;
  }
  return { id: fallbackId } as Stripe.Customer;
}

/**
 * Reconcile ONE active membership subscription to Airtable.
 * Access date = subscription current_period_end (not paid invoices).
 * Exact Stripe Customer ID first, then unique primary email (CLI-only),
 * then create when enabled. Never shortens existing access.
 */
export async function repairActiveSubscription(input: {
  airtable: AirtableClient;
  customer: Stripe.Customer;
  membership: ActiveMembershipSubscription;
  canLink: boolean;
  canCreate: boolean;
  dryRun: boolean;
}): Promise<HistoricalRepairRow> {
  const { airtable, customer, membership, canLink, canCreate, dryRun } = input;
  const stripeCustomerId = customer.id;
  const rawEmail = extractStripeCustomerEmail(customer);
  const emailMasked = rawEmail ? maskEmail(rawEmail) : "";

  const empty = (action: HistoricalRepairAction, reason: string): HistoricalRepairRow => ({
    stripeCustomerId,
    emailMasked,
    airtableRecordId: "",
    action,
    paidThrough: "",
    reason,
    updated: false,
    created: false,
    linked: false,
  });

  if (!isValidStripeCustomerId(stripeCustomerId)) {
    return empty("error", "Invalid Stripe Customer ID");
  }
  if (membership.currentPeriodEndUnix == null) {
    return empty(
      "skipped_no_period_end",
      "Subscription missing current_period_end"
    );
  }

  const paidThrough = new Date(membership.currentPeriodEndUnix * 1000);
  const paidThroughIso = paidThrough.toISOString();
  const isTrial = membership.subscriptionStatus === "trialing";
  const billing: InvoiceBillingExtras = {
    qualifyingPriceIds: membership.priceIds,
    stripeSubscriptionId: membership.subscriptionId,
    stripeSubscriptionStatus: membership.subscriptionStatus,
    invoiceStatus: isTrial ? "" : "paid",
    cancelAtPeriodEnd: membership.cancelAtPeriodEnd,
  };
  const paymentValue = isTrial ? null : "Paid";

  // Prefer exact customer id match
  const byId = await airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `{${STRIPE_CUSTOMER_ID_FIELD}} = "${escapeAirtableFormulaString(stripeCustomerId)}"`,
    fields: [PRIMARY_EMAIL_FIELD, STRIPE_CUSTOMER_ID_FIELD, SERVICE_ACCESS_FIELD, "Name"],
  });

  if (byId.length > 0) {
    const sync = await updateServiceAccessUntilForCustomer({
      airtable,
      stripeCustomerId,
      paidThrough,
      stripeInvoiceId: "active-subscription-sync",
      dryRun,
      billing,
      paymentValue,
    });

    if (sync.status === "updated") {
      return {
        stripeCustomerId,
        emailMasked,
        airtableRecordId: sync.results[0]?.airtableRecordId ?? byId[0].id,
        action: dryRun ? "would_update_access" : "updated_access",
        paidThrough: paidThroughIso,
        reason: "Matched by Stripe Customer ID (active subscription)",
        updated: !dryRun && sync.airtableRecordsUpdated > 0,
        created: false,
        linked: false,
      };
    }
    if (sync.status === "already_up_to_date") {
      return {
        stripeCustomerId,
        emailMasked,
        airtableRecordId: byId[0].id,
        action: "already_up_to_date",
        paidThrough: paidThroughIso,
        reason: "Service access until already correct",
        updated: false,
        created: false,
        linked: false,
      };
    }
    if (sync.status === "existing_later") {
      return {
        stripeCustomerId,
        emailMasked,
        airtableRecordId: byId[0].id,
        action: "existing_later",
        paidThrough: paidThroughIso,
        reason: "Existing Service access until is later",
        updated: false,
        created: false,
        linked: false,
      };
    }
    return {
      stripeCustomerId,
      emailMasked,
      airtableRecordId: byId[0].id,
      action: sync.status === "invalid_existing_date" ? "error" : "already_up_to_date",
      paidThrough: paidThroughIso,
      reason: sync.results[0]?.reason ?? sync.status,
      updated: false,
      created: false,
      linked: false,
    };
  }

  if (!rawEmail) {
    return empty("skipped_no_email", "Stripe customer has no email");
  }
  if (!isValidEmail(rawEmail)) {
    return empty("skipped_invalid_email", "Stripe customer email invalid");
  }

  const byEmail = await findAirtableMembersByPrimaryEmail(airtable, rawEmail);
  if (byEmail.length > 1) {
    return empty(
      "skipped_email_conflict",
      `Multiple Airtable members for email (${byEmail.length})`
    );
  }

  if (byEmail.length === 1) {
    const rec = byEmail[0];
    const existingIdRaw = rec.fields[STRIPE_CUSTOMER_ID_FIELD];
    const existingId =
      existingIdRaw == null || existingIdRaw === ""
        ? ""
        : String(existingIdRaw).trim();

    if (existingId && existingId !== stripeCustomerId) {
      return {
        stripeCustomerId,
        emailMasked,
        airtableRecordId: rec.id,
        action: "skipped_customer_id_conflict",
        paidThrough: paidThroughIso,
        reason: "Member already has a different Stripe Customer ID",
        updated: false,
        created: false,
        linked: false,
      };
    }

    const needsLink = !existingId;
    if (needsLink && !canLink) {
      return {
        stripeCustomerId,
        emailMasked,
        airtableRecordId: rec.id,
        action: dryRun ? "would_link_and_update" : "skipped_create_not_enabled",
        paidThrough: paidThroughIso,
        reason: dryRun
          ? "Would link Stripe Customer ID and update access"
          : "Linking disabled (pass --apply-links or --apply)",
        updated: false,
        created: false,
        linked: false,
      };
    }

    if (needsLink && canLink && !dryRun) {
      await airtable.updateRecordsBatched(MEMBERS_TABLE, [
        {
          id: rec.id,
          fields: { [STRIPE_CUSTOMER_ID_FIELD]: stripeCustomerId },
        },
      ]);
    }

    const sync = await updateServiceAccessUntilForCustomer({
      airtable,
      stripeCustomerId,
      paidThrough,
      stripeInvoiceId: "active-subscription-sync",
      dryRun,
      billing,
      paymentValue,
    });

    if (dryRun && needsLink) {
      return {
        stripeCustomerId,
        emailMasked,
        airtableRecordId: rec.id,
        action: "would_link_and_update",
        paidThrough: paidThroughIso,
        reason: "Would link Stripe Customer ID and update access",
        updated: false,
        created: false,
        linked: false,
      };
    }

    return {
      stripeCustomerId,
      emailMasked,
      airtableRecordId: rec.id,
      action: needsLink
        ? "linked_and_updated"
        : sync.airtableRecordsUpdated > 0
          ? "updated_access"
          : "already_up_to_date",
      paidThrough: paidThroughIso,
      reason: needsLink
        ? "Linked via unique primary email"
        : "Email match already had customer id",
      updated: !dryRun && (needsLink || sync.airtableRecordsUpdated > 0),
      created: false,
      linked: needsLink && !dryRun,
    };
  }

  // No Airtable member — create only when explicitly enabled (historical CLI only)
  if (!canCreate) {
    return empty(
      dryRun ? "would_create_member" : "skipped_create_not_enabled",
      dryRun
        ? "Would create Member (pass --apply --create-missing)"
        : "Create disabled (pass --apply --create-missing)"
    );
  }

  const names = namesFromStripeCustomer(customer, rawEmail);
  const fields: Record<string, unknown> = {
    [PRIMARY_EMAIL_FIELD]: normalizeEmailStrict(rawEmail),
    [FIRST_NAME_FIELD]: names.firstName,
    [LAST_NAME_FIELD]: names.lastName,
    [STRIPE_CUSTOMER_ID_FIELD]: stripeCustomerId,
    [SERVICE_ACCESS_FIELD]: paidThroughIso,
    [MEMBERSHIP_FIELD]: "Active",
    [STRIPE_PRICE_ID_FIELD]: membership.priceIds[0] ?? "",
    [PAID_PLANS_FIELD]: formatPaidPlansText(membership.priceIds),
    [STRIPE_SUBSCRIPTION_ID_FIELD]: membership.subscriptionId,
    [STRIPE_SUBSCRIPTION_STATUS_FIELD]: membership.subscriptionStatus,
    [CANCEL_AT_PERIOD_END_FIELD]: membership.cancelAtPeriodEnd,
    ...(membership.cancelAtPeriodEnd
      ? { [CANCELLATION_EFFECTIVE_AT_FIELD]: paidThroughIso }
      : {}),
    [LAST_INVOICE_ID_FIELD]: "active-subscription-sync",
    [LAST_INVOICE_STATUS_FIELD]: isTrial ? "" : "paid",
    [BILLING_LAST_SYNCED_AT_FIELD]: new Date().toISOString(),
  };
  if (!isTrial) {
    fields[PAYMENT_FIELD] = "Paid";
  }

  if (dryRun) {
    return {
      stripeCustomerId,
      emailMasked,
      airtableRecordId: "",
      action: "would_create_member",
      paidThrough: paidThroughIso,
      reason: "Would create Airtable Member",
      updated: false,
      created: false,
      linked: false,
    };
  }

  const created = await airtable.createRecords(MEMBERS_TABLE, [{ fields }]);
  return {
    stripeCustomerId,
    emailMasked,
    airtableRecordId: created[0]?.id ?? "",
    action: "created_member",
    paidThrough: paidThroughIso,
    reason: "Created Airtable Member (active subscription sync)",
    updated: true,
    created: true,
    linked: true,
  };
}

export async function listStripeCustomersForRepair(
  stripe: StripeListClient,
  options?: { stripeCustomerId?: string; limit?: number }
): Promise<Stripe.Customer[]> {
  if (options?.stripeCustomerId) {
    const c = await stripe.customers.retrieve(options.stripeCustomerId);
    if ("deleted" in c && c.deleted) return [];
    return [c as Stripe.Customer];
  }

  const out: Stripe.Customer[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const page = await stripe.customers.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const c of page.data) {
      out.push(c);
      if (options?.limit && out.length >= options.limit) return out;
    }
    if (!page.has_more) break;
    if (page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return out;
}

/** Build assigned customer id set from Airtable records (for reporting). */
export function indexAirtableByCustomerId(
  records: AirtableRecord[]
): Map<string, AirtableRecord[]> {
  const map = new Map<string, AirtableRecord[]>();
  for (const r of records) {
    const id = String(r.fields[STRIPE_CUSTOMER_ID_FIELD] ?? "").trim();
    if (!id.startsWith("cus_")) continue;
    const list = map.get(id) || [];
    list.push(r);
    map.set(id, list);
  }
  return map;
}
