/**
 * Stripe-to-Airtable membership entitlement reconciliation.
 * DEFAULT: dry-run (ZERO Airtable writes).
 * --apply required for writes. Only HIGH-confidence corrections auto-applied.
 * NEVER creates Airtable members. Exact Stripe Customer ID matching only.
 */
import * as dotenv from "dotenv";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import {
  SERVICE_ACCESS_FIELD, STRIPE_CUSTOMER_ID_FIELD, MEMBERSHIP_FIELD, PAYMENT_FIELD,
  listPaidInvoicesForCustomer, listAllInvoiceLines, getMembershipPeriodEnd,
  resolveNativeMembershipAllowlist, getLinePriceId,
} from "../src/lib/billing/service-access-sync";
import { classifySubscriptionCancellation } from "../src/lib/billing/stripe-entitlement";
import { evaluateServiceAccess } from "../src/lib/introduction/service-access";
import { getStripeNativeMembershipPriceIds } from "../src/lib/integrations/stripe";
import { MEMBER_FIELDS, MEMBERS_TABLE } from "../src/lib/ops/airtable-fields";
import type { AirtableRecord } from "../src/lib/integrations/airtable";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

const SK = process.env.STRIPE_SECRET_KEY;
const AT = process.env.AIRTABLE_GET_DATA_TOKEN;
const AB = process.env.AIRTABLE_BASE_ID;

function fStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key]; if (v == null) return ""; return String(v).trim();
}

type Correction = {
  airtableRecordId: string;
  stripeCustomerId: string;
  field: string;
  oldValue: string;
  newValue: string;
  reason: string;
  confidence: "high"|"medium"|"low";
};

async function main() {
  const args: Record<string,string> = {};
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith("--")) continue;
    const kv = arg.slice(2); const eq = kv.indexOf("=");
    args[eq >= 0 ? kv.slice(0, eq) : kv] = eq >= 0 ? kv.slice(eq + 1) : "true";
  }
  const apply = args.apply === "true";
  if (!apply) console.log("DRY RUN -- no Airtable writes. Add --apply to commit.\n");
  else console.log("APPLY MODE: will write high-confidence corrections.\n");

  if (!SK || !AT || !AB) {
    console.error("Missing STRIPE_SECRET_KEY, AIRTABLE_GET_DATA_TOKEN, or AIRTABLE_BASE_ID");
    process.exit(1);
  }

  const airtable = createAirtableClient({ apiKey: AT, baseId: AB });
  let members: AirtableRecord[];
  if (args.customer) {
    members = await airtable.listRecords(MEMBERS_TABLE, {
      filterByFormula: '{Stripe Customer ID} = "' + args.customer.replace(/"/g,'\\"') + '"',
      maxRecords: 5,
    });
  } else if (args.email) {
    members = await airtable.listRecords(MEMBERS_TABLE, {
      filterByFormula: 'LOWER({email}) = "' + args.email.trim().toLowerCase().replace(/"/g,'\\"') + '"',
      maxRecords: 5,
    });
  } else {
    members = await airtable.listRecords(MEMBERS_TABLE, {
      filterByFormula: 'OR({Stripe Customer ID} != "", {Membership} = "Active")',
      maxRecords: parseInt(args.limit||"100",10)||100,
    });
  }
  console.log("Loaded " + members.length + " Airtable members\n");

  const Stripe = (await import("stripe")).default;
  const client = new Stripe(SK, { apiVersion: "2026-06-24.dahlia", typescript: true, maxNetworkRetries: 1, timeout: 20_000 });
  const allow = resolveNativeMembershipAllowlist(getStripeNativeMembershipPriceIds({ requireConfigured: false, failClosedInProduction: false }));
  const corrections: Correction[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const member of members) {
    const cusId = fStr(member.fields, STRIPE_CUSTOMER_ID_FIELD);
    if (!cusId.startsWith("cus_")) { skipped.push(member.id + ": missing Stripe ID"); continue; }
    if (seen.has(cusId)) { skipped.push(member.id + ": duplicate Stripe ID " + cusId); continue; }
    seen.add(cusId);

    const m = fStr(member.fields, MEMBERSHIP_FIELD); const p = fStr(member.fields, PAYMENT_FIELD);
    const at = fStr(member.fields, SERVICE_ACCESS_FIELD);
    const ap = m === "Active" && p === "Paid";
    const leg = evaluateServiceAccess(m, p, at||null, new Date(), "legacy");
    const v2a = evaluateServiceAccess(m, p, at||null, new Date(), "v2");

    // Get Stripe entitlement
    let paidThroughIso: string|null = null;
    let hasEntitlement = false;
    let frInvoices: string[] = [];
    let prInvoices: string[] = [];
    let cancelKind = "none";
    let ecu: number|null = null;
    try {
      const invoices = await listPaidInvoicesForCustomer({ invoices: client.invoices as never }, cusId);
      const qpays: Array<Record<string,unknown>> = []; const contribs: string[] = [];
      for (const inv of invoices) {
        if (!inv.id) continue;
        const lines = await listAllInvoiceLines({ invoices: client.invoices as never }, inv.id);
        const qp = getMembershipPeriodEnd(lines, allow); if (qp == null) continue;
        const lp: string[] = [];
        for (const line of lines) { const pid = getLinePriceId(line); if (pid && allow.has(pid)) lp.push(pid); }
        if (lp.length === 0) continue;
        const cId = (inv as unknown as {charge?:string}).charge;
        let rk = "none"; const ap = (inv as unknown as {amount_paid?:number}).amount_paid??0;
        if (cId?.startsWith("ch_")) {
          try {
            const ch = await (client.charges as unknown as {retrieve:(id:string)=>Promise<{amount_refunded?:number;refunded?:boolean}>}).retrieve(cId);
            rk = ch.amount_refunded != null && Number(ch.amount_refunded) > 0
              ? Number(ch.amount_refunded) >= ap ? "full" : "partial"
              : ch.refunded ? "full" : "none";
          } catch {}
        }
        qpays.push({ periodEndUnix: qp, refundKind: rk, invoiceId: inv.id });
        if (rk !== "full") contribs.push(inv.id);
        if (rk === "full") frInvoices.push(inv.id);
        if (rk === "partial") prInvoices.push(inv.id);
      }
      let put: number|null = null;
      for (const p of contribs) {
        const pe = qpays.find(q=>q.invoiceId===p)?.periodEndUnix as number|undefined;
        if (pe != null && (put==null || pe>put)) put = pe;
      }
      // Check cancellation
      try {
        const subs = await client.subscriptions.list({ customer: cusId, status: "all", limit: 20 });
        const ranked = [...subs.data].sort((a,b) => { const r = (s:{status:string}) => s.status==="active"||s.status==="trialing"?0:1; return r(a)-r(b); });
        const primary = ranked[0];
        if (primary) {
          const ps = primary as unknown as {cancel_at?:number;canceled_at?:number;ended_at?:number;current_period_end?:number};
          const cls = classifySubscriptionCancellation({
            status: primary.status, cancel_at_period_end: primary.cancel_at_period_end,
            cancel_at: ps.cancel_at, canceled_at: ps.canceled_at, ended_at: ps.ended_at,
            current_period_end: ps.current_period_end,
          }, { paidThroughUnix: put });
          cancelKind = cls.kind; ecu = cls.effectiveUnix;
          if (cls.kind==="immediate" && cls.effectiveUnix!=null && put!=null && cls.effectiveUnix<put) put = cls.effectiveUnix;
        }
      } catch {}
      hasEntitlement = put != null && put >= Math.floor(Date.now()/1000);
      paidThroughIso = put != null ? new Date(put*1000).toISOString() : null;
    } catch (e) {
      skipped.push(member.id + ": Stripe error " + (e instanceof Error ? e.message : ""));
      continue;
    }

    const atMs = at ? new Date(at).getTime() : NaN;
    const stMs = paidThroughIso ? new Date(paidThroughIso).getTime() : NaN;

    // HIGH CONFIDENCE: Airtable behind Stripe (update forward)
    if (!Number.isNaN(atMs) && !Number.isNaN(stMs) && atMs < stMs && !frInvoices.length) {
      corrections.push({
        airtableRecordId: member.id, stripeCustomerId: cusId,
        field: SERVICE_ACCESS_FIELD, oldValue: at, newValue: paidThroughIso!,
        reason: "Airtable behind Stripe paid-through", confidence: "high",
      });
      continue;
    }

    // HIGH CONFIDENCE: fully refunded with future access (clamp)
    if (frInvoices.length > 0 && atMs > Date.now() && paidThroughIso && !Number.isNaN(stMs) && stMs < atMs) {
      corrections.push({
        airtableRecordId: member.id, stripeCustomerId: cusId,
        field: SERVICE_ACCESS_FIELD, oldValue: at, newValue: paidThroughIso,
        reason: "Fully refunded qualifying invoice -- recalculated entitlement",
        confidence: "high",
      });
      corrections.push({
        airtableRecordId: member.id, stripeCustomerId: cusId,
        field: PAYMENT_FIELD, oldValue: p, newValue: "Refunded",
        reason: "Full refund -- Payment set to Refunded",
        confidence: "high",
      });
      continue;
    }

    // HIGH CONFIDENCE: immediate cancel with future access
    if (cancelKind === "immediate" && ecu != null && atMs > Date.now()) {
      corrections.push({
        airtableRecordId: member.id, stripeCustomerId: cusId,
        field: SERVICE_ACCESS_FIELD, oldValue: at,
        newValue: new Date(ecu*1000).toISOString(),
        reason: "Immediate cancellation -- clamp to effective cancellation time",
        confidence: "high",
      });
      continue;
    }

    // Skip partial refunds (manual review)
    if (prInvoices.length > 0) {
      skipped.push(member.id + ": partial refund -- manual review");
      continue;
    }

    // Skip ambiguous
    if (cancelKind === "ambiguous") {
      skipped.push(member.id + ": ambiguous cancellation -- manual review");
      continue;
    }

    skipped.push(member.id + ": no high-confidence correction needed");
  }

  console.log("=== CORRECTIONS (" + corrections.length + ") ===");
  for (const c of corrections) {
    console.log("  [" + c.confidence + "] " + c.airtableRecordId + ": " + c.field + " " + c.oldValue + " -> " + c.newValue + " (" + c.reason + ")");
  }
  console.log("\n=== SKIPPED (" + skipped.length + ") ===");
  for (const s of skipped.slice(0, 20)) console.log("  " + s);
  if (skipped.length > 20) console.log("  ... and " + (skipped.length-20) + " more");

  if (apply && corrections.length > 0) {
    if (corrections.some(c => c.confidence !== "high")) {
      console.log("\n** ABORTING: non-high-confidence corrections present -- only high-confidence auto-applied **");
      process.exit(1);
    }
    console.log("\nApplying " + corrections.length + " high-confidence corrections...");
    const batches = [];
    for (let i = 0; i < corrections.length; i += 10) batches.push(corrections.slice(i, i+10));
    for (const batch of batches) {
      const records = batch.map(c => ({
        id: c.airtableRecordId,
        fields: { [c.field]: c.newValue },
      }));
      await airtable.updateRecordsBatched(MEMBERS_TABLE, records);
      console.log("  Wrote batch of " + batch.length);
    }
    console.log("Done -- " + corrections.length + " corrections applied.");
  } else {
    console.log("\nNo writes applied (dry run). Use --apply to commit high-confidence corrections.");
  }
}
main().catch(e => { console.error(e); process.exit(1); });
