import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk, jsonError } from "@/lib/ops/api-response";
import { buildSimulationReport } from "@/lib/introduction/simulation";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { runId } = await params;
    const report = await buildSimulationReport(db, runId);
    if (!report) {
      return jsonError("PLAN_RUN_NOT_FOUND", `Run ${runId} not found`, 404);
    }
    return jsonOk({ report });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
