import { NextRequest, NextResponse } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";
import {
  getStripeClient,
  getStripeNativeMembershipPriceIds,
} from "@/lib/integrations/stripe";
import { resolveNativeMembershipAllowlist } from "@/lib/billing/service-access-sync";
import {
  computeFutureAccessParity,
  repairParityHoles,
} from "@/lib/billing/future-access-parity";
import { recordIntegrationError } from "@/lib/forms/webhooks/store";
import { rejectUnauthorizedCron } from "@/lib/ops/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Daily future-access parity safety net.
 *
 * Detects drift between Airtable future "Service access until" rows and
 * Stripe active+trialing listed-price subscriptions:
 *   - holes (paying member without future access) → auto-fixed with the
 *     monotonic repair (never shortens; extends access only).
 *   - extras (future access without a listed-price active sub) → alert only,
 *     recorded via recordIntegrationError for the ops dashboard.
 *
 * Env gates:
 *   PARITY_CRON_ENABLED=true        enables the route (fail-closed otherwise)
 *   PARITY_CRON_AUTO_FIX_HOLES      default "true"; "false" makes it alert-only
 *   PARITY_CRON_MAX_HOLES           max holes auto-fixed per run (default 100)
 */
export async function POST(request: NextRequest) {
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;

  if (
    process.env.PARITY_CRON_ENABLED !== "true" &&
    process.env.PARITY_CRON_ENABLED !== "1"
  ) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "PARITY_CRON_ENABLED is not true",
    });
  }

  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
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
    console.error(JSON.stringify({ event: "future_access_parity_config_error", error: msg }));
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }

  const stripe = getStripeClient();
  const airtable = createAirtableClient({ apiKey: token, baseId });

  try {
    const parity = await computeFutureAccessParity({
      stripe,
      airtable,
      membershipPriceIds: allow,
    });

    const autoFixHoles = (process.env.PARITY_CRON_AUTO_FIX_HOLES || "true") !== "false";
    const maxHoles = Math.min(
      Math.max(parseInt(process.env.PARITY_CRON_MAX_HOLES || "100", 10) || 100, 1),
      1000
    );

    let holeFix: { fixed: number; failed: Array<{ email: string; reason: string }> } | null =
      null;
    if (autoFixHoles && parity.holes.length > 0) {
      holeFix = await repairParityHoles({ airtable, holes: parity.holes, maxHoles });
    }

    const holesRemaining = parity.holes.length - (holeFix?.fixed ?? 0);
    if (parity.extras.length > 0 || (holeFix?.failed.length ?? 0) > 0 || holesRemaining > 0) {
      await recordIntegrationError({
        code: "STRIPE_RECONCILIATION_PENDING",
        source: "cron",
        operation: "future-access-parity",
        title: "Future-access parity drift",
        message: `extras=${parity.extras.length}, holes=${parity.holes.length}, holes_fixed=${holeFix?.fixed ?? 0}, holes_failed=${holeFix?.failed.length ?? 0}, holes_remaining=${holesRemaining}, delta=${parity.delta}`,
        severity: "warning",
        retryable: true,
        details: {
          extras: parity.extras.slice(0, 20).map((e) => ({
            recordId: e.airtableRecordId,
            email: e.email,
            cus: e.stripeCustomerId,
            accessUntil: e.accessUntil,
            reason: e.reason,
          })),
          holesFailed: (holeFix?.failed ?? []).slice(0, 20),
          holesRemaining: holesRemaining,
          duplicates: parity.duplicates,
        },
      }).catch(() => undefined);
    }

    console.log(
      JSON.stringify({
        event: "future_access_parity_cron",
        airtableFutureAccess: parity.airtableFutureAccess,
        stripeQualifying: parity.stripeQualifying,
        delta: parity.delta,
        extras: parity.extras.length,
        holes: parity.holes.length,
        holesFixed: holeFix?.fixed ?? 0,
        holesFailed: holeFix?.failed.length ?? 0,
        holesRemaining,
        autoFixHoles,
      })
    );

    return NextResponse.json({
      success: true,
      summary: {
        airtableFutureAccess: parity.airtableFutureAccess,
        stripeQualifying: parity.stripeQualifying,
        delta: parity.delta,
        extras: parity.extras.length,
        extrasSample: parity.extras.slice(0, 10).map((e) => ({
          recordId: e.airtableRecordId,
          email: e.email,
          reason: e.reason,
        })),
        holes: parity.holes.length,
        holesFixed: holeFix?.fixed ?? 0,
        holesFailed: holeFix?.failed ?? [],
        holesRemaining,
        duplicates: parity.duplicates,
        autoFixHoles,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "future_access_parity_cron_failed", error: msg }));
    return NextResponse.json(
      { success: false, error: "Parity cron failed" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
