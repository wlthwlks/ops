import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { scanMemberHealth } from "@/lib/ops/member-health";
import { createSlackClient } from "@/lib/integrations/slack";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    await requireOpsViewer();
    let body: { includeChannels?: boolean } = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const includeChannels = body.includeChannels === true;
    const slackToken = process.env.SLACK_BOT_TOKEN;
    const slack =
      includeChannels && slackToken
        ? createSlackClient({ botToken: slackToken })
        : undefined;

    const scan = await scanMemberHealth({
      includeSlack: true,
      includeChannelMembership: includeChannels,
      slack,
    });

    return jsonOk({
      summary: scan.summary,
      memberCount: scan.members.length,
      orphanCount: scan.orphanStripeCustomers.length,
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
