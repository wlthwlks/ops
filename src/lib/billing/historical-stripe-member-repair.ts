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
  computeLatestMembershipPeriodEndForCustomer,
  escapeAirtableFormulaString,
  isValidStripeCustomerId,
  maxPaidThroughDate,
  updateServiceAccessUntilForCustomer,
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
  // Writes only with --apply or --apply-links. create-missing requires --apply.
  const dryRun = !apply && !applyLinks;
  const canLink = apply || applyLinks;
  const canCreate = apply && createMissing;

  let limit: number | undefined;
  let stripeCustomerId: string | undefined;
  let output = "tmp/historical-stripe-member-repair.csv";

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
    dryRun,
    canLink,
    canCreate,
    limit,
    stripeCustomerId,
    output,
  };
}

export function nameFromStripeCustomer(
  customer: Stripe.Customer,
  email: string
): string {
  const n = typeof customer.name === "string" ? customer.name.trim() : "";
  if (n) return n;
  const local = email.split("@")[0] || email;
  return local;
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

  const fields: Record<string, unknown> = {
    [PRIMARY_EMAIL_FIELD]: normalizeEmailStrict(rawEmail),
    Name: nameFromStripeCustomer(customer, rawEmail),
    [STRIPE_CUSTOMER_ID_FIELD]: stripeCustomerId,
    [SERVICE_ACCESS_FIELD]: paidThroughIso,
  };

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
    reason: "Created Airtable Member (historical repair only)",
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
