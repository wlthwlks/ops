import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import {
  resendGroupMemberEmail,
  ResendMemberError,
} from "@/lib/introduction/resend-member";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Resend one member's introduction email on demand (customer service:
 * "can you send me that email again?"). Reuses the group's frozen email,
 * refreshes the member's address from Airtable by record id and sends
 * immediately. Requires admin + live mode because this sends real email.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ groupId: string; memberKey: string }> }
) {
  try {
    await requireLiveAdmin("introductions/member-resend");
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { groupId, memberKey } = await params;
    const result = await resendGroupMemberEmail(db, groupId, decodeURIComponent(memberKey));
    return jsonOk(result as unknown as Record<string, unknown>);
  } catch (err) {
    if (err instanceof ResendMemberError) {
      const status =
        err.code === "GROUP_NOT_FOUND" || err.code === "MEMBER_NOT_FOUND" ? 404 : 409;
      return jsonError(err.code, err.message, status);
    }
    return handleOpsApiError(err);
  }
}
