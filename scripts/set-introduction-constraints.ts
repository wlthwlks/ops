/**
 * Set the global introduction hard constraints by creating a new immutable
 * version on the DEFAULT matching profile of the target database, and align
 * per-city constraint overrides with the same configuration.
 *
 * Cities resolve constraints as: city override → default profile latest
 * version → code defaults. So this applies the configuration to every
 * future run; existing frozen runs keep their old constraints.
 *
 * Usage:
 *   npx tsx scripts/set-introduction-constraints.ts --env-file=.env          (prod, dry-run)
 *   npx tsx scripts/set-introduction-constraints.ts --env-file=.env --apply
 *   npx tsx scripts/set-introduction-constraints.ts --env-file=.env.local --apply
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
  type MatchingConstraints,
} from "../src/lib/introduction/profiles";

const TARGET_CONSTRAINTS: MatchingConstraints = {
  requireSameCity: true,
  maxDistanceKm: null,
  allowUnknownPostcode: true,
  repeatPairDays: 180,
  memberCooldownDays: 21,
  minEligibleMembers: 12,
  targetGroupSize: 3,
  minGroupSize: 2,
  maxGroupSize: 4,
  strictGroupSize: false,
};

const args = process.argv.slice(2);

const envFileArg = args.find((a) => a.startsWith("--env-file="));
const envFilePath = envFileArg ? envFileArg.split("=")[1] : ".env";
const runArgs = args.filter((a) => a !== envFileArg);

dotenv.config({ path: envFilePath, override: false });
console.log(`Env file: ${envFilePath}`);

const apply = runArgs.includes("--apply");
if (!apply) console.log("🔍 DRY RUN — no writes will be performed\n");

async function main() {
  const targetJson = constraintsToJson(TARGET_CONSTRAINTS);

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
  const currentConstraints = latest ? constraintsFromJson(latest.constraintsJson) : null;
  const currentJson = currentConstraints ? constraintsToJson(currentConstraints) : null;

  console.log(`Default profile: ${profile.name} (${profile.id})`);
  console.log(`Latest version:  ${latest ? `v${latest.version}` : "none"}`);
  console.log(`Current constraints: ${latest ? latest.constraintsJson : "—"}`);
  console.log(`Target constraints:  ${targetJson}`);

  if (latest && currentJson === targetJson) {
    console.log("\nProfile constraints already match the target — nothing to do.");
  } else if (apply) {
    const created = await createMatchingProfileVersion(db, {
      profileId: profile.id,
      weights: latest ? weightsFromJson(latest.weightsJson) : undefined,
      constraints: TARGET_CONSTRAINTS,
      createdBy: "set-introduction-constraints script",
    });
    console.log(`\nCreated version v${created.version} (${created.id})`);
  } else {
    console.log(
      `\nWould create new version (v${(latest?.version ?? 0) + 1}) with the target constraints (preserving current weights).`
    );
  }

  // ── Per-city overrides ──
  console.log("\nCity overrides:");
  const cityRows = await db
    .select({
      cityCode: cityIntroductionSettings.cityCode,
      cityName: cityIntroductionSettings.cityName,
      minEligibleMembers: cityIntroductionSettings.minEligibleMembers,
      targetGroupSize: cityIntroductionSettings.targetGroupSize,
      minGroupSize: cityIntroductionSettings.minGroupSize,
      maxGroupSize: cityIntroductionSettings.maxGroupSize,
      strictGroupSize: cityIntroductionSettings.strictGroupSize,
      requireSameCity: cityIntroductionSettings.requireSameCity,
      maxDistanceKm: cityIntroductionSettings.maxDistanceKm,
      allowUnknownPostcode: cityIntroductionSettings.allowUnknownPostcode,
      repeatPairDays: cityIntroductionSettings.repeatPairDays,
      memberCooldownDays: cityIntroductionSettings.memberCooldownDays,
    })
    .from(cityIntroductionSettings);

  const mismatches: Array<{ city: string; fields: Record<string, unknown> }> = [];
  for (const row of cityRows) {
    const fields: Record<string, unknown> = {};
    if (row.minEligibleMembers != null && row.minEligibleMembers !== 12) fields.minEligibleMembers = 12;
    if (row.targetGroupSize != null && row.targetGroupSize !== 3) fields.targetGroupSize = 3;
    if (row.minGroupSize != null && row.minGroupSize !== 2) fields.minGroupSize = 2;
    if (row.maxGroupSize != null && row.maxGroupSize !== 4) fields.maxGroupSize = 4;
    if (row.strictGroupSize === true) fields.strictGroupSize = false;
    if (row.requireSameCity === false) fields.requireSameCity = true;
    if (row.maxDistanceKm != null) fields.maxDistanceKm = null;
    if (row.allowUnknownPostcode === false) fields.allowUnknownPostcode = true;
    if (row.repeatPairDays != null && row.repeatPairDays !== 180) fields.repeatPairDays = 180;
    if (row.memberCooldownDays != null && row.memberCooldownDays !== 21) fields.memberCooldownDays = 21;
    if (Object.keys(fields).length === 0) continue;
    mismatches.push({ city: row.cityName ?? row.cityCode, fields });
    console.log(
      `  • ${row.cityName ?? row.cityCode}: ${Object.entries(fields)
        .map(([k, v]) => `${k} → ${v}`)
        .join(", ")}`
    );
    if (apply) {
      await db
        .update(cityIntroductionSettings)
        .set(fields)
        .where(eq(cityIntroductionSettings.cityCode, row.cityCode));
    }
  }

  console.log(
    mismatches.length === 0
      ? "  All city overrides already aligned."
      : apply
        ? `\nUpdated ${mismatches.length} city override row(s).`
        : `\nDry run — ${mismatches.length} city override row(s) would be updated.`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
