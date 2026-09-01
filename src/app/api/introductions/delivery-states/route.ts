import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { listDeliveryStates } from "@/lib/introduction/delivery-states";

export const dynamic = "force-dynamic";

/**
 * Provider-reported delivery states for the "Delivery States" tab of the
 * Match History page. Filters: days (0 = all), statuses (comma list),
 * city (city code) and person (recipient email search).
 */
export async function GET(request: NextRequest) {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { searchParams } = new URL(request.url);
    const daysRaw = searchParams.get("days")?.trim();
    const days =
      daysRaw != null && daysRaw !== "" && Number.isFinite(Number(daysRaw))
        ? Math.max(0, Math.min(365, Math.floor(Number(daysRaw))))
        : undefined;
    const statuses = (searchParams.get("statuses") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const cityCode = searchParams.get("city")?.trim() || undefined;
    const person = searchParams.get("person")?.trim() || undefined;

    const rows = await listDeliveryStates(db, {
      days,
      statuses,
      cityCode,
      person,
    });
    return jsonOk({ rows } as unknown as Record<string, unknown>);
  } catch (err) {
    return handleOpsApiError(err);
  }
}
