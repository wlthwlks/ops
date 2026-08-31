import { connection } from "next/server";
import { db } from "@/db";
import { requireOpsAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { getIntroductionsMode, IntroductionsConfigError } from "@/lib/introduction/runtime-mode";
import {
  buildCitySchedulerDeps,
  runCityIntroductionScheduler,
} from "@/lib/introduction/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Admin-triggered city scheduler tick (same code path as the hourly cron).
 * Processes due scheduled cities: builds previews and auto-freezes them
 * per city settings. Never sends email itself — frozen jobs are handled by
 * the delivery worker. Useful for testing scheduling without waiting for
 * the cron.
 */
export async function POST() {
  await connection();
  try {
    await requireOpsAdmin();
  } catch (err) {
    return handleOpsApiError(err);
  }

  let live: boolean;
  try {
    live = getIntroductionsMode() === "live";
  } catch (err) {
    if (err instanceof IntroductionsConfigError) {
      return jsonOk({ processed: false, skipped: true, reason: "invalid_mode", error: err.message }, 500);
    }
    throw err;
  }

  const logs: string[] = [];
  const built = buildCitySchedulerDeps({
    db,
    live,
    log: (message) => logs.push(message),
  });
  if (built.error) {
    return jsonOk(
      { processed: false, skipped: true, reason: built.error },
      500
    );
  }
  const deps = built.deps;

  try {
    const result = await runCityIntroductionScheduler(deps);
    console.log(
      JSON.stringify({
        event: "intro_city_scheduler_manual_tick",
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
    console.log(JSON.stringify({ event: "intro_city_scheduler_manual_tick", skipped: true, reason: "scheduler_failed", error: message }));
    return jsonOk({ processed: false, skipped: true, reason: "scheduler_failed", error: message }, 500);
  }
}
