/**
 * One-off read-only check that the classifier fix works against live data:
 * a canceled Stripe subscription + lapsed paid-through must classify as
 * "expired" even when Airtable Payment is stale "Failed".
 * Usage: npx tsx scripts/verify-classifier-fix.ts
 */
import * as dotenv from "dotenv";
import { classifyMembershipUiState } from "../src/lib/forms/billing/membership-state";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

const now = new Date();

// Live snapshot for scottsdalelender@gmail.com verified 2026-09-18:
// sub_1S7RI8Bwwz36JKiyyHUfvJx8 canceled, paid-through ended 2026-09-15.
console.log(
  "canceled sub + lapsed access + Payment=Failed →",
  classifyMembershipUiState({
    stripeSubscriptionStatus: "canceled",
    membership: "Cancelled",
    payment: "Failed",
    serviceAccessUntil: "2026-06-15T01:33:16.000Z",
    cancelAtPeriodEnd: false,
    now,
  })
);
console.log(
  "canceled sub + lapsed access + Payment=Paid →",
  classifyMembershipUiState({
    stripeSubscriptionStatus: "canceled",
    membership: "Cancelled",
    payment: "Paid",
    serviceAccessUntil: "2026-06-15T01:33:16.000Z",
    cancelAtPeriodEnd: false,
    now,
  })
);
