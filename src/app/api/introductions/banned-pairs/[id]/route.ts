import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { removeBannedPair } from "@/lib/introduction/banned-pairs";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireLiveAdmin("introductions/banned-pairs");
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { id } = await params;
    const removed = await removeBannedPair(db, id);
    if (!removed) {
      return jsonOk({ removed: false }, 404);
    }
    return jsonOk({ removed: true });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
