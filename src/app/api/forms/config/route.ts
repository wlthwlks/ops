import { NextResponse } from "next/server";
import { getFormFeatureFlags } from "@/lib/forms/feature-flags";
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
      membershipPriceId: process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID || "",
      homeUrl: process.env.WLTH_HOME_URL || "https://wlthwlks.com",
      applyPath: process.env.WLTH_APPLY_PATH || "/apply",
      flags: {
        signupEnabled: flags.newSignupWidgetEnabled,
        updateDetailsEnabled: flags.newUpdateDetailsWidgetEnabled,
        analyticsEnabled: flags.newFormAnalyticsEnabled,
      },
    }),
    request
  );
}
