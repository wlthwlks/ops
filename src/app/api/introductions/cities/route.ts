import { db } from "@/db";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { listCitySettings } from "@/lib/introduction/settings";
import { syncCitiesIfStale } from "@/lib/introduction/city-sync";
import { createAirtableClient } from "@/lib/integrations/airtable";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    // Read-through sync: keep the city list fresh with Airtable (5-min TTL).
    const token = process.env.AIRTABLE_GET_DATA_TOKEN;
    const baseId = process.env.AIRTABLE_BASE_ID;
    if (token && baseId) {
      try {
        await syncCitiesIfStale(db, createAirtableClient({ apiKey: token, baseId }));
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "city_sync_read_through_failed",
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    }

    const cities = await listCitySettings(db);
    return jsonOk({ cities });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
