import { NextRequest, NextResponse, connection } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createKlaviyoClient } from "@/lib/integrations/klaviyo";
import {
  getStripeClient,
  getStripeNativeMembershipPriceIds,
} from "@/lib/integrations/stripe";
import { resolveNativeMembershipAllowlist } from "@/lib/billing/service-access-sync";
import {
  runKlaviyoMembershipSync,
  type KlaviyoMembershipSyncResult,
} from "@/lib/billing/klaviyo-membership-sync";
import { recordIntegrationError } from "@/lib/forms/webhooks/store";
import { rejectUnauthorizedCron } from "@/lib/ops/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Dedicated Klaviyo membership-list sync cron.
 *
 * Runs the Klaviyo reconcile (Stripe census → Airtable enrichment → Klaviyo
 * bulk upsert + list add/remove) in its own function so it no longer shares
 * the future-access-parity cron's 300s budget. Stripe is the source of truth;
 * Airtable is only read for enrichment (name/phone/city/plan/suppression).
 *
 * Env gates:
 *   KLAVIYO_SYNC_ENABLED          "true" enables the reconcile (fail-closed)
 *   KLAVIYO_PRIVATE_API_KEY       private API key (pk_…)
 *   KLAVIYO_ACTIVE_LIST_ID        id for "WLTH WLKS - Active Members"
 *   KLAVIYO_CHURNED_LIST_ID       id for "WLTH WLKS - Churned Members"
 */
export async function POST(request: NextRequest) {
  await connection();
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;

  const klaviyoEnabled =
    process.env.KLAVIYO_SYNC_ENABLED === "true" ||
    process.env.KLAVIYO_SYNC_ENABLED === "1";
  if (!klaviyoEnabled) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "KLAVIYO_SYNC_ENABLED is not true",
    });
  }

  const apiKey = (process.env.KLAVIYO_PRIVATE_API_KEY || "").trim();
  const activeListId = (process.env.KLAVIYO_ACTIVE_LIST_ID || "").trim();
  const churnedListId = (process.env.KLAVIYO_CHURNED_LIST_ID || "").trim();
  if (!apiKey || !activeListId || !churnedListId) {
    const msg =
      "Klaviyo config missing (KLAVIYO_PRIVATE_API_KEY / KLAVIYO_ACTIVE_LIST_ID / KLAVIYO_CHURNED_LIST_ID)";
    await recordIntegrationError({
      code: "KLAVIYO_SYNC_FAILED",
      source: "cron",
      operation: "klaviyo-membership-sync",
      title: "Klaviyo membership-list sync config missing",
      message: msg,
      severity: "error",
      retryable: false,
    }).catch(() => undefined);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }

  const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
  const airtableBase = process.env.AIRTABLE_BASE_ID;
  if (!airtableToken || !airtableBase) {
    return NextResponse.json({ success: false, error: "Airtable not configured" }, { status: 500 });
  }

  let allow: Set<string>;
  try {
    allow = resolveNativeMembershipAllowlist(
      getStripeNativeMembershipPriceIds({
        requireConfigured: true,
        failClosedInProduction: false,
      })
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ event: "klaviyo_membership_sync_config_error", error: msg }));
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }

  try {
    const result: KlaviyoMembershipSyncResult = await runKlaviyoMembershipSync({
      stripe: getStripeClient(),
      airtable: createAirtableClient({ apiKey: airtableToken, baseId: airtableBase }),
      klaviyo: createKlaviyoClient({
        apiKey,
        revision: (process.env.KLAVIYO_API_REVISION || "").trim() || undefined,
      }),
      membershipPriceIds: allow,
      activeListId,
      churnedListId,
    });
    console.log(JSON.stringify({ event: "klaviyo_membership_sync", ...result }));
    return NextResponse.json({ success: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "klaviyo_membership_sync_failed", error: msg }));
    await recordIntegrationError({
      code: "KLAVIYO_SYNC_FAILED",
      source: "cron",
      operation: "klaviyo-membership-sync",
      title: "Klaviyo membership-list sync failed",
      message: msg.slice(0, 2000),
      severity: "error",
      retryable: true,
    }).catch(() => undefined);
    return NextResponse.json(
      { success: false, error: msg.slice(0, 200) },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  await connection();
  return POST(request);
}
