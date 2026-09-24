/**
 * Seed the PREVIEW Airtable base with realistic fake directory members.
 *
 * Writes directly to Airtable MEMBERS (does NOT go through signup / Memberstack,
 * so no Postgres rows, Pinecone vectors, or real emails are created).
 *
 * SAFETY: refuses to run unless the base is the preview base AND the operator
 * sets SEED_DIRECTORY=yes. Members are intro-eligible on purpose (Active/Paid),
 * but their emails/Slack are fake.
 *
 * Run: SEED_DIRECTORY=yes npx tsx scripts/seed-directory-members.ts --env-file=.env.local
 */
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { MEMBERS_TABLE, MEMBER_FIELDS } from "../src/lib/ops/airtable-fields";
import { getOnboardingReferenceData } from "../src/lib/forms/reference-data";

const PREVIEW_BASE_ID = "applsfPMbycl6VM1p";
const COUNT = 200;

// Deterministic PRNG (mulberry32).
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function pickN<T>(rng: () => number, arr: readonly T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

const FIRST_NAMES = [
  "Amara", "Priya", "Sofia", "Mei", "Eleanor", "Zara", "Naomi", "Hannah",
  "Ines", "Leila", "Mariam", "Chioma", "Aisha", "Fatima", "Camila", "Isla",
  "Noor", "Sana", "Yasmin", "Lena", "Rania", "Dalia", "Selma", "Amelie",
  "Clara", "Marta", "Helena", "Julia", "Lucia", "Nina", "Tessa", "Rosa",
  "Elena", "Frida", "Sara", "Kira", "Anya", "Olga", "Dina", "Layla",
  "Maya", "Reem", "Hana", "Aya", "Nadia", "Iman", "Salma", "Dana",
  "Grace", "Eva", "Ivy", "Jade", "Ruby", "Vera", "Willa", "Mabel",
  "Cleo", "Petra", "Greta", "Sable", "Nell", "Opal", "Fern", "Juno",
  "Celine", "Marisol", "Anika", "Devika", "Farah", "Samira", "Talia", "Zainab",
  "Bianca", "Renata", "Alba", "Carla", "Elif", "Mira", "Selena", "Ada",
  "Beatrice", "Cecilia", "Delphine", "Emilia", "Florence", "Giselle", "Harper", "Indira",
];

const LAST_NAMES = [
  "Okafor", "Raman", "Marchetti", "Chen", "Vance", "Haddad", "Clarke", "Brandt",
  "Silva", "Khan", "Patel", "Nguyen", "Alvarez", "Costa", "Mendes", "Fischer",
  "Novak", "Petrov", "Kim", "Tanaka", "Adeyemi", "Diallo", "Nwosu", "Osei",
  "Rivera", "Delgado", "Morales", "Ortega", "Reyes", "Vega", "Soto", "Acosta",
  "Dubois", "Lefevre", "Moreau", "Laurent", "Berg", "Lindqvist", "Jansen", "De Vries",
  "Rossi", "Ricci", "Marino", "Conti", "Kaur", "Sharma", "Reddy", "Nair",
  "Iyer", "Mehta", "Chopra", "Ahmed", "Malik", "Hussain", "Qureshi", "Siddiqui",
  "Wright", "Bennett", "Carter", "Ellis", "Foster", "Grant", "Hayes", "Ibrahim",
  "Joseph", "Kaur", "Lawson", "Morgan", "Palmer", "Quinn", "Sutton", "Turner",
];

const HEADLINES = [
  "Founder & CEO",
  "Co-founder",
  "Co-founder & CPO",
  "Co-founder & COO",
  "Founder",
  "Founder & Principal",
  "Managing Partner",
  "CEO",
  "Founder & CTO",
  "Co-founder & CEO",
  "Founder & Creative Director",
  "Founder & Head of Product",
];

const COMPANY_PREFIX = [
  "Ledger", "North", "Atlas", "Casa", "Arc", "Vance", "Third", "Rowan",
  "Bright", "Loop", "Meridian", "Copper", "Willow", "Harbor", "Mint", "Solace",
  "Nova", "Fern", "Quill", "Ember", "Haven", "Petal", "Grove", "Signal",
  "Lumen", "Opal", "Drift", "Bolt", "Marigold", "Clove", "Sable", "Cinder",
];

const COMPANY_SUFFIX = [
  "Loop", "Bound", "Learn", "Supply", "Works", "Studio", "Capital", "Health",
  "Lab", "Systems", "Ventures", "Collective", "House", "Goods", "Analytics",
  "Media", "Kitchen", "Legal", "& Co", "Foundry", "Atlas", "Farm", "Haus",
];

const BIO_INTRO = [
  "{company} helps founders in {industry} run a tighter, calmer business.",
  "I started {company} to fix how {industry} teams actually work together.",
  "{company} builds tools for {industry} companies that are tired of spreadsheets.",
  "At {company} we make {industry} simpler, faster and more human.",
  "{company} is a {industry} business I run from {city}.",
  "I founded {company} after years inside {industry}, wanting to build something better.",
];

const BIO_MIDDLE = [
  "Before this I spent {years} years in operations, mostly fixing other people's processes.",
  "We are {team} people, fully remote, and about {months} months into building something people rely on.",
  "I spend most of my time on {focus}, and on protecting the team from the chaos growth creates.",
  "We recently {milestone}, and I am still figuring out how much of this is luck.",
  "The hardest part of this stage is {challenge}, which I have decided to treat as an advantage.",
  "Most of my work is helping founders figure out what their business stands for before they scale.",
];

const BIO_CLOSE = [
  "I am always up for a walk that turns into a long conversation about {topic}.",
  "I joined WLTH WLKS because building alone runs out of ideas fast.",
  "Happy to compare notes with anyone at a similar stage.",
  "Ask me about {topic} — I have strong opinions and better stories.",
  "I like meeting women who have made the jump I am about to make.",
  "Outside of work I am usually on a trail somewhere, always up for a long walk.",
];

const FOCUS = [
  "pricing and retention", "hiring senior operators", "partnerships", "product",
  "margin discipline", "customer experience", "brand and positioning", "operations",
];

const MILESTONE = [
  "closed our seed", "raised a Series A", "hit profitability", "shipped a second product",
  "expanded into two new markets", "grew past twenty people",
];

const CHALLENGE = [
  "keeping decision making fast", "growing revenue that does not depend on me",
  "saying no politely", "protecting the team from chaos", "unit economics",
  "hiring people who need context",
];

const TOPIC = [
  "hiring", "churn", "fundraising", "pricing", "unit economics", "go-to-market",
  "decks", "operations", "brand", "roadmaps",
];

const HELP_CONTEXT = [
  "Intros to fractional operators and people who have done this before.",
  "Founders who have navigated enterprise procurement.",
  "Product leaders who scaled a team past twenty people.",
  "Anyone who has priced a usage-based product well.",
  "Studio owners who moved from client work into a product.",
  "Operators thinking about expanding into a new market.",
];

const EXPERT_CONTEXT = [
  "Candid feedback and honest deck reviews.",
  "Advice on regulated go-to-market and pilot programmes.",
  "Product discovery frameworks and roadmap triage.",
  "Plain-language help with contracts and early hires.",
  "Supply-chain introductions and unit-economics pressure testing.",
  "Seed-round storytelling and narrative help.",
];

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

async function main() {
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (baseId !== PREVIEW_BASE_ID) {
    console.error(
      `Refusing to seed: AIRTABLE_BASE_ID=${baseId ?? "(unset)"} is not the preview base (${PREVIEW_BASE_ID}).`
    );
    process.exit(1);
  }
  if (process.env.SEED_DIRECTORY !== "yes") {
    console.error("Refusing to seed: set SEED_DIRECTORY=yes to confirm this preview-only action.");
    process.exit(1);
  }

  const ref = await getOnboardingReferenceData();
  const cities = ref.cities;
  const industries = ref.industries.filter((i) => i.code !== "OTHER");
  const stages = ref.businessStages;
  const connections = ref.connectionTypes.filter((c) => c.code !== "NO_PREFERENCE");
  const helpOpts = ref.helpWantedOptions;
  const expertOpts = ref.expertiseOptions;

  if (!cities.length || !industries.length || !stages.length) {
    console.error("Seed aborted: reference data missing cities/industries/stages.");
    process.exit(1);
  }

  const HUB_LABELS = [
    "Dubai", "London", "Austin", "Singapore", "Berlin", "Mexico City",
    "New York", "San Francisco", "Toronto", "Amsterdam", "Paris", "Sydney",
  ];
  const hubs = cities.filter((c) => HUB_LABELS.includes(c.label));
  const hubPool = hubs.length > 0 ? hubs : cities;

  const rng = mulberry32(20260924);

  const records: Array<{ fields: Record<string, unknown> }> = [];

  for (let i = 0; i < COUNT; i++) {
    const firstName = pick(rng, FIRST_NAMES);
    const lastName = pick(rng, LAST_NAMES);
    const company = `${pick(rng, COMPANY_PREFIX)}${rng() < 0.3 ? " " + pick(rng, COMPANY_SUFFIX) : ""}`.trim();
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20);
    const industry = pick(rng, industries);
    const stage = pick(rng, stages);
    const city = rng() < 0.6 ? pick(rng, hubPool) : pick(rng, cities);
    const headline = pick(rng, HEADLINES);
    const connectionType = pick(rng, connections);
    const helpWanted = pickN(rng, helpOpts, 2 + Math.floor(rng() * 2));
    const expertise = pickN(rng, expertOpts, 2 + Math.floor(rng() * 2));
    const photoIndex = i % 100;

    const joinedDate = new Date(Date.now() - Math.floor(rng() * 180) * 24 * 3600 * 1000);

    const bioVars = {
      company,
      industry: industry.label,
      city: city.label,
      years: String(3 + Math.floor(rng() * 10)),
      team: String(2 + Math.floor(rng() * 38)),
      months: String(6 + Math.floor(rng() * 42)),
      focus: pick(rng, FOCUS),
      milestone: pick(rng, MILESTONE),
      challenge: pick(rng, CHALLENGE),
      topic: pick(rng, TOPIC),
    };

    const bio = [
      fill(pick(rng, BIO_INTRO), bioVars),
      fill(pick(rng, BIO_MIDDLE), bioVars),
      fill(pick(rng, BIO_CLOSE), bioVars),
    ].join(" ");

    const fields: Record<string, unknown> = {
      [MEMBER_FIELDS.memberstackId]: `seed-${i}`,
      [MEMBER_FIELDS.email]: `seed-${i}@preview.wlthwlks`,
      [MEMBER_FIELDS.firstName]: firstName,
      [MEMBER_FIELDS.lastName]: lastName,
      [MEMBER_FIELDS.professionalHeadline]: headline,
      [MEMBER_FIELDS.profileBio]: bio,
      [MEMBER_FIELDS.businessName]: company,
      [MEMBER_FIELDS.businessWebsite]: `https://${slug}.${pick(rng, ["co", "io", "com"])}`,
      [MEMBER_FIELDS.socialMedia]: `linkedin|https://www.linkedin.com/in/${slug}`,
      [MEMBER_FIELDS.city]: city.legacyCityLabel || city.label,
      [MEMBER_FIELDS.cityRelation]: [city.code],
      [MEMBER_FIELDS.timezone]: city.timezone,
      [MEMBER_FIELDS.postCode]: String(10000 + Math.floor(rng() * 90000)),
      [MEMBER_FIELDS.industry]: industry.code,
      [MEMBER_FIELDS.businessStage]: stage.code,
      [MEMBER_FIELDS.connectionType]: connectionType.code,
      [MEMBER_FIELDS.helpWanted]: helpWanted.map((o) => o.code),
      [MEMBER_FIELDS.helpWantedContext]: pick(rng, HELP_CONTEXT),
      [MEMBER_FIELDS.expertise]: expertise.map((o) => o.code),
      [MEMBER_FIELDS.expertiseContext]: pick(rng, EXPERT_CONTEXT),
      [MEMBER_FIELDS.membership]: "Active",
      [MEMBER_FIELDS.payment]: "Paid",
      [MEMBER_FIELDS.recurringIntroStatus]: "Active",
      [MEMBER_FIELDS.memberDirectoryStatus]: "Active",
      [MEMBER_FIELDS.memberDirectoryInviteSeen]: true,
      [MEMBER_FIELDS.dateJoined]: joinedDate.toISOString(),
      [MEMBER_FIELDS.profilePhotoUrl]: `https://randomuser.me/api/portraits/women/${photoIndex}.jpg`,
      [MEMBER_FIELDS.profilePhotoThumbUrl]: `https://randomuser.me/api/portraits/thumb/women/${photoIndex}.jpg`,
    };

    records.push({ fields });
  }

  const airtable = createAirtableClient({
    apiKey: process.env.AIRTABLE_GET_DATA_TOKEN!,
    baseId,
  });

  const created = await airtable.createRecordsBatched(MEMBERS_TABLE, records, {
    typecast: true,
  });
  console.log(`Seeded ${created.length} directory members into preview.`);
}

main().catch((err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
