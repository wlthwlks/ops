import { NextResponse } from "next/server";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError } from "@/lib/ops/api-response";

export const runtime = "nodejs";

/**
 * Deprecated: use /api/ops-dashboard/slack/removal-queue.
 * Kept temporarily for compatibility — returns redirect guidance.
 */
export async function GET() {
  try {
    await requireOpsViewer();
    return NextResponse.json(
      {
        success: false,
        code: "DEPRECATED",
        message:
          "This endpoint is deprecated. Use GET /api/ops-dashboard/slack/removal-queue and the Slack Access removal tab.",
        redirect: "/members/slack-access?tab=removal",
        retryable: false,
      },
      { status: 410 }
    );
  } catch (err) {
    return handleOpsApiError(err);
  }
}
