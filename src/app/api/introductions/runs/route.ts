import { db } from "@/db";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { listIntroductionRuns } from "@/lib/introduction/plan";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const runs = await listIntroductionRuns(db);
    return jsonOk({ runs });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
