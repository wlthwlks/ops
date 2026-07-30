import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import { resolveMemberForOutreach } from "@/lib/ops/resolve-member-for-outreach";
import { buildSlackJoinEmailPreview } from "@/lib/ops/slack-outreach";
import { getIntroductionsMode } from "@/lib/introduction/runtime-mode";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    await requireOpsViewer();
    const body = await request.json();
    const airtableRecordId = String(body.airtableRecordId || "");
    if (!airtableRecordId) {
      return jsonError("BAD_REQUEST", "airtableRecordId required", 400);
    }

    const resolved = await resolveMemberForOutreach(airtableRecordId, {
      checkCooldown: true,
    });
    const preview = buildSlackJoinEmailPreview(resolved.member);

    let mode = "read_only";
    try {
      mode = getIntroductionsMode();
    } catch {
      /* keep default */
    }

    return jsonOk({
      preview,
      mode,
      cooldownActive: resolved.cooldownActive,
      cooldownLastSentAt: resolved.cooldownLastSentAt,
      timings: resolved.timings,
      scanVersion: resolved.scanVersion,
      member: {
        airtableRecordId: resolved.member.airtableRecordId,
        name: resolved.member.name,
        primaryEmail: resolved.member.primaryEmail,
        city: resolved.member.city,
        slackIdentityState: resolved.member.slackIdentityState,
      },
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
