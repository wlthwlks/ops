/**
 * Set the minimum eligible members for introductions to 2.
 *
 * Applies the change in the two places that govern the city gate:
 *   1. The DEFAULT matching profile — publishes a new immutable version with
 *      minEligibleMembers = 2, preserving the current weights and every other
 *      constraint.
 *   2. Per-city overrides — updates every city whose stored
 *      min_eligible_members is 12 to 2.
 *
 * Cities resolve the gate as: city override → default profile latest version
 * → code defaults, so this covers all current cities and any future city.
 * Existing frozen runs are unaffected (immutable).
 *
 * Usage:
 *   npx tsx scripts/set-min-eligible-members.ts --env-file=.env          (dry-run)
 *   npx tsx scripts/set-min-eligible-members.ts --env-file=.env --apply
 */
import * as dotenv from "dotenv";
import { db } from "../src/db";
import { desc, eq } from "drizzle-orm";
import { matchingProfiles, cityIntroductionSettings } from "../src/db/schema";
import {
  createMatchingProfileVersion,
  constraintsFromJson,
  constraintsToJson,
  getLatestVersionForProfile,
  weightsFromJson,
} from "../src/lib/introduction/profiles";

const TARGET_MIN_ELIGIBLE_MEMBERS = 2;

const args = process.argv.slice(2);

const envFileArg = args.find((a) => a.startsWith("--env-file="));
const envFilePath = envFileArg ? envFileArg.split("=")[1] : ".env";
const runArgs = args.filter((a) => a !== envFileArg);

dotenv.config({ path: envFilePath, override: false });
console.log(`Env file: ${envFilePath}`);

const apply = runArgs.includes("--apply");
if (!apply) console.log("DRY RUN — no writes will be performed\n");

async function main() {
  // ── Default matching profile version ──
  const defaults = await db
    .select()
    .from(matchingProfiles)
    .where(eq(matchingProfiles.isDefault, true))
    .orderBy(desc(matchingProfiles.createdAt))
    .limit(1);
  const profile = defaults[0];
  if (!profile) throw new Error("No default matching profile found in this database");

  const latest = await getLatestVersionForProfile(db, profile.id);
  if (!latest) throw new Error(`Default profile ${profile.id} has no versions`);

  const currentConstraints = constraintsFromJson(latest.constraintsJson);
  const nextConstraints = { ...currentConstraints, minEligibleMembers: TARGET_MIN_ELIGIBLE_MEMBERS };

  console.log(`Default profile: ${profile.name} (${profile.id})`);
  console.log(`Latest version:  v${latest.version}`);
  console.log(`Current minEligibleMembers: ${currentConstraints.minEligibleMembers}`);
  console.log(`Target minEligibleMembers:  ${TARGET_MIN_ELIGIBLE_MEMBERS}`);
  console.log(`Current constraints: ${latest.constraintsJson}`);
  console.log(`Target constraints:  ${constraintsToJson(nextConstraints)}`);

  if (currentConstraints.minEligibleMembers === TARGET_MIN_ELIGIBLE_MEMBERS) {
    console.log("\nProfile already at the target minimum — nothing to do.");
  } else if (apply) {
    const created = await createMatchingProfileVersion(db, {
      profileId: profile.id,
      weights: weightsFromJson(latest.weightsJson),
      constraints: nextConstraints,
      createdBy: "set-min-eligible-members script",
    });
    console.log(`\nCreated version v${created.version} (${created.id})`);
  } else {
    console.log(
      `\nWould create version v${latest.version + 1} with minEligibleMembers = ${TARGET_MIN_ELIGIBLE_MEMBERS} (preserving weights and all other constraints).`
    );
  }

  // ── Per-city overrides ──
  console.log("\nCity overrides (min_eligible_members = 12 → 2):");
  const cityRows = await db
    .select({
      cityCode: cityIntroductionSettings.cityCode,
      cityName: cityIntroductionSettings.cityName,
      minEligibleMembers: cityIntroductionSettings.minEligibleMembers,
    })
    .from(cityIntroductionSettings)
    .where(eq(cityIntroductionSettings.minEligibleMembers, 12));

  for (const row of cityRows) {
    console.log(`  • ${row.cityName ?? row.cityCode}: ${row.minEligibleMembers} → ${TARGET_MIN_ELIGIBLE_MEMBERS}`);
    if (apply) {
      await db
        .update(cityIntroductionSettings)
        .set({ minEligibleMembers: TARGET_MIN_ELIGIBLE_MEMBERS, updatedAt: new Date() })
        .where(eq(cityIntroductionSettings.cityCode, row.cityCode));
    }
  }

  console.log(
    cityRows.length === 0
      ? "  No cities currently set to 12."
      : apply
        ? `\nUpdated ${cityRows.length} city override row(s).`
        : `\nDry run — ${cityRows.length} city override row(s) would be updated.`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
