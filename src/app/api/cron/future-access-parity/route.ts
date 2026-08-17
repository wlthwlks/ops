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
  repairParityExtras,
  type ParityExtrasRepairResult,
} from "@/lib/billing/future-access-parity";
import { recordIntegrationError } from "@/lib/forms/webhooks/store";
import { rejectUnauthorizedCron } from "@/lib/ops/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Daily future-access parity safety net.
 *
 * Detects drift between Airtable future "Service access until" rows and
 * Stripe active+trialing listed-price subscriptions, then repairs BOTH
 * directions so the two stay aligned:
 *   - holes (paying member without future access) → auto-fixed with the
 *     monotonic repair (never shortens; extends access only).
 *   - extras (future access without a listed-price active sub) → auto-fixed
 *     with the corrective repair: Stripe paid-through is written when known,
 *     unsupported future access is cleared, blank customer ids are linked via
 *     unique email, and duplicate rows are collapsed to one keeper.
 *
 * Env gates:
 *   PARITY_CRON_ENABLED=true        enables the route (fail-closed otherwise)
 *   PARITY_CRON_AUTO_FIX_HOLES      default "true"; "false" makes it alert-only
 *   PARITY_CRON_MAX_HOLES           max holes auto-fixed per run (default 100)
 *   PARITY_CRON_AUTO_FIX_EXTRAS     default "true"; "false" makes extras alert-only
 *   PARITY_CRON_MAX_EXTRAS          max extras auto-fixed per run (default 50)
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

    const autoFixExtras = (process.env.PARITY_CRON_AUTO_FIX_EXTRAS || "true") !== "false";
    const maxExtras = Math.min(
      Math.max(parseInt(process.env.PARITY_CRON_MAX_EXTRAS || "50", 10) || 50, 1),
      1000
    );

    let extrasFix: ParityExtrasRepairResult | null = null;
    if (autoFixExtras && parity.extras.length > 0) {
      extrasFix = await repairParityExtras({
        stripe,
        airtable,
        extras: parity.extras,
        qualifyingMemberships: parity.qualifyingMemberships,
        membershipPriceIds: allow,
        maxExtras,
      });
    }

    const holesRemaining = parity.holes.length - (holeFix?.fixed ?? 0);
    const extrasRemaining = parity.extras.length - (extrasFix?.fixed ?? 0);
    const remainingDrift =
      parity.extras.length > 0 ||
      (holeFix?.failed.length ?? 0) > 0 ||
      (extrasFix?.failed.length ?? 0) > 0 ||
      holesRemaining > 0 ||
      extrasRemaining > 0;
    if (remainingDrift) {
      await recordIntegrationError({
        code: "STRIPE_RECONCILIATION_PENDING",
        source: "cron",
        operation: "future-access-parity",
        title: "Future-access parity drift",
        message: `extras=${parity.extras.length}, extras_fixed=${extrasFix?.fixed ?? 0}, extras_corrected=${extrasFix?.corrected ?? 0}, extras_cleared=${extrasFix?.cleared ?? 0}, extras_linked=${extrasFix?.linked ?? 0}, extras_failed=${extrasFix?.failed.length ?? 0}, extras_remaining=${extrasRemaining}, holes=${parity.holes.length}, holes_fixed=${holeFix?.fixed ?? 0}, holes_failed=${holeFix?.failed.length ?? 0}, holes_remaining=${holesRemaining}, delta=${parity.delta}`,
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
          extrasFixes: (extrasFix?.details ?? []).slice(0, 20),
          extrasFailed: (extrasFix?.failed ?? []).slice(0, 20),
          holesFailed: (holeFix?.failed ?? []).slice(0, 20),
          holesRemaining: holesRemaining,
          extrasRemaining: extrasRemaining,
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
        extrasFixed: extrasFix?.fixed ?? 0,
        extrasCorrected: extrasFix?.corrected ?? 0,
        extrasCleared: extrasFix?.cleared ?? 0,
        extrasLinked: extrasFix?.linked ?? 0,
        extrasFailed: extrasFix?.failed.length ?? 0,
        extrasRemaining,
        holes: parity.holes.length,
        holesFixed: holeFix?.fixed ?? 0,
        holesFailed: holeFix?.failed.length ?? 0,
        holesRemaining,
        autoFixHoles,
        autoFixExtras,
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
        extrasFixed: extrasFix?.fixed ?? 0,
        extrasCorrected: extrasFix?.corrected ?? 0,
        extrasCleared: extrasFix?.cleared ?? 0,
        extrasLinked: extrasFix?.linked ?? 0,
        extrasFailed: extrasFix?.failed ?? [],
        extrasRemaining,
        holes: parity.holes.length,
        holesFixed: holeFix?.fixed ?? 0,
        holesFailed: holeFix?.failed ?? [],
        holesRemaining,
        duplicates: parity.duplicates,
        autoFixHoles,
        autoFixExtras,
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
