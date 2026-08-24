import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { searchIntroductionHistory } from "@/lib/introduction/history-lookup";

export const dynamic = "force-dynamic";

/**
 * Customer-service match history search. Filter by person (email, name or
 * Airtable record id) and/or city. Covers the unified introduction ledger
 * and legacy "Get Matched" events.
 */
export async function GET(request: NextRequest) {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { searchParams } = new URL(request.url);
    const person = searchParams.get("person")?.trim() || undefined;
    const city = searchParams.get("city")?.trim() || undefined;
    const result = await searchIntroductionHistory(db, { person, city });
    return jsonOk(result as unknown as Record<string, unknown>);
  } catch (err) {
    return handleOpsApiError(err);
  }
}
