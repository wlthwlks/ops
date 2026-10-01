/**
 * Preflight simulation for the next introduction cycle.
 *
 * Builds a SIMULATION-mode preview plan for every enabled + scheduled city
 * (no email is ever sent), reports per-city results, then deletes the
 * throwaway preview rows so the database is left clean for the real run.
 *
 * Also analyses how aggressively re-pairs are avoided: reports how many pairs
 * were blocked by the repeat rule and how many members had to be reintroduced
 * as a last resort.
 *
 * Usage:
 *   npx tsx scripts/preview-due-cities.ts --env-file=.env
 *   npx tsx scripts/preview-due-cities.ts --env-file=.env --keep
 *   npx tsx scripts/preview-due-cities.ts --env-file=.env --concurrency=5 --cycle-date=2026-10-01
 */
import * as dotenv from "dotenv";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../src/db";
import {
  cityIntroductionSettings,
  introductionRuns,
  introductionGroups,
  introductionGroupMembers,
  introductionPairScores,
} from "../src/db/schema";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { createPineconeClient } from "../src/lib/integrations/pinecone";
import { runIntroductionPreview } from "../src/lib/introduction/plan";

const args = process.argv.slice(2);
const argValue = (name: string, def: string) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : def;
};
const envFilePath = argValue("env-file", ".env");
const cycleDate = argValue("cycle-date", "2026-10-01");
const concurrency = Number.parseInt(argValue("concurrency", "5"), 10);
const keep = args.includes("--keep");

dotenv.config({ path: envFilePath, override: false });
console.log(`Env file: ${envFilePath} | Cycle date: ${cycleDate} | Concurrency: ${concurrency}${keep ? " | KEEP" : ""}\n`);

interface CityResult {
  city: string;
  eligible: number;
  matched: number;
  groups: number;
  unmatched: number;
  repeatedPairsBlocked: number;
  reintroducedGroups: number;
  reintroducedMembers: number;
  blockedReason: string | null;
  error: string | null;
}

async function deletePreviewRun(runId: string): Promise<void> {
  const groups = await db
    .select({ id: introductionGroups.id })
    .from(introductionGroups)
    .where(eq(introductionGroups.runId, runId));
  const groupIds = groups.map((g) => g.id);
  if (groupIds.length > 0) {
    await db
      .delete(introductionGroupMembers)
      .where(inArray(introductionGroupMembers.groupId, groupIds));
  }
  await db.delete(introductionGroups).where(eq(introductionGroups.runId, runId));
  await db.delete(introductionPairScores).where(eq(introductionPairScores.runId, runId));
  await db.delete(introductionRuns).where(eq(introductionRuns.id, runId));
}

/** Delete any leftover previews from a previous interrupted preflight run. */
async function cleanupLeftoverPreflights(): Promise<number> {
  const rows = await db
    .select({ id: introductionRuns.id })
    .from(introductionRuns)
    .where(eq(introductionRuns.initiatedBy, "preflight"));
  for (const row of rows) await deletePreviewRun(row.id);
  return rows.length;
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      await fn(items[current]);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
  const airtableBase = process.env.AIRTABLE_BASE_ID;
  const pineconeKey = process.env.PINECONE_API_KEY;
  const pineconeIndex = process.env.PINECONE_INDEX_NAME;
  if (!airtableToken || !airtableBase || !pineconeKey || !pineconeIndex) {
    throw new Error("Missing AIRTABLE_GET_DATA_TOKEN / AIRTABLE_BASE_ID / PINECONE_API_KEY / PINECONE_INDEX_NAME");
  }

  const leftover = await cleanupLeftoverPreflights();
  if (leftover > 0) console.log(`Cleaned up ${leftover} leftover preflight run(s).\n`);

  const cities = await db
    .select({ cityCode: cityIntroductionSettings.cityCode, cityName: cityIntroductionSettings.cityName })
    .from(cityIntroductionSettings)
    .where(
      and(
        eq(cityIntroductionSettings.enabled, true),
        eq(cityIntroductionSettings.schedulingMode, "scheduled")
      )
    )
    .orderBy(cityIntroductionSettings.cityName);

  console.log(`Preflighting ${cities.length} enabled + scheduled cities...\n`);

  const airtable = createAirtableClient({ apiKey: airtableToken, baseId: airtableBase });
  const pinecone = createPineconeClient({ apiKey: pineconeKey, indexName: pineconeIndex });

  const results: CityResult[] = [];
  const deleted = new Set<string>();
  let done = 0;

  await runPool(cities, concurrency, async (city) => {
    const name = city.cityName ?? city.cityCode;
    try {
      const res = await runIntroductionPreview(
        { db, log: () => {}, airtable, pinecone },
        { cityCode: city.cityCode, cycleDate, deliveryMode: "simulation", createdBy: "preflight" }
      );
      if (!res.runId) {
        results.push({ city: name, eligible: 0, matched: 0, groups: 0, unmatched: 0, repeatedPairsBlocked: 0, reintroducedGroups: 0, reintroducedMembers: 0, blockedReason: null, error: res.error ?? "no run id" });
      } else {
        results.push({
          city: name,
          eligible: res.report.eligibleMembers,
          matched: res.report.matchedMembers,
          groups: res.report.groups,
          unmatched: res.report.unmatched,
          repeatedPairsBlocked: res.report.repeatedPairsBlocked,
          reintroducedGroups: res.report.reintroducedGroups,
          reintroducedMembers: res.report.reintroducedMembers,
          blockedReason: res.report.blockedReason,
          error: null,
        });
        if (!keep) {
          await deletePreviewRun(res.runId);
          deleted.add(name);
        }
      }
    } catch (err) {
      results.push({ city: name, eligible: 0, matched: 0, groups: 0, unmatched: 0, repeatedPairsBlocked: 0, reintroducedGroups: 0, reintroducedMembers: 0, blockedReason: null, error: err instanceof Error ? err.message : String(err) });
    }
    done += 1;
    process.stderr.write(`\r[${done}/${cities.length}] ${name}`);
  });
  process.stderr.write("\n\n");

  results.sort((a, b) => a.city.localeCompare(b.city));

  console.log("================ RESULTS ================\n");
  console.log(
    "city".padEnd(22) +
      "eligible".padStart(9) +
      "groups".padStart(7) +
      "unmatched".padStart(10) +
      "repeatBlocked".padStart(14) +
      "reintroGrp".padStart(11) +
      "reintroMem".padStart(11)
  );
  for (const r of results) {
    if (r.error) {
      console.log(`${r.city.padEnd(22)}  ERROR: ${r.error}`);
      continue;
    }
    if (r.blockedReason) {
      console.log(`${r.city.padEnd(22)}  BLOCKED: ${r.blockedReason}`);
      continue;
    }
    console.log(
      r.city.padEnd(22) +
        String(r.eligible).padStart(9) +
        String(r.groups).padStart(7) +
        String(r.unmatched).padStart(10) +
        String(r.repeatedPairsBlocked).padStart(14) +
        String(r.reintroducedGroups).padStart(11) +
        String(r.reintroducedMembers).padStart(11)
    );
  }

  const ok = results.filter((r) => !r.error && !r.blockedReason);
  const errors = results.filter((r) => r.error);
  const blocked = results.filter((r) => r.blockedReason);
  const withUnmatched = ok.filter((r) => r.unmatched > 0);
  const withReintro = ok.filter((r) => r.reintroducedMembers > 0);

  const totalEligible = ok.reduce((s, r) => s + r.eligible, 0);
  const totalMatched = ok.reduce((s, r) => s + r.matched, 0);
  const totalRepeatedBlocked = ok.reduce((s, r) => s + r.repeatedPairsBlocked, 0);
  const totalReintroGroups = ok.reduce((s, r) => s + r.reintroducedGroups, 0);
  const totalReintroMembers = ok.reduce((s, r) => s + r.reintroducedMembers, 0);

  console.log("\n================ ANALYSIS ================\n");
  console.log(`Cities preflighted:       ${results.length}`);
  console.log(`Successful previews:      ${ok.length}`);
  console.log(`Blocked (below gate):     ${blocked.length}`);
  console.log(`Errors:                   ${errors.length}`);
  console.log(`Cities with unmatched:    ${withUnmatched.length}`);
  console.log(`Cities using re-intro:    ${withReintro.length}`);
  console.log("");
  console.log(`Eligible members (total): ${totalEligible}`);
  console.log(`Matched members (total):  ${totalMatched}`);
  console.log(`Repeat-blocked pairs:     ${totalRepeatedBlocked}  (avoided re-pairs)`);
  console.log(`Reintroduced groups:      ${totalReintroGroups}`);
  console.log(`Reintroduced members:     ${totalReintroMembers}`);
  console.log(`Reintroduction rate:      ${totalEligible > 0 ? ((totalReintroMembers / totalEligible) * 100).toFixed(2) : "0"}% of eligible members`);
  console.log("");
  if (withReintro.length > 0) {
    console.log("Cities where a repeat was unavoidable (last resort):");
    for (const r of withReintro) {
      console.log(`  ${r.city.padEnd(22)} eligible=${r.eligible} reintroduced=${r.reintroducedMembers} (${r.reintroducedGroups} group(s))`);
    }
  } else {
    console.log("No re-introductions needed anywhere — every pairing is fresh.");
  }
  if (errors.length > 0) {
    console.log("\nBLOCKERS (errors) detected:");
    for (const r of errors) console.log(`  ${r.city}: ${r.error}`);
  }
  if (blocked.length > 0) {
    console.log("\nCities blocked (below minimum eligible members):");
    for (const r of blocked) console.log(`  ${r.city}: ${r.blockedReason}`);
  }
  if (keep) {
    console.log(`\nKept ${ok.length} preview run(s) in the database.`);
  } else {
    console.log(`\nDeleted ${deleted.size} throwaway preview run(s).`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
