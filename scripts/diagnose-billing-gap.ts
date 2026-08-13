/**
 * READ-ONLY diagnostic: why does Stripe show more active membership billings
 * than the ops dashboard's "Future access total" (Service access until >= now)?
 *
 * Stripe active/trialing subscriptions (membership prices only) are compared
 * against Airtable members by exact Stripe Customer ID. No writes, ever.
 *
 * Usage:
 *   npx tsx scripts/diagnose-billing-gap.ts
 */
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { getStripeClient, getStripeNativeMembershipPriceIds } from "../src/lib/integrations/stripe";
import { MEMBERS_TABLE, MEMBER_FIELDS } from "../src/lib/ops/airtable-fields";
import { summarizeAirtableEntitlementSnapshot } from "../src/lib/introduction/service-access";
import {
  STRIPE_CUSTOMER_ID_FIELD,
  SERVICE_ACCESS_FIELD,
  resolveNativeMembershipAllowlist,
} from "../src/lib/billing/service-access-sync";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

const SK = process.env.STRIPE_SECRET_KEY;
const AT = process.env.AIRTABLE_GET_DATA_TOKEN;
const AB = process.env.AIRTABLE_BASE_ID;

function fStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

function subPriceIds(sub: unknown): string[] {
  const s = sub as {
    items?: { data?: Array<{ price?: { id?: string } | null; plan?: { id?: string } | null }> };
  };
  const ids: string[] = [];
  for (const it of s.items?.data || []) {
    if (it.price?.id?.startsWith("price_")) ids.push(it.price.id);
    else if (it.plan?.id?.startsWith("price_")) ids.push(it.plan.id);
  }
  return ids;
}

function subPeriodEndUnix(sub: unknown): number | null {
  const s = sub as {
    current_period_end?: number | null;
    items?: { data?: Array<{ current_period_end?: number | null }> };
  };
  if (typeof s.current_period_end === "number") return s.current_period_end;
  const itemEnd = s.items?.data?.[0]?.current_period_end;
  return typeof itemEnd === "number" ? itemEnd : null;
}

function customerOf(sub: unknown): string {
  const c = (sub as { customer?: string | { id?: string } | null }).customer;
  if (typeof c === "string") return c;
  return c?.id || "";
}

function parseAccessUntil(raw: string): { ok: boolean; ms: number } {
  const s = raw.trim();
  if (!s) return { ok: false, ms: NaN };
  const d = new Date(s.length <= 10 ? `${s}T23:59:59.999Z` : s);
  if (Number.isNaN(d.getTime())) return { ok: false, ms: NaN };
  return { ok: true, ms: d.getTime() };
}

async function main() {
  console.log("Billing gap diagnostic — Stripe active subs vs Airtable Service access until (READ ONLY)\n");

  if (!SK || !AT || !AB) {
    console.error("Missing STRIPE_SECRET_KEY, AIRTABLE_GET_DATA_TOKEN, or AIRTABLE_BASE_ID");
    process.exit(1);
  }

  const allow = resolveNativeMembershipAllowlist(
    getStripeNativeMembershipPriceIds({ requireConfigured: true, failClosedInProduction: false })
  );
  console.log(`Membership price_ allowlist (${allow.size}):`);
  for (const id of allow) console.log(`  ${id}`);

  const stripe = getStripeClient();
  const airtable = createAirtableClient({ apiKey: AT, baseId: AB });
  const nowMs = Date.now();
  const now = new Date(nowMs);

  // ── Stripe side ─────────────────────────────────────────────────────────
  console.log("\nListing Stripe subscriptions…");
  const stripeSubs = new Map<string, { id: string; status: string; customer: string; qualifies: boolean; periodEndUnix: number | null; customerEmail: string }>();
  for (const status of ["active", "trialing", "past_due", "unpaid"] as const) {
    let startingAfter: string | undefined;
    let page = 0;
    for (;;) {
      page++;
      const res = await stripe.subscriptions.list({
        status,
        limit: 100,
        starting_after: startingAfter,
        expand: ["data.items.data.price", "data.customer"],
      });
      console.log(`  [${status}] page ${page}: ${res.data.length} subs (has_more=${res.has_more})`);
      for (const sub of res.data) {
        const ids = subPriceIds(sub);
        const qualifies = ids.some((id) => allow.has(id));
        const raw = sub as unknown as { customer?: { email?: string } };
        stripeSubs.set(sub.id, {
          id: sub.id,
          status: sub.status,
          customer: customerOf(sub),
          qualifies,
          periodEndUnix: subPeriodEndUnix(sub),
          customerEmail: raw.customer?.email || "",
        });
      }
      if (!res.has_more || res.data.length === 0) break;
      startingAfter = res.data[res.data.length - 1]?.id;
    }
  }

  const activeOrTrialing = [...stripeSubs.values()].filter(
    (s) => s.qualifies && (s.status === "active" || s.status === "trialing")
  );
  const activeCustomers = new Set(activeOrTrialing.map((s) => s.customer).filter((c) => c.startsWith("cus_")));
  const activeOnly = activeOrTrialing.filter((s) => s.status === "active");
  const trialingOnly = activeOrTrialing.filter((s) => s.status === "trialing");
  const pastDueUnpaid = [...stripeSubs.values()].filter(
    (s) => s.qualifies && (s.status === "past_due" || s.status === "unpaid")
  );

  console.log(`\nStripe qualifying subscriptions:`);
  console.log(`  active:     ${activeOnly.length}`);
  console.log(`  trialing:   ${trialingOnly.length}`);
  console.log(`  past_due:   ${pastDueUnpaid.filter((s) => s.status === "past_due").length}`);
  console.log(`  unpaid:     ${pastDueUnpaid.filter((s) => s.status === "unpaid").length}`);
  console.log(`  active+trialing subs: ${activeOrTrialing.length} (unique customers: ${activeCustomers.size})`);

  // ── Airtable side ───────────────────────────────────────────────────────
  console.log("\nLoading Airtable MEMBERS…");
  const members = await airtable.listRecords(MEMBERS_TABLE, {
    fields: [
      MEMBER_FIELDS.name,
      MEMBER_FIELDS.email,
      MEMBER_FIELDS.membership,
      MEMBER_FIELDS.payment,
      MEMBER_FIELDS.serviceAccessUntil,
      MEMBER_FIELDS.stripeCustomerId,
    ],
  });
  console.log(`Loaded ${members.length} members`);

  const snapshot = summarizeAirtableEntitlementSnapshot(
    members.map((m) => ({
      membership: fStr(m.fields, MEMBER_FIELDS.membership),
      payment: fStr(m.fields, MEMBER_FIELDS.payment),
      serviceAccessUntil: fStr(m.fields, MEMBER_FIELDS.serviceAccessUntil) || null,
    })),
    now
  );
  console.log(`Dashboard "Future access total" (recomputed): ${snapshot.futureAccessTotal}`);

  const rowsByCus = new Map<string, Array<{ id: string; email: string; name: string; until: string; parsed: { ok: boolean; ms: number } }>>();
  for (const m of members) {
    const cus = fStr(m.fields, STRIPE_CUSTOMER_ID_FIELD);
    if (!cus.startsWith("cus_")) continue;
    const until = fStr(m.fields, SERVICE_ACCESS_FIELD);
    const row = {
      id: m.id,
      email: fStr(m.fields, MEMBER_FIELDS.email),
      name: fStr(m.fields, MEMBER_FIELDS.name),
      until,
      parsed: parseAccessUntil(until),
    };
    const list = rowsByCus.get(cus) || [];
    list.push(row);
    rowsByCus.set(cus, list);
  }

  // ── Compare ─────────────────────────────────────────────────────────────
  let linkedFuture = 0;
  let linkedExpired = 0;
  let linkedBlank = 0;
  let linkedInvalid = 0;
  let noAirtableLink = 0;
  let duplicateRows = 0;

  const gapRows: Array<Record<string, string>> = [];
  const activeSubsByCustomer = new Map<string, { periodEndUnix: number | null }>();
  for (const s of activeOrTrialing) activeSubsByCustomer.set(s.customer, { periodEndUnix: s.periodEndUnix });

  for (const cus of activeCustomers) {
    const rows = rowsByCus.get(cus);
    const stripePeriodEnd =
      activeSubsByCustomer.get(cus)?.periodEndUnix != null
        ? new Date((activeSubsByCustomer.get(cus)?.periodEndUnix as number) * 1000).toISOString()
        : "";
    const subRow = [...stripeSubs.values()].find((s) => s.customer === cus && s.qualifies);
    const subEmail = subRow?.customerEmail || "";
    if (!rows || rows.length === 0) {
      noAirtableLink++;
      gapRows.push({ customer: cus, bucket: "no_airtable_link", email: subEmail, until: "", stripePeriodEnd });
      continue;
    }
    if (rows.length > 1) duplicateRows++;
    const row = rows[0];
    if (!row.parsed.ok) {
      if (!row.until) linkedBlank++;
      else linkedInvalid++;
      gapRows.push({
        customer: cus,
        bucket: !row.until ? "linked_blank_access" : "linked_invalid_date",
        email: row.email || subEmail,
        until: row.until,
        stripePeriodEnd,
      });
    } else if (row.parsed.ms >= nowMs) {
      linkedFuture++;
    } else {
      linkedExpired++;
      gapRows.push({
        customer: cus,
        bucket: "linked_expired_access",
        email: row.email || subEmail,
        until: row.until,
        stripePeriodEnd,
      });
    }
  }

  // Future access rows whose customer is NOT stripe-active (prepaid grace, refunded-not-yet-fixed, etc.)
  let futureButNotActive = 0;
  for (const [cus, rows] of rowsByCus) {
    if (activeCustomers.has(cus)) continue;
    if (rows.some((r) => r.parsed.ok && r.parsed.ms >= nowMs)) futureButNotActive++;
  }

  console.log("\n========== GAP BREAKDOWN (Stripe active+trialing customers) ==========");
  console.log(`Stripe active+trialing unique customers:        ${activeCustomers.size}`);
  console.log(`  linked, future access (in dashboard count):   ${linkedFuture}`);
  console.log(`  linked, EXPIRED access (sub active → behind): ${linkedExpired}`);
  console.log(`  linked, BLANK access (never synced):          ${linkedBlank}`);
  console.log(`  linked, INVALID date:                         ${linkedInvalid}`);
  console.log(`  NO Airtable link (missing cus_ row):          ${noAirtableLink}`);
  console.log(`  (customers with multiple Airtable rows):      ${duplicateRows}`);
  console.log("");
  console.log(`Airtable future-access rows with NO active Stripe sub: ${futureButNotActive}`);
  console.log("");
  console.log(`Reconciliation:`);
  console.log(`  Stripe active customers        = ${activeCustomers.size}`);
  console.log(`  − not linked                  − ${noAirtableLink}`);
  console.log(`  − linked expired/blank/invalid− ${linkedExpired + linkedBlank + linkedInvalid}`);
  console.log(`  = linked future access        = ${linkedFuture}`);
  console.log(`  + future access, no active sub + ${futureButNotActive}`);
  console.log(`  = dashboard future access     = ${linkedFuture + futureButNotActive} (dashboard says ${snapshot.futureAccessTotal})`);

  // ── CSV of gap rows ─────────────────────────────────────────────────────
  const reportsDir = path.join(process.cwd(), "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const csvPath = path.join(reportsDir, `billing-gap-diagnostic-${ts}.csv`);
  const headers = ["customer", "bucket", "email", "until", "stripePeriodEnd"];
  const csvLines = [headers.join(",")];
  for (const r of gapRows) {
    csvLines.push(headers.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(","));
  }
  fs.writeFileSync(csvPath, csvLines.join("\n"));
  console.log(`\nGap rows CSV: ${csvPath} (${gapRows.length} rows)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
