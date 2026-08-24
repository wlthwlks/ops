import { NextRequest, connection } from "next/server";
import { db } from "@/db";
import { rejectUnauthorizedCron } from "@/lib/ops/cron-auth";
import { getIntroductionsMode, IntroductionsConfigError } from "@/lib/introduction/runtime-mode";
import { jsonOk } from "@/lib/ops/api-response";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createPineconeClient } from "@/lib/integrations/pinecone";
import {
  runCityIntroductionScheduler,
  type CitySchedulerDeps,
} from "@/lib/introduction/scheduler";

export const maxDuration = 300;

/**
 * City scheduler tick: builds preview plans for due scheduled cities and,
 * when auto-approve is enabled, freezes them with the configured delivery
 * mode. Production auto-approval only happens when INTRODUCTIONS_MODE is
 * live. Never sends email itself — frozen jobs are processed by the
 * delivery worker.
 */
export async function POST(request: NextRequest) {
  await connection();
  const unauthorized = rejectUnauthorizedCron(request);
  if (unauthorized) return unauthorized;

  let live: boolean;
  try {
    live = getIntroductionsMode() === "live";
  } catch (err) {
    if (err instanceof IntroductionsConfigError) {
      return jsonOk({ processed: false, skipped: true, reason: "invalid_mode", error: err.message }, 500);
    }
    throw err;
  }

  const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
  const airtableBase = process.env.AIRTABLE_BASE_ID;
  const pineconeKey = process.env.PINECONE_API_KEY;
  const pineconeIndex = process.env.PINECONE_INDEX_NAME;

  if (!airtableToken || !airtableBase || !pineconeKey || !pineconeIndex) {
    return jsonOk(
      { processed: false, skipped: true, reason: "integrations_not_configured" },
      500
    );
  }

  const logs: string[] = [];
  const deps: CitySchedulerDeps = {
    db,
    log: (message) => logs.push(message),
    airtable: createAirtableClient({ apiKey: airtableToken, baseId: airtableBase }),
    pinecone: createPineconeClient({ apiKey: pineconeKey, indexName: pineconeIndex }),
    live,
  };

  try {
    const result = await runCityIntroductionScheduler(deps);
    console.log(
      JSON.stringify({
        event: "intro_city_scheduler_tick",
        live,
        dueCities: result.dueCities,
        results: result.results.map((r) => ({
          cityCode: r.cityCode,
          outcome: r.outcome,
          runId: r.runId,
          error: r.error,
        })),
      })
    );
    return jsonOk({ ...result, logs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ event: "intro_city_scheduler_tick", skipped: true, reason: "scheduler_failed", error: message }));
    return jsonOk({ processed: false, skipped: true, reason: "scheduler_failed", error: message }, 500);
  }
}

export async function GET(request: NextRequest) {
  await connection();
  return POST(request);
}
