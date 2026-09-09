/**
 * Rewrite every city's introduction schedule so it runs at a local wall-clock
 * time in the city's own timezone (day of month 1, default 10:00 local).
 *
 * Rewrites schedule_json for every city row and recomputes next_run_at for
 * enabled scheduled cities with the scheduler's own computeNextRunAt — so the
 * next monthly run already fires at the new local time.
 *
 * Usage:
 *   npx tsx scripts/set-city-run-time.ts --env-file=.env          (prod, dry-run)
 *   npx tsx scripts/set-city-run-time.ts --env-file=.env --apply
 *   npx tsx scripts/set-city-run-time.ts --env-file=.env.local --apply
 *   npx tsx scripts/set-city-run-time.ts --env-file=.env --apply --local-time=10:00 --day=1
 */
import * as dotenv from "dotenv";
import { db } from "../src/db";
import { eq } from "drizzle-orm";
import { cityIntroductionSettings, type CityIntroductionSettings } from "../src/db/schema";
import { CITY_TIMEZONES } from "../src/lib/ops/city-timezones";
import { computeNextRunAt, parseCitySchedule } from "../src/lib/introduction/scheduler";

const args = process.argv.slice(2);

const envFileArg = args.find((a) => a.startsWith("--env-file="));
const envFilePath = envFileArg ? envFileArg.split("=")[1] : ".env";
const runArgs = args.filter((a) => a !== envFileArg);

const localTimeArg = runArgs.find((a) => a.startsWith("--local-time="));
const localTime = localTimeArg
  ? localTimeArg.split("=")[1]
  : "10:00";
const dayArg = runArgs.find((a) => a.startsWith("--day="));
const dayOfMonth = dayArg ? Math.min(Math.max(Number.parseInt(dayArg.split("=")[1], 10) || 1, 1), 28) : 1;

dotenv.config({ path: envFilePath, override: false });
console.log(`Env file: ${envFilePath}`);

const apply = runArgs.includes("--apply");
if (!apply) console.log("🔍 DRY RUN — no writes will be performed\n");

interface CityScheduleShape {
  dayOfMonth: number;
  localTime: string;
  timezone: string;
}

async function main() {
  const rows = await db.select().from(cityIntroductionSettings);
  console.log(`Loaded ${rows.length} city row(s). Target: day ${dayOfMonth} at ${localTime} local time.\n`);

  const skipped: string[] = [];
  let scheduled = 0;
  let scheduleOnly = 0;
  const nextRunAtAnchor = new Date(Date.now() + 60 * 60 * 1000);

  for (const row of rows) {
    const timezone = CITY_TIMEZONES[row.cityName ?? ""];
    if (!timezone) {
      skipped.push(row.cityName ?? row.cityCode);
      continue;
    }

    const newSchedule: CityScheduleShape = { dayOfMonth, localTime, timezone };
    const newScheduleJson = JSON.stringify(newSchedule);

    if (row.scheduleJson === newScheduleJson) {
      continue;
    }

    let newNextRunAt: Date | null = null;
    if (row.enabled && row.schedulingMode === "scheduled") {
      const patched = { ...row, scheduleJson: newScheduleJson } as CityIntroductionSettings;
      newNextRunAt = computeNextRunAt(parseCitySchedule(patched)!, nextRunAtAnchor);
      scheduled += 1;
    } else {
      scheduleOnly += 1;
    }

    const old = row.scheduleJson
      ? (() => {
          try {
            const p = JSON.parse(row.scheduleJson) as Partial<CityScheduleShape>;
            return `${p.dayOfMonth ?? "?"}/${p.localTime ?? "?"}/${p.timezone ?? "?"}`;
          } catch {
            return row.scheduleJson;
          }
        })()
      : "—";

    console.log(
      `  • ${(row.cityName ?? row.cityCode).padEnd(22)} ${old} → day ${dayOfMonth} ${localTime} ${timezone}` +
        (newNextRunAt ? ` (next_run_at → ${newNextRunAt.toISOString().slice(0, 16)})` : "")
    );

    if (!apply) continue;
    await db
      .update(cityIntroductionSettings)
      .set({
        scheduleJson: newScheduleJson,
        ...(newNextRunAt ? { nextRunAt: newNextRunAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(cityIntroductionSettings.cityCode, row.cityCode));
  }

  if (skipped.length > 0) {
    console.log(`\n⚠️  No timezone mapping (skipped): ${skipped.join(", ")}`);
  }
  console.log(
    apply
      ? `\nUpdated ${scheduled} scheduled city schedule(s) (next_run_at recomputed) and ${scheduleOnly} non-scheduled row(s) (schedule_json only).`
      : `\nDry run — ${scheduled} scheduled city schedule(s) and ${scheduleOnly} non-scheduled row(s) would be updated.`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
