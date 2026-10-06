/**
 * Anonymise the PREVIEW Airtable base's remaining real-email members so that
 * every member EXCEPT sotacodework@gmail.com carries fake profile info. This
 * is used to safely exercise manual introductions without touching real data.
 *
 * The 200 `seed-*@preview.wlthwlks` members are already fake; this script only
 * rewrites the non-seed, non-target member(s) (currently holarina1@gmail.com).
 *
 * SAFETY: refuses to run unless AIRTABLE_BASE_ID is the preview base and
 * FAKE_PREVIEW=yes is set.
 *
 * Run: FAKE_PREVIEW=yes npx tsx scripts/fake-preview-members.ts --env-file=.env.local
 */
import * as dotenv from "dotenv";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { MEMBERS_TABLE, MEMBER_FIELDS } from "../src/lib/ops/airtable-fields";
import { getOnboardingReferenceData } from "../src/lib/forms/reference-data";

const PREVIEW_BASE_ID = "applsfPMbycl6VM1p";
const KEEP_REAL_EMAIL = "sotacodework@gmail.com";

const args = process.argv.slice(2);
const envFileArg = args.find((a) => a.startsWith("--env-file="));
const envFilePath = envFileArg ? envFileArg.split("=")[1] : ".env.local";
dotenv.config({ path: envFilePath, override: false });

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickN<T>(arr: readonly T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

const FIRST_NAMES = ["Nadia", "Camila", "Reem", "Petra", "Anika", "Marta", "Cleo", "Farah"];
const LAST_NAMES = ["Qureshi", "Mendes", "Lindqvist", "Diallo", "Khan", "Marino", "Bennett", "Vega"];
const HEADLINES = ["Founder & CEO", "Co-founder & COO", "Founder & Principal", "Managing Partner"];
const COMPANIES = ["Solace Foundry", "Harbor Systems", "Willow Ventures", "Quill Works"];
const BIO_INTRO = [
  "{company} helps founders in {industry} run a tighter, calmer business.",
  "I started {company} to fix how {industry} teams actually work together.",
  "{company} builds tools for {industry} companies tired of spreadsheets.",
];
const BIO_CLOSE = [
  "Ask me about {topic} — I have strong opinions and better stories.",
  "Happy to compare notes with anyone at a similar stage.",
  "I joined WLTH WLKS because building alone runs out of ideas fast.",
];

async function main() {
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (baseId !== PREVIEW_BASE_ID) {
    console.error(
      `Refusing to run: AIRTABLE_BASE_ID=${baseId ?? "(unset)"} is not the preview base (${PREVIEW_BASE_ID}).`
    );
    process.exit(1);
  }
  if (process.env.FAKE_PREVIEW !== "yes") {
    console.error("Refusing to run: set FAKE_PREVIEW=yes to confirm this preview-only action.");
    process.exit(1);
  }

  const ref = await getOnboardingReferenceData();
  const industries = ref.industries.filter((i) => i.code !== "OTHER");
  const stages = ref.businessStages;
  const connections = ref.connectionTypes.filter((c) => c.code !== "NO_PREFERENCE");
  const helpOpts = ref.helpWantedOptions;
  const expertOpts = ref.expertiseOptions;

  const airtable = createAirtableClient({
    apiKey: process.env.AIRTABLE_GET_DATA_TOKEN!,
    baseId,
  });

  // List every member whose email is not a seed address and not the keeper.
  const members = await airtable.listRecords(MEMBERS_TABLE, {
    fields: [MEMBER_FIELDS.email, MEMBER_FIELDS.cityRelation],
  });

  const targets = members.filter((r) => {
    const email = String(r.fields[MEMBER_FIELDS.email] ?? "").trim().toLowerCase();
    return (
      email &&
      email !== KEEP_REAL_EMAIL &&
      !/^seed-\d+@preview\.wlthwlks$/.test(email)
    );
  });

  if (targets.length === 0) {
    console.log("Nothing to do: every non-target member already has fake info.");
    return;
  }

  console.log(`Anonymising ${targets.length} member(s) (keeping ${KEEP_REAL_EMAIL})...\n`);

  const updated: Array<{ id: string; oldEmail: string; newEmail: string }> = [];

  for (let i = 0; i < targets.length; i++) {
    const record = targets[i];
    const oldEmail = String(record.fields[MEMBER_FIELDS.email] ?? "");
    const newEmail = `seed-${200 + i}@preview.wlthwlks`;

    const firstName = pick(FIRST_NAMES);
    const lastName = pick(LAST_NAMES);
    const headline = pick(HEADLINES);
    const company = pick(COMPANIES);
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20);
    const industry = pick(industries);
    const stage = pick(stages);
    const connectionType = pick(connections);
    const helpWanted = pickN(helpOpts, 2);
    const expertise = pickN(expertOpts, 2);
    const bio = [
      pick(BIO_INTRO).replace("{company}", company).replace("{industry}", industry.label),
      pick(BIO_CLOSE).replace("{topic}", "churn"),
    ].join(" ");

    const fields: Record<string, unknown> = {
      [MEMBER_FIELDS.email]: newEmail,
      [MEMBER_FIELDS.memberstackId]: `seed-${200 + i}`,
      [MEMBER_FIELDS.firstName]: firstName,
      [MEMBER_FIELDS.lastName]: lastName,
      [MEMBER_FIELDS.professionalHeadline]: headline,
      [MEMBER_FIELDS.profileBio]: bio,
      [MEMBER_FIELDS.businessName]: company,
      [MEMBER_FIELDS.businessWebsite]: `https://${slug}.io`,
      [MEMBER_FIELDS.socialMedia]: `linkedin|https://www.linkedin.com/in/${slug}`,
      [MEMBER_FIELDS.industry]: industry.code,
      [MEMBER_FIELDS.businessStage]: stage.code,
      [MEMBER_FIELDS.connectionType]: connectionType.code,
      [MEMBER_FIELDS.helpWanted]: helpWanted.map((o) => o.code),
      [MEMBER_FIELDS.helpWantedContext]: "Founders who have navigated enterprise procurement.",
      [MEMBER_FIELDS.expertise]: expertise.map((o) => o.code),
      [MEMBER_FIELDS.expertiseContext]: "Product discovery frameworks and roadmap triage.",
      [MEMBER_FIELDS.postCode]: String(10000 + Math.floor(Math.random() * 90000)),
      [MEMBER_FIELDS.membership]: "Active",
      [MEMBER_FIELDS.payment]: "Paid",
      [MEMBER_FIELDS.recurringIntroStatus]: "Active",
      [MEMBER_FIELDS.memberDirectoryStatus]: "Active",
      [MEMBER_FIELDS.serviceAccessUntil]: "2027-01-05T21:18:39.000Z",
      [MEMBER_FIELDS.stripeSubscriptionStatus]: "active",
      [MEMBER_FIELDS.profilePhotoUrl]: `https://randomuser.me/api/portraits/women/${(200 + i) % 100}.jpg`,
      [MEMBER_FIELDS.profilePhotoThumbUrl]: `https://randomuser.me/api/portraits/thumb/women/${(200 + i) % 100}.jpg`,
    };

    await airtable.updateRecords(MEMBERS_TABLE, [{ id: record.id, fields }], { typecast: true });
    updated.push({ id: record.id, oldEmail, newEmail });
    console.log(`  ${oldEmail} → ${newEmail} (${firstName} ${lastName}, ${company})`);
  }

  console.log(`\nAnonymised ${updated.length} member(s). ${KEEP_REAL_EMAIL} left untouched.`);
}

main().catch((err) => {
  console.error("Fake-preview failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
