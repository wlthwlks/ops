import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  cityIntroductionSettings,
  introductionGroups,
  type CityIntroductionSettings,
} from "@/db/schema";
import { cityScheduleSchema, type CitySchedule } from "./settings";
import { syncCitiesFromAirtable } from "./city-sync";
import { runIntroductionPreview, type IntroductionPlanDeps } from "./plan";
import { freezeIntroductionRun, type DeliveryMode } from "./freeze";

/**
 * City-level monthly scheduler for the unified introduction engine.
 *
 * Scheduled cities become due when their next_run_at is in the past (or
 * unset). The scheduler builds a preview plan for every due city and, when
 * auto-approve is enabled, freezes it with the city's configured
 * auto-approve delivery mode. Production auto-approval requires live mode —
 * in read-only mode the preview is still built but never frozen as
 * production.
 */

export function computeNextRunAt(schedule: CitySchedule, after: Date): Date {
  const zone = schedule.timezone || "UTC";
  const [hour, minute] = schedule.localTime.split(":").map((part) => Number.parseInt(part, 10));
  let candidate = DateTime.fromJSDate(after, { zone }).set({
    day: Math.min(schedule.dayOfMonth, 28),
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
  if (candidate.toMillis() <= after.getTime()) {
    candidate = candidate.plus({ months: 1 }).set({
      day: Math.min(schedule.dayOfMonth, 28),
      hour,
      minute,
      second: 0,
      millisecond: 0,
    });
  }
  return candidate.toJSDate();
}

export function parseCitySchedule(settings: CityIntroductionSettings): CitySchedule | null {
  if (!settings.scheduleJson) return null;
  try {
    return cityScheduleSchema.parse(JSON.parse(settings.scheduleJson));
  } catch {
    return null;
  }
}

export function isCityDue(settings: CityIntroductionSettings, now: Date): boolean {
  if (!settings.enabled) return false;
  if (settings.schedulingMode !== "scheduled") return false;
  if (settings.nextRunAt == null) return true;
  return new Date(settings.nextRunAt).getTime() <= now.getTime();
}

export async function listDueCities(
  db: AppDb,
  now: Date
): Promise<CityIntroductionSettings[]> {
  const rows = await db.select().from(cityIntroductionSettings);
  return rows.filter((row) => isCityDue(row, now));
}

export async function cycleIdExists(db: AppDb, cycleId: string): Promise<boolean> {
  const rows = await db
    .select({ id: introductionGroups.id })
    .from(introductionGroups)
    .where(eq(introductionGroups.cycleId, cycleId))
    .limit(1);
  return rows.length > 0;
}

export interface SchedulerCityResult {
  cityCode: string;
  cycleDate: string;
  outcome:
    | "previewed"
    | "approved"
    | "blocked"
    | "skipped_duplicate"
    | "skipped_no_auto_approve_freeze"
    | "failed";
  runId: string | null;
  error: string | null;
  nextRunAt: string | null;
}

export interface SchedulerRunResult {
  processed: boolean;
  live: boolean;
  dueCities: number;
  results: SchedulerCityResult[];
}

export interface CitySchedulerDeps extends IntroductionPlanDeps {
  now?: Date;
  live?: boolean;
}

export async function runCityIntroductionScheduler(
  deps: CitySchedulerDeps
): Promise<SchedulerRunResult> {
  const now = deps.now ?? new Date();
  const live = deps.live ?? false;

  // Light city sync before checking due cities (best-effort).
  try {
    await syncCitiesFromAirtable(deps.db, deps.airtable, deps.log);
  } catch (err) {
    deps.log(
      `City sync failed before scheduler tick: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const due = await listDueCities(deps.db, now);
  const results: SchedulerCityResult[] = [];

  for (const city of due) {
    const cycleDate = now.toISOString().slice(0, 10);
    const cycleId = `intro-${city.cityCode}-${cycleDate}`;

    try {
      if (await cycleIdExists(deps.db, cycleId)) {
        deps.log(`City ${city.cityCode}: cycle ${cycleId} already planned — skipping`);
        results.push({
          cityCode: city.cityCode,
          cycleDate,
          outcome: "skipped_duplicate",
          runId: null,
          error: null,
          nextRunAt: null,
        });
        continue;
      }

      const autoMode = (city.autoApproveDeliveryMode ?? "simulation") as DeliveryMode;
      const effectiveMode =
        autoMode === "production" && !live ? "simulation" : autoMode;

      deps.log(`City ${city.cityCode}: building preview for ${cycleDate}...`);
      const preview = await runIntroductionPreview(deps, {
        cityCode: city.cityCode,
        cycleDate,
        deliveryMode: effectiveMode,
      });
      if (!preview.success || !preview.runId) {
        results.push({
          cityCode: city.cityCode,
          cycleDate,
          outcome: "failed",
          runId: null,
          error: preview.error ?? "Preview failed",
          nextRunAt: null,
        });
        continue;
      }

      let outcome: SchedulerCityResult["outcome"] = "previewed";
      let error: string | null = null;

      if (preview.report.blockedReason) {
        // Below the minimum-eligible-member gate: log clearly, skip the
        // month (next_run_at advances below), and never freeze.
        outcome = "blocked";
        deps.log(
          `City ${city.cityCode}: blocked — ${preview.report.eligibleMembers} eligible member(s), minimum ${preview.report.minEligibleMembers} required`
        );
      } else if (city.autoApprove) {
        if (autoMode === "production" && !live) {
          deps.log(
            `City ${city.cityCode}: auto-approve wants production but mode is read-only — preview only`
          );
          outcome = "skipped_no_auto_approve_freeze";
        } else {
          const frozen = await freezeIntroductionRun(deps.db, {
            runId: preview.runId,
            deliveryMode: autoMode,
            approvedBy: "scheduler",
          });
          if (frozen.success) {
            outcome = "approved";
            deps.log(`City ${city.cityCode}: plan frozen (${autoMode}, ${frozen.deliveryCount} deliveries)`);
          } else {
            outcome = "failed";
            error = frozen.validationFailures.join("; ") || "Freeze failed";
          }
        }
      }

      // Advance the schedule on success only — failures are retried hourly
      // until an operator fixes the configuration.
      let nextRunAt: string | null = null;
      if (outcome !== "failed") {
        const schedule = parseCitySchedule(city);
        if (schedule) {
          nextRunAt = computeNextRunAt(schedule, new Date(now.getTime() + 60 * 60 * 1000)).toISOString();
          await deps.db
            .update(cityIntroductionSettings)
            .set({ nextRunAt: new Date(nextRunAt), updatedAt: now })
            .where(eq(cityIntroductionSettings.cityCode, city.cityCode));
        }
      }

      results.push({ cityCode: city.cityCode, cycleDate, outcome, runId: preview.runId, error, nextRunAt });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`City ${city.cityCode}: scheduler failure — ${message}`);
      results.push({
        cityCode: city.cityCode,
        cycleDate,
        outcome: "failed",
        runId: null,
        error: message,
        nextRunAt: null,
      });
    }
  }

  return { processed: true, live, dueCities: due.length, results };
}
