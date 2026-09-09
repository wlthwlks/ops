/**
 * Set the global introduction matching weights by creating a new immutable
 * version on the DEFAULT matching profile of the target database.
 *
 * All cities resolve weights from the default profile's LATEST version
 * (no city pins a specific version), so creating a new version applies the
 * configuration to every future introduction run. Existing runs keep their
 * old weights (versions are immutable snapshots).
 *
 * Usage:
 *   npx tsx scripts/set-introduction-weights.ts --env-file=.env          (prod, dry-run)
 *   npx tsx scripts/set-introduction-weights.ts --env-file=.env --apply
 *   npx tsx scripts/set-introduction-weights.ts --env-file=.env.local --apply
 */
import * as dotenv from "dotenv";
import { db } from "../src/db";
import { eq, desc } from "drizzle-orm";
import {
  matchingProfiles,
} from "../src/db/schema";
import {
  createMatchingProfileVersion,
  getLatestVersionForProfile,
  weightsFromJson,
  type MatchingWeights,
} from "../src/lib/introduction/profiles";

const TARGET_WEIGHTS: Required<MatchingWeights> = {
  proximity: 20,
  ai_correlation: 20,
  help_expertise: 30,
  goal_relevance: 10,
  connection_type: 10,
  industry: 5,
  business_stage: 5,
};

const args = process.argv.slice(2);

const envFileArg = args.find((a) => a.startsWith("--env-file="));
const envFilePath = envFileArg ? envFileArg.split("=")[1] : ".env";
const runArgs = args.filter((a) => a !== envFileArg);

dotenv.config({ path: envFilePath, override: false });
console.log(`Env file: ${envFilePath}`);

const apply = runArgs.includes("--apply");
if (!apply) console.log("🔍 DRY RUN — no writes will be performed\n");

function weightsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
  }
  return true;
}

async function main() {
  const defaults = await db
    .select()
    .from(matchingProfiles)
    .where(eq(matchingProfiles.isDefault, true))
    .orderBy(desc(matchingProfiles.createdAt))
    .limit(1);
  const profile = defaults[0];
  if (!profile) {
    throw new Error("No default matching profile found in this database");
  }

  const latest = await getLatestVersionForProfile(db, profile.id);
  const current = latest ? weightsFromJson(latest.weightsJson) : null;

  console.log(`Default profile: ${profile.name} (${profile.id})`);
  console.log(`Latest version:  ${latest ? `v${latest.version}` : "none"}`);
  console.log(
    `Current weights: ${latest ? latest.weightsJson : "—"}`
  );

  if (current && weightsEqual(current, TARGET_WEIGHTS)) {
    console.log("\nWeights already match the target — nothing to do.");
    return;
  }

  console.log(`\nTarget weights:  ${JSON.stringify(TARGET_WEIGHTS)}`);
  console.log(
    apply
      ? `\nCreating new version (v${(latest?.version ?? 0) + 1}) on the default profile…`
      : `\nWould create new version (v${(latest?.version ?? 0) + 1}) on the default profile.`
  );

  if (apply) {
    const created = await createMatchingProfileVersion(db, {
      profileId: profile.id,
      weights: TARGET_WEIGHTS,
      createdBy: "set-introduction-weights script",
    });
    console.log(`Created version v${created.version} (${created.id})`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
