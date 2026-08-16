import { NextRequest } from "next/server";
import { db } from "@/db";
import { z } from "zod";
import { requireOpsAdmin, requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk, jsonError } from "@/lib/ops/api-response";
import { freezeIntroductionRun, type DeliveryMode } from "@/lib/introduction/freeze";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";

const inputSchema = z.object({
  deliveryMode: z.enum(["simulation", "provider_test", "canary", "production"]).optional(),
  confirmation: z.string().optional(),
});

/**
 * Approve/freeze a previewed plan. Freezing never sends email — it creates
 * persistent delivery jobs for the queue worker. Production delivery mode
 * requires live mode plus a typed confirmation.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;

  const body = await request.json().catch(() => null);
  const input = inputSchema.safeParse(body ?? {});
  if (!input.success) {
    return introductionErrorResponse(input.error) ?? jsonError("INVALID_PAYLOAD", "Invalid payload", 400);
  }

  const requestedMode = input.data.deliveryMode ?? null;

  try {
    let operator: { userId: string };
    if (requestedMode === "production") {
      operator = await requireLiveAdmin("introductions/approve");
      if (input.data.confirmation !== "SEND") {
        return jsonError(
          "CONFIRMATION_REQUIRED",
          'Production delivery requires the typed confirmation "SEND"',
          400
        );
      }
    } else {
      operator = await requireOpsAdmin();
    }

    const result = await freezeIntroductionRun(db, {
      runId,
      approvedBy: operator.userId,
      deliveryMode: (requestedMode ?? undefined) as DeliveryMode | undefined,
    });

    return jsonOk({ ...result }, result.success ? 200 : 422);
  } catch (err) {
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
