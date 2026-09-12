import { NextResponse } from "next/server";
import { getFormFeatureFlags } from "@/lib/forms/feature-flags";
import { getDefaultSignupPrice } from "@/lib/billing/catalog";
import { optionsCors, withCors } from "@/lib/forms/cors";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function GET(request: Request) {
  const flags = getFormFeatureFlags();
  return withCors(
    NextResponse.json({
      success: true,
      memberstackPublicKey: process.env.NEXT_PUBLIC_MEMBERSTACK_PUBLIC_KEY || "",
      membershipPriceId:
        (getDefaultSignupPrice()?.memberstackPriceId || "").trim() ||
        process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID ||
        "",
      homeUrl: process.env.WLTH_HOME_URL || "https://wlthwlks.com",
      applyPath: process.env.WLTH_APPLY_PATH || "/apply",
      flags: {
        signupEnabled: flags.newSignupWidgetEnabled,
        updateDetailsEnabled: flags.newUpdateDetailsWidgetEnabled,
        analyticsEnabled: flags.newFormAnalyticsEnabled,
      },
      sweatpals: {
        enabled: flags.sweatpalsPaymentStepEnabled,
        communityUsername: process.env.SWEATPALS_COMMUNITY_USERNAME || "",
        membershipTiersJson: process.env.SWEATPALS_MEMBERSHIP_TIERS_JSON || "[]",
        scriptUrl:
          process.env.SWEATPALS_MEMBERSHIP_SCRIPT_URL ||
          `${(
            process.env.SWEATPALS_APP_ORIGIN || "https://app.sweatpals.com"
          ).replace(/\/+$/, "")}/static/embed/community/membership/list-v2/script.js`,
        purchaseEventNames: (process.env.SWEATPALS_PURCHASE_EVENT_NAMES || "purchase,event_purchase")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      },
    }),
    request
  );
}
