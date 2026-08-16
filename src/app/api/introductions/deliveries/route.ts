import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { listRunDeliveries, listRunDeliveryEvents } from "@/lib/introduction/simulation";
import { z } from "zod";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  runId: z.string().min(1),
});

export async function GET(request: NextRequest) {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    const input = querySchema.parse(params);
    const [deliveries, events] = await Promise.all([
      listRunDeliveries(db, input.runId),
      listRunDeliveryEvents(db, input.runId),
    ]);
    return jsonOk({ deliveries, events });
  } catch (err) {
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
