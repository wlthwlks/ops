/**
 * Preview-only: relax the member-cooldown so manual introductions can be
 * re-tested against the same target without the 21-day cooldown blocking
 * every new pairing (the target was "introduced" by a prior canary run).
 *
 * Creates a new version of the PREVIEW default matching profile with
 * memberCooldownDays = 0, and clears any per-city member-cooldown overrides.
 * Repeat-pair (180d) is left untouched.
 *
 * SAFETY: refuses unless the DB is the preview DB and PREVIEW_COOLDOWN=yes.
 *
 * Run: PREVIEW_COOLDOWN=yes npx tsx scripts/set-preview-cooldown.ts --env-file=.env.local
 */
import * as dotenv from "dotenv";
import { desc, eq } from "drizzle-orm";
import { db } from "../src/db";
import { matchingProfiles, matchingProfileVersions, cityIntroductionSettings } from "../src/db/schema";
import {
  createMatchingProfileVersion,
  constraintsFromJson,
  getLatestVersionForProfile,
  weightsFromJson,
} from "../src/lib/introduction/profiles";

const args = process.argv.slice(2);
const envFileArg = args.find((a) => a.startsWith("--env-file="));
const envFilePath = envFileArg ? envFileArg.split("=")[1] : ".env.local";
dotenv.config({ path: envFilePath, override: false });

async function main() {
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (baseId !== "applsfPMbycl6VM1p") {
    console.error(`Refusing: AIRTABLE_BASE_ID=${baseId ?? "(unset)"} is not the preview base.`);
    process.exit(1);
  }
  if (process.env.PREVIEW_COOLDOWN !== "yes") {
    console.error("Refusing: set PREVIEW_COOLDOWN=yes to confirm.");
    process.exit(1);
  }

  const defaults = await db
    .select()
    .from(matchingProfiles)
    .where(eq(matchingProfiles.isDefault, true))
    .orderBy(desc(matchingProfiles.createdAt))
    .limit(1);
  const profile = defaults[0];
  if (!profile) throw new Error("No default matching profile found in the preview DB");

  const latest = await getLatestVersionForProfile(db, profile.id);
  if (!latest) throw new Error(`Default profile ${profile.id} has no versions`);

  const current = constraintsFromJson(latest.constraintsJson);
  console.log(`Current memberCooldownDays: ${current.memberCooldownDays}, repeatPairDays: ${current.repeatPairDays}`);
  if (current.memberCooldownDays === 0) {
    console.log("memberCooldownDays already 0 — nothing to do.");
  } else {
    const next = { ...current, memberCooldownDays: 0 };
    const created = await createMatchingProfileVersion(db, {
      profileId: profile.id,
      weights: weightsFromJson(latest.weightsJson),
      constraints: next,
      createdBy: "set-preview-cooldown script",
    });
    console.log(`Created default profile version v${created.version} with memberCooldownDays=0`);
  }

  // Clear any per-city member-cooldown overrides so cities inherit the profile.
  const cities = await db.select().from(cityIntroductionSettings);
  let cleared = 0;
  for (const c of cities) {
    if (c.memberCooldownDays != null) {
      await db
        .update(cityIntroductionSettings)
        .set({ memberCooldownDays: null, updatedAt: new Date() })
        .where(eq(cityIntroductionSettings.cityCode, c.cityCode));
      cleared += 1;
    }
  }
  console.log(`Cleared ${cleared} per-city member-cooldown override(s).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
