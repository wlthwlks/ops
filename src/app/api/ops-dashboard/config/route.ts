import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import {
  getAllMembersChannelConfig,
  getSlackInviteUrl,
} from "@/lib/ops/member-health";
import { getOutreachCooldownDays } from "@/lib/ops/slack-outreach";

export const runtime = "nodejs";

export async function GET() {
  try {
    const ctx = await requireOpsViewer();
    const allMembers = getAllMembersChannelConfig();
    return jsonOk({
      mode: ctx.mode,
      role: ctx.role,
      userId: ctx.userId,
      manualActionsEnabled: ctx.mode === "live" && ctx.role === "admin",
      config: {
        slackInviteConfigured: Boolean(getSlackInviteUrl()),
        allMembersChannelConfigured: Boolean(allMembers.id),
        allMembersChannelName: allMembers.name,
        resendConfigured: Boolean(
          process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL
        ),
        stripeConfigured: Boolean(
          process.env.STRIPE_SECRET_KEY && process.env.STRIPE_MEMBERSHIP_PRICE_IDS
        ),
        outreachCooldownDays: getOutreachCooldownDays(),
        /** Dashboard never creates Airtable members from Stripe. */
        canCreateAirtableFromStripe: false,
      },
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
