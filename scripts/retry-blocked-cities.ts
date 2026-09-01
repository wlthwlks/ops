/**
 * Re-arm cities whose latest introduction run was blocked.
 *
 * After fixing the eligibility bug that falsely blocked standalone cities
 * (Palo Alto, Boulder, Scottsdale, …), those cities' schedules were advanced
 * to the next month. This script resets their next_run_at to now so the
 * hourly city scheduler (or the admin "Run city scheduler now" button)
 * rebuilds them with the corrected logic.
 *
 * Usage:
 *   npx tsx scripts/retry-blocked-cities.ts           (live)
 *   npx tsx scripts/retry-blocked-cities.ts --dry-run (preview only)
 */
import "dotenv/config";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { introductionRuns, cityIntroductionSettings } from "@/db/schema";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("🔍 DRY RUN — no writes will be performed\n");

  const blockedRuns = await db
    .select()
    .from(introductionRuns)
    .where(eq(introductionRuns.status, "blocked"))
    .orderBy(desc(introductionRuns.createdAt));

  // Latest blocked run per city (a city may have several across the day).
  const latestByCity = new Map<
    string,
    { runId: string; cycleDate: string | null; createdAt: Date }
  >();
  for (const run of blockedRuns) {
    let codes: string[] = [];
    try {
      const parsed = JSON.parse(run.cityCodesJson ?? "[]") as unknown;
      if (Array.isArray(parsed)) codes = parsed.map(String);
    } catch {
      codes = [];
    }
    const code = codes[0];
    if (!code || latestByCity.has(code)) continue;
    latestByCity.set(code, {
      runId: run.id,
      cycleDate: run.cycleDate,
      createdAt: run.createdAt,
    });
  }

  if (latestByCity.size === 0) {
    console.log("No blocked city runs found.");
    return;
  }

  const cityRows = await db.select().from(cityIntroductionSettings);
  const nameByCode = new Map(cityRows.map((c) => [c.cityCode, c.cityName]));

  let updated = 0;
  console.log(`Found ${latestByCity.size} blocked city run(s):\n`);
  for (const [code, info] of latestByCity) {
    const name = nameByCode.get(code) ?? code;
    const current = cityRows.find((c) => c.cityCode === code);
    console.log(
      `  • ${name} (${code}) — run ${info.runId.slice(0, 8)}…, cycle ${info.cycleDate ?? "?"}, ` +
        `next_run_at ${current?.nextRunAt ? current.nextRunAt.toISOString() : "null"}`
    );
    if (!dryRun) {
      await db
        .update(cityIntroductionSettings)
        .set({ nextRunAt: new Date(), updatedAt: new Date() })
        .where(eq(cityIntroductionSettings.cityCode, code));
      updated += 1;
    }
  }

  console.log(
    dryRun
      ? `\nDry run — ${latestByCity.size} city schedule(s) would be reset to now.`
      : `\nReset next_run_at to now for ${updated} city/cities. The next scheduler tick will rebuild them.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
