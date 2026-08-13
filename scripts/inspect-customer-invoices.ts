/**
 * READ-ONLY: inspect one Stripe customer's paid invoices + lines to explain a
 * stale Airtable "Service access until".
 * Usage: npx tsx scripts/inspect-customer-invoices.ts --customer=cus_xxx
 */
import * as dotenv from "dotenv";
import { getStripeClient, getStripeNativeMembershipPriceIds } from "../src/lib/integrations/stripe";
import {
  resolveNativeMembershipAllowlist,
  getLinePriceId,
  listPaidInvoicesForCustomer,
  listAllInvoiceLines,
  getMembershipPeriodEnd,
} from "../src/lib/billing/service-access-sync";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

async function main() {
  const args: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith("--")) continue;
    const kv = a.slice(2);
    const eq = kv.indexOf("=");
    args[eq >= 0 ? kv.slice(0, eq) : kv] = eq >= 0 ? kv.slice(eq + 1) : "true";
  }
  const cus = args.customer;
  if (!cus?.startsWith("cus_")) {
    console.error("Pass --customer=cus_xxx");
    process.exit(1);
  }

  const allow = resolveNativeMembershipAllowlist(
    getStripeNativeMembershipPriceIds({ requireConfigured: true, failClosedInProduction: false })
  );
  const stripe = getStripeClient();

  const subs = await stripe.subscriptions.list({ customer: cus, status: "all", limit: 10 });
  console.log(`Customer ${cus}`);
  for (const s of subs.data) {
    const itemEnd = s.items?.data?.[0]?.current_period_end;
    console.log(
      `  sub ${s.id} status=${s.status} cape=${Boolean(s.cancel_at_period_end)} itemPeriodEnd=${
        itemEnd ? new Date(itemEnd * 1000).toISOString() : "none"
      }`
    );
  }

  const invoices = await listPaidInvoicesForCustomer(
    { invoices: stripe.invoices as never },
    cus
  );
  console.log(`\n${invoices.length} paid invoice(s):`);
  for (const inv of invoices.slice(0, 8)) {
    const lines = await listAllInvoiceLines({ invoices: stripe.invoices as never }, inv.id);
    const prices = lines.map((l) => getLinePriceId(l)).filter(Boolean);
    const periodEnd = getMembershipPeriodEnd(lines, allow);
    console.log(
      `  ${inv.id} amountPaid=${inv.amount_paid} prices=[${prices.join(", ")}] ` +
        `qualifies=${prices.some((p) => allow.has(p!))} periodEnd=${
          periodEnd ? new Date(periodEnd * 1000).toISOString() : "NONE"
        }`
    );
  }

  const all = await stripe.invoices.list({ customer: cus, limit: 8 });
  console.log(`\n${all.data.length} recent invoice(s) (any status):`);
  for (const inv of all.data) {
    console.log(
      `  ${inv.id} status=${inv.status} total=${inv.amount_due} created=${new Date(inv.created * 1000).toISOString().slice(0, 10)}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
