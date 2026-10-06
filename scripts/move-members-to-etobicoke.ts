/**
 * Move a batch of preview seed members into Etobicoke (sotacodework's city)
 * so manual introductions can be tested against a richer partner pool.
 *
 * Keeps their fake profiles; only rewrites City / City relation / postcode /
 * timezone. Postcodes are real Etobicoke-area postal codes so proximity
 * scoring resolves.
 *
 * SAFETY: refuses unless AIRTABLE_BASE_ID is the preview base and
 * MOVE_TO_ETOBICOKE=yes is set.
 *
 * Run: MOVE_TO_ETOBICOKE=yes npx tsx scripts/move-members-to-etobicoke.ts --env-file=.env.local [--count=30]
 */
import * as dotenv from "dotenv";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { MEMBERS_TABLE, MEMBER_FIELDS } from "../src/lib/ops/airtable-fields";

const PREVIEW_BASE_ID = "applsfPMbycl6VM1p";
const ETOBICOKE_CITY_ID = "recEiXR8SfhYeozdH";
const ETOBICOKE_CITY_NAME = "Etobicoke";
const ETOBICOKE_TIMEZONE = "America/Toronto";

const ETOBICOKE_POSTCODES = [
  "M9A 1A1", "M9B 2B2", "M9C 3C3", "M9P 4D4", "M9R 5E5", "M9V 6F6", "M9W 7G7",
  "M8V 1H8", "M8W 2J9", "M8X 3K1", "M8Y 4L2", "M8Z 5M3",
  "M9A 6N4", "M9B 7P5", "M9C 8Q6", "M9P 9R7", "M9R 1S8", "M9V 2T9", "M9W 3U1", "M8V 4V2",
];

const args = process.argv.slice(2);
const envFileArg = args.find((a) => a.startsWith("--env-file="));
const envFilePath = envFileArg ? envFileArg.split("=")[1] : ".env.local";
const countArg = args.find((a) => a.startsWith("--count="));
const count = countArg ? parseInt(countArg.split("=")[1], 10) : 30;
dotenv.config({ path: envFilePath, override: false });

async function main() {
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (baseId !== PREVIEW_BASE_ID) {
    console.error(`Refusing: AIRTABLE_BASE_ID=${baseId ?? "(unset)"} is not the preview base.`);
    process.exit(1);
  }
  if (process.env.MOVE_TO_ETOBICOKE !== "yes") {
    console.error("Refusing: set MOVE_TO_ETOBICOKE=yes to confirm.");
    process.exit(1);
  }

  const airtable = createAirtableClient({
    apiKey: process.env.AIRTABLE_GET_DATA_TOKEN!,
    baseId,
  });

  const members = await airtable.listRecords(MEMBERS_TABLE, {
    fields: [MEMBER_FIELDS.email, MEMBER_FIELDS.cityRelation],
  });

  const candidates = members.filter((m) => {
    const email = String(m.fields[MEMBER_FIELDS.email] ?? "");
    if (!/^seed-\d+@preview\.wlthwlks$/.test(email)) return false;
    const rel = (m.fields[MEMBER_FIELDS.cityRelation] as string[] | undefined) ?? [];
    return !rel.includes(ETOBICOKE_CITY_ID);
  });

  const toMove = candidates.slice(0, count);
  if (toMove.length === 0) {
    console.log("No seed members outside Etobicoke to move.");
    return;
  }

  console.log(`Moving ${toMove.length} seed member(s) to ${ETOBICOKE_CITY_NAME}...`);

  const updates = toMove.map((m, i) => ({
    id: m.id,
    fields: {
      [MEMBER_FIELDS.city]: ETOBICOKE_CITY_NAME,
      [MEMBER_FIELDS.cityRelation]: [ETOBICOKE_CITY_ID],
      [MEMBER_FIELDS.postCode]: ETOBICOKE_POSTCODES[i % ETOBICOKE_POSTCODES.length],
      [MEMBER_FIELDS.timezone]: ETOBICOKE_TIMEZONE,
    },
  }));

  const updated = await airtable.updateRecordsBatched(MEMBERS_TABLE, updates, { typecast: true });
  console.log(`Moved ${updated.length} member(s) into ${ETOBICOKE_CITY_NAME}.`);
}

main().catch((err) => {
  console.error("Move-to-Etobicoke failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
