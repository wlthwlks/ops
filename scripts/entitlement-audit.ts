/**
 * READ-ONLY Stripe ↔ Airtable membership entitlement audit.
 * NEVER creates Airtable members. NEVER writes Airtable.
 *
 * Usage:
 *   npm run billing:audit
 *   npm run billing:audit -- --customer=cus_xxx
 *   npm run billing:audit -- --limit=100
 *   npm run billing:audit -- --future-access-only
 *   npm run billing:audit -- --concurrency=3
 */
import * as dotenv from "dotenv";
import * as fs from "fs";
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

type Classification =
  | "VALID_ACTIVE_ENTITLEMENT" | "VALID_CANCEL_AT_PERIOD_END"
  | "VALID_CANCELLED_PREPAID" | "EXPIRED_ENTITLEMENT"
  | "LEGACY_ACTIVE_PAID_WITHOUT_CURRENT_PAID_THROUGH"
  | "ACTIVE_PAID_MISSING_SERVICE_ACCESS" | "ACTIVE_PAID_EXPIRED_SERVICE_ACCESS"
  | "AIRTABLE_ACCESS_BEHIND_STRIPE" | "AIRTABLE_ACCESS_LATER_THAN_STRIPE"
  | "FULLY_REFUNDED_WITH_FUTURE_ACCESS" | "PARTIALLY_REFUNDED"
  | "IMMEDIATE_CANCEL_WITH_FUTURE_ACCESS" | "NO_QUALIFYING_STRIPE_PAYMENT"
  | "MISSING_STRIPE_CUSTOMER_ID" | "STRIPE_CUSTOMER_NOT_FOUND"
  | "MULTIPLE_ACTIVE_MEMBERSHIP_SUBSCRIPTIONS" | "AMBIGUOUS_CANCELLATION"
  | "UNVERIFIABLE";

function fStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key]; if (v == null) return ""; return String(v).trim();
}

function parseArgs(): Record<string, string> {
  const opts: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith("--")) continue;
    const kv = arg.slice(2);
    const eq = kv.indexOf("=");
    opts[eq >= 0 ? kv.slice(0, eq) : kv] = eq >= 0 ? kv.slice(eq + 1) : "true";
  }
  return opts;
}

async function loadMembers(opts: Record<string, string>): Promise<AirtableRecord[]> {
  const airtable = createAirtableClient({ apiKey: AT!, baseId: AB! });
  const limit = parseInt(opts.limit || "0", 10) || 0;
  if (opts.customer) return airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: '{Stripe Customer ID} = "' + opts.customer.replace(/"/g, '\\"') + '"',
    maxRecords: 5,
  });
  if (opts.email) return airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: 'LOWER({email}) = "' + opts.email.trim().toLowerCase().replace(/"/g, '\\"') + '"',
    maxRecords: 5,
  });
  if (opts["airtable-record"]) return airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: 'RECORD_ID() = "' + opts["airtable-record"].trim() + '"',
    maxRecords: 1,
  });
  if (opts["future-access-only"]) {
    const now = new Date().toISOString();
    return airtable.listRecords(MEMBERS_TABLE, {
      filterByFormula: 'IS_AFTER({Service access until}, "' + now.slice(0, 10) + '")',
      maxRecords: limit || 5000,
    });
  }
  return airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: 'OR({Stripe Customer ID} != "", {Membership} = "Active")',
    maxRecords: limit || 5000,
  });
}

async function deriveEntitlement(cus: string): Promise<Record<string, unknown> | null> {
  const Stripe = (await import("stripe")).default;
  const client = new Stripe(SK!, { apiVersion: "2026-06-24.dahlia", typescript: true, maxNetworkRetries: 1, timeout: 20_000 });
  const allow = resolveNativeMembershipAllowlist(getStripeNativeMembershipPriceIds({ requireConfigured: false, failClosedInProduction: false }));
  try {
    const invoices = await listPaidInvoicesForCustomer({ invoices: client.invoices as never }, cus);
    const qpays: Array<Record<string, unknown>> = [];
    const priceIds = new Set<string>(); const subIds = new Set<string>(); const notes: string[] = [];
    for (const inv of invoices) {
      if (!inv.id) continue;
      const lines = await listAllInvoiceLines({ invoices: client.invoices as never }, inv.id);
      const qp = getMembershipPeriodEnd(lines, allow); if (qp == null) continue;
      const linePrices: string[] = [];
      for (const line of lines) { const pid = getLinePriceId(line); if (pid && allow.has(pid)) { linePrices.push(pid); priceIds.add(pid); } }
      if (linePrices.length === 0) continue;
      const cId = (inv as unknown as {charge?:string}).charge;
      let rk = "none"; let ar = 0; const ap = (inv as unknown as {amount_paid?:number}).amount_paid ?? 0;
      if (cId?.startsWith("ch_")) {
        try {
          const ch = await (client.charges as unknown as {retrieve:(id:string)=>Promise<{amount_refunded?:number;refunded?:boolean}>}).retrieve(cId);
          rk = ch.amount_refunded != null && Number(ch.amount_refunded) > 0
            ? Number(ch.amount_refunded) >= ap ? "full" : "partial"
            : ch.refunded ? "full" : "none";
          ar = Number(ch.amount_refunded ?? 0);
        } catch { notes.push("Charge " + cId + " failed"); }
      }
      const sId = (inv as unknown as {subscription?:string}).subscription;
      if (sId) subIds.add(sId);
      qpays.push({ invoiceId: inv.id, chargeId: cId ?? null, subscriptionId: sId ?? null,
        priceIds: linePrices, periodEndUnix: qp, periodEndIso: new Date(qp*1000).toISOString(),
        refundKind: rk, contributesToEntitlement: rk !== "full", amountPaid: ap, amountRefunded: ar });
    }
    const contrib = qpays.filter(p => p.contributesToEntitlement as boolean);
    let put: number|null = null;
    for (const p of contrib) { const e = p.periodEndUnix as number; if (put == null || e > put) put = e; }
    let subStatus = ""; let cape = false; let ck = "none"; let ecu: number|null = null;
    try {
      const subs = await client.subscriptions.list({ customer: cus, status: "all", limit: 20 });
      const ranked = [...subs.data].sort((a,b) => { const r = (s:{status:string}) => s.status==="active"||s.status==="trialing"?0:1; return r(a)-r(b); });
      const primary = ranked[0];
      if (primary) {
        subStatus = primary.status ?? ""; cape = Boolean(primary.cancel_at_period_end);
        const ps = primary as unknown as {cancel_at?:number;canceled_at?:number;ended_at?:number;current_period_end?:number};
        const cls = classifySubscriptionCancellation({ status: primary.status, cancel_at_period_end: primary.cancel_at_period_end,
          cancel_at: ps.cancel_at, canceled_at: ps.canceled_at, ended_at: ps.ended_at, current_period_end: ps.current_period_end }, { paidThroughUnix: put });
        ck = cls.kind; ecu = cls.effectiveUnix; notes.push(...cls.notes);
        if (cls.kind==="immediate" && cls.effectiveUnix!=null && put!=null && cls.effectiveUnix < put) { put = cls.effectiveUnix; notes.push("Clamped to immediate cancel"); }
        // Active subs are entitled through the CURRENT period end even while the
        // renewal invoice is open/draft (Stripe keeps them active until dunning fails).
        const itemEnd = primary.items?.data?.[0]?.current_period_end;
        const periodEnd = (typeof ps.current_period_end === "number" ? ps.current_period_end : typeof itemEnd === "number" ? itemEnd : null) as number | null;
        if (primary.status === "active" && periodEnd != null && (put == null || periodEnd > put)) {
          put = periodEnd;
          notes.push("Active subscription — paid-through promoted to current period end");
        }
      }
    } catch { notes.push("Sub list failed"); }
    return { stripeCustomerId: cus, hasEntitlementNow: put!=null && put>=Math.floor(Date.now()/1000),
      paidThroughUnix: put, paidThroughIso: put!=null?new Date(put*1000).toISOString():null, referenceUnix: Math.floor(Date.now()/1000),
      qualifyingPayments: qpays, contributingInvoiceIds: contrib.map(p=>p.invoiceId),
      fullyRefundedInvoiceIds: qpays.filter(p=>p.refundKind==="full").map(p=>p.invoiceId),
      partiallyRefundedInvoiceIds: qpays.filter(p=>p.refundKind==="partial").map(p=>p.invoiceId),
      subscriptionIds: [...subIds], priceIds: [...priceIds], primarySubscription: null,
      cancellationKind: ck, effectiveCancellationUnix: ecu, notes, confidence: contrib.length>0?"high":"low" };
  } catch(e) {
    return { stripeCustomerId: cus, hasEntitlementNow: false, paidThroughUnix: null, paidThroughIso: null,
      referenceUnix: Math.floor(Date.now()/1000), qualifyingPayments: [], contributingInvoiceIds: [],
      fullyRefundedInvoiceIds: [], partiallyRefundedInvoiceIds: [], subscriptionIds: [], priceIds: [],
      primarySubscription: null, cancellationKind: "none", effectiveCancellationUnix: null,
      notes: ["Error: "+(e instanceof Error?e.message:e)], confidence: "low" };
  }
}

function classify(member: AirtableRecord, ent: Record<string,unknown>|null): {cls:Classification;action:string;conf:string;notes:string} {
  const m = fStr(member.fields, MEMBERSHIP_FIELD); const p = fStr(member.fields, PAYMENT_FIELD);
  const at = fStr(member.fields, SERVICE_ACCESS_FIELD); const ap = m==="Active"&&p==="Paid";
  if (!ent) return { cls: "UNVERIFIABLE", action: "Check connectivity", conf: "low", notes: "" };
  const leg = evaluateServiceAccess(m,p,at||null,new Date(),"legacy");
  const v2a = evaluateServiceAccess(m,p,at||null,new Date(),"v2");
  const se = Boolean(ent.hasEntitlementNow);
  const fr = (ent.fullyRefundedInvoiceIds as string[]|undefined)?.length ?? 0 > 0;
  const pr = (ent.partiallyRefundedInvoiceIds as string[]|undefined)?.length ?? 0 > 0;
  const ic = ent.cancellationKind === "immediate";
  const cape = ent.cancellationKind === "cancel_at_period_end";
  const hqp = (ent.contributingInvoiceIds as string[]|undefined)?.length ?? 0 > 0;
  const atMs = at ? new Date(at).getTime() : null;
  const stMs = ent.paidThroughIso ? new Date(ent.paidThroughIso as string).getTime() : null;
  if (fr && atMs != null && atMs > Date.now() && !ic) return { cls:"FULLY_REFUNDED_WITH_FUTURE_ACCESS", action:"Recalculate excluding refunds, clamp access", conf:"high", notes:"Fully refunded: "+(ent.fullyRefundedInvoiceIds as string[]).join(",") };
  if (pr) return { cls:"PARTIALLY_REFUNDED", action:"Manual review", conf:"medium", notes:"Partial refunds: "+(ent.partiallyRefundedInvoiceIds as string[]).join(",") };
  if (ic && atMs != null && atMs > Date.now()) return { cls:"IMMEDIATE_CANCEL_WITH_FUTURE_ACCESS", action:"Clamp access to cancellation time", conf:(ent.confidence as string)??"medium", notes:"" };
  if (cape && v2a.accessible && !ap) return { cls:"VALID_CANCEL_AT_PERIOD_END", action:"None -- legitimate prepaid", conf:"high", notes:"" };
  if (!ap && v2a.accessible) return { cls:"VALID_CANCELLED_PREPAID", action:"None -- legitimate prepaid", conf:"high", notes:"" };
  if (se && v2a.accessible) return { cls:"VALID_ACTIVE_ENTITLEMENT", action:"None", conf:"high", notes:"" };
  if (ap && !se && !hqp) {
    if (atMs == null) return { cls:"ACTIVE_PAID_MISSING_SERVICE_ACCESS", action:"Investigate", conf:"medium", notes:"" };
    if (atMs < Date.now()) return { cls:"ACTIVE_PAID_EXPIRED_SERVICE_ACCESS", action:"Expired access", conf:"medium", notes:"" };
    return { cls:"LEGACY_ACTIVE_PAID_WITHOUT_CURRENT_PAID_THROUGH", action:"Legacy bypass -- would lose under V2", conf:"medium", notes:"Would lose under V2" };
  }
  if (atMs != null && stMs != null && atMs < stMs) return { cls:"AIRTABLE_ACCESS_BEHIND_STRIPE", action:"Update to Stripe paid-through", conf:"high", notes:"" };
  if (atMs != null && stMs != null && atMs > stMs) return { cls:"AIRTABLE_ACCESS_LATER_THAN_STRIPE", action:"Do NOT auto-shorten", conf:"medium", notes:"May be legitimate" };
  if (!hqp && ap) return { cls:"NO_QUALIFYING_STRIPE_PAYMENT", action:"Verify payment history", conf:"low", notes:"" };
  return { cls:"UNVERIFIABLE", action:"Manual review", conf:"low", notes:"" };
}

async function main() {
  console.log("WLTH WLKS Billing Entitlement Audit -- READ ONLY\n");
  if (!SK || !AT || !AB) { console.error("Missing STRIPE_SECRET_KEY, AIRTABLE_GET_DATA_TOKEN, or AIRTABLE_BASE_ID"); process.exit(1); }
  const args = parseArgs();
  const members = await loadMembers(args);
  console.log("Loaded " + members.length + " Airtable members\n");
  const rows: Array<Record<string,unknown>> = [];
  const concurrency = Math.min(5, parseInt(args.concurrency||"3",10)||3);
  const seen = new Set<string>();
  for (let i = 0; i < members.length; i += concurrency) {
    const batch = members.slice(i, i+concurrency);
    const batchRows = await Promise.all(batch.map(async member => {
      const cusId = fStr(member.fields, STRIPE_CUSTOMER_ID_FIELD);
      const m = fStr(member.fields, MEMBERSHIP_FIELD); const p = fStr(member.fields, PAYMENT_FIELD);
      const at = fStr(member.fields, SERVICE_ACCESS_FIELD);
      const now = new Date();
      const leg = evaluateServiceAccess(m,p,at||null,now,"legacy");
      const v2a = evaluateServiceAccess(m,p,at||null,now,"v2");
      let ent: Record<string,unknown>|null = null;
      if (cusId.startsWith("cus_") && !seen.has(cusId)) { ent = await deriveEntitlement(cusId); if (ent) seen.add(cusId); }
      const cls = classify(member, ent);
      const atMs = at ? new Date(at).getTime() : NaN;
      const stMs = ent?.paidThroughIso ? new Date(ent.paidThroughIso as string).getTime() : NaN;
      const diffDays = !Number.isNaN(atMs) && !Number.isNaN(stMs) ? Math.round((atMs-stMs)/86400000) : null;
      return {
        "Airtable Record ID": member.id, Name: fStr(member.fields, MEMBER_FIELDS.name),
        Email: fStr(member.fields, MEMBER_FIELDS.email), "Stripe Customer ID": cusId,
        Membership: m, Payment: p, "Airtable Service access until": at,
        "Legacy has service": leg.accessible, "V2 has service": v2a.accessible,
        "Stripe entitled now": ent?.hasEntitlementNow??false, "Stripe paid-through": ent?.paidThroughIso??"",
        "Stripe sub status": ent?.cancellationKind??"", "Cancel at period end": ent?.cancelAtPeriodEnd??"",
        "Full refund": (ent?.fullyRefundedInvoiceIds as string[]|undefined)?.length??0>0,
        "Partial refund": (ent?.partiallyRefundedInvoiceIds as string[]|undefined)?.length??0>0,
        "Relevant invoices": (ent?.contributingInvoiceIds as string[]|undefined)?.join(", ")??"",
        "Relevant subs": (ent?.subscriptionIds as string[]|undefined)?.join(", ")??"",
        Classification: cls.cls, "Difference days": diffDays,
        "Recommended action": cls.action, Confidence: cls.conf, Notes: cls.notes,
      };
    }));
    rows.push(...batchRows);
    if (rows.length % 10 === 0) console.log("Processed " + rows.length + "/" + members.length + "...");
  }
  // Summary
  const counts = new Map<string,number>();
  for (const r of rows) { const c = r.Classification as string; counts.set(c, (counts.get(c)||0)+1); }
  console.log("\n=== CLASSIFICATIONS ===");
  for (const [k,v] of [...counts].sort((a,b)=>b[1]-a[1])) console.log("  " + k + ": " + v);
  const legC = rows.filter(r=>r["Legacy has service"]).length;
  const v2C = rows.filter(r=>r["V2 has service"]).length;
  console.log("\n=== LEGACY vs V2 ===");
  console.log("Legacy access: " + legC);
  console.log("V2 access:     " + v2C);
  console.log("Would lose under V2: " + (legC - v2C));
  console.log("Would gain under V2:  " + rows.filter(r=>!r["Legacy has service"] && r["V2 has service"]).length);
  // CSV output
  if (rows.length > 0) {
    const ts = new Date().toISOString().slice(0,16).replace(/[:T]/g,"-");
    const csvFile = "reports/billing-entitlement-audit-" + ts + ".csv";
    const headers = Object.keys(rows[0]);
    const csvLines = [headers.join(",")];
    for (const r of rows) csvLines.push(headers.map(h=>'"'+String(r[h]??"").replace(/"/g,'""')+'"').join(","));
    fs.writeFileSync(csvFile, csvLines.join("\n"));
    console.log("\nCSV report: " + csvFile);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
