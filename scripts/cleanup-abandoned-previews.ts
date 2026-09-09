/**
 * Delete abandoned operator previews.
 *
 * Operator previews are throwaway tools (status "preview", dry-run, created
 * by an operator). Creating a new preview for the same city + cycle date
 * already replaces the previous one, but previews for past cycle dates
 * (e.g. abandoned previews from before the fix) pile up. This script
 * removes operator previews older than --days (default 7) and their
 * groups / members / pair scores.
 *
 * Usage:
 *   npx tsx scripts/cleanup-abandoned-previews.ts --env-file=.env          (dry-run)
 *   npx tsx scripts/cleanup-abandoned-previews.ts --env-file=.env --apply
 *   npx tsx scripts/cleanup-abandoned-previews.ts --env-file=.env --apply --days=30
 */
import * as dotenv from "dotenv";
import { db } from "../src/db";
import { and, eq, inArray, isNotNull, lt, or } from "drizzle-orm";
import {
  introductionRuns,
  introductionGroups,
  introductionGroupMembers,
  introductionPairScores,
} from "../src/db/schema";

const args = process.argv.slice(2);

const envFileArg = args.find((a) => a.startsWith("--env-file="));
const envFilePath = envFileArg ? envFileArg.split("=")[1] : ".env";
const runArgs = args.filter((a) => a !== envFileArg);

const daysArg = runArgs.find((a) => a.startsWith("--days="));
const days = daysArg ? Math.max(1, Number.parseInt(daysArg.split("=")[1], 10) || 7) : 7;

dotenv.config({ path: envFilePath, override: false });
console.log(`Env file: ${envFilePath}`);

const apply = runArgs.includes("--apply");
if (!apply) console.log("🔍 DRY RUN — no writes will be performed\n");

async function main() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const stale = await db
    .select({ id: introductionRuns.id, cycleDate: introductionRuns.cycleDate, cityCodesJson: introductionRuns.cityCodesJson, createdAt: introductionRuns.createdAt })
    .from(introductionRuns)
    .where(
      and(
        eq(introductionRuns.dryRun, true),
        isNotNull(introductionRuns.initiatedBy),
        or(eq(introductionRuns.status, "preview"), eq(introductionRuns.status, "planned")),
        lt(introductionRuns.createdAt, cutoff)
      )
    );

  console.log(`Found ${stale.length} operator preview(s) older than ${days} day(s):\n`);

  let deleted = 0;
  for (const run of stale) {
    let city = "?";
    try {
      const parsed = JSON.parse(run.cityCodesJson ?? "[]");
      if (Array.isArray(parsed) && parsed[0]) city = String(parsed[0]);
    } catch {
      // keep placeholder
    }
    console.log(
      `  • ${run.id.slice(0, 8)}… cycle=${run.cycleDate ?? "?"} city=${city} created=${run.createdAt.toISOString()}`
    );
    if (!apply) continue;

    const groups = await db
      .select({ id: introductionGroups.id })
      .from(introductionGroups)
      .where(eq(introductionGroups.runId, run.id));
    if (groups.length > 0) {
      await db
        .delete(introductionGroupMembers)
        .where(inArray(introductionGroupMembers.groupId, groups.map((g) => g.id)));
    }
    await db.delete(introductionGroups).where(eq(introductionGroups.runId, run.id));
    await db.delete(introductionPairScores).where(eq(introductionPairScores.runId, run.id));
    await db.delete(introductionRuns).where(eq(introductionRuns.id, run.id));
    deleted += 1;
  }

  console.log(
    apply
      ? `\nDeleted ${deleted} preview(s).`
      : `\nDry run — ${stale.length} preview(s) would be deleted.`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
