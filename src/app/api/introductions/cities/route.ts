import { db } from "@/db";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { listCitySettings } from "@/lib/introduction/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const cities = await listCitySettings(db);
    return jsonOk({ cities });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
