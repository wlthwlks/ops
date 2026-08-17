import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireOpsAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { syncCitiesFromAirtable } from "@/lib/introduction/city-sync";
import { createAirtableClient } from "@/lib/integrations/airtable";

export const dynamic = "force-dynamic";

/** Full synchronization of the city settings table with Airtable ALL CITIES. */
export async function POST(request: NextRequest) {
  void request;
  try {
    await requireOpsAdmin();
  } catch (err) {
    return handleOpsApiError(err);
  }

  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    return handleOpsApiError(new Error("Missing Airtable credentials"));
  }

  try {
    const logs: string[] = [];
    const result = await syncCitiesFromAirtable(
      db,
      createAirtableClient({ apiKey: token, baseId }),
      (message) => logs.push(message)
    );
    return jsonOk({ ...result, logs });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
