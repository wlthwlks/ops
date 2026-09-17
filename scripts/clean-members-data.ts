/**
 * One-off cleanup of legacy/dirty values in MEMBERS signup columns.
 *
 * Dry run (default):  computes proposed changes, writes
 *   tmp/members-cleanup-report.csv (no Airtable writes).
 * Apply:              backs up affected records, applies batched updates with
 *   typecast, writes tmp/members-cleanup-applied.csv, re-verifies.
 *
 * Usage: npx tsx scripts/clean-members-data.ts [--apply]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import {
  createAirtableClient,
  type AirtableRecord,
} from "../src/lib/integrations/airtable";
import { MEMBERS_TABLE } from "../src/lib/ops/airtable-fields";

dotenv.config();

const APPLY = process.argv.includes("--apply");

const INDUSTRY_CODES = new Set([
  "TECH_SAAS",
  "ECOMMERCE",
  "PROFESSIONAL_SERVICES",
  "HEALTH_WELLNESS",
  "CREATIVE_MEDIA",
  "FINANCE",
  "EDUCATION",
  "REAL_ESTATE",
  "HOSPITALITY",
  "CONSUMER",
  "COACHING",
  "OTHER",
]);

const REVENUE_CODES = new Set([
  "PRE_REVENUE",
  "0_10K",
  "10K_50K",
  "50K_100K",
  "100K_500K",
  "500K_1M",
  "1M_2M",
  "2M_5M",
  "5M_10M",
  "10M_20M",
  "20M_PLUS",
  "PREFER_NOT_TO_SAY",
]);

const INDUSTRY_MAP: Record<string, string> = {
  "tech_saas": "TECH_SAAS",
  "tech / saas": "TECH_SAAS",
  "saas": "TECH_SAAS",
  "tech": "TECH_SAAS",
  "technology": "TECH_SAAS",
  "saas, martech": "TECH_SAAS",
  "ecommerce": "ECOMMERCE",
  "e-commerce": "ECOMMERCE",
  "professional_services": "PROFESSIONAL_SERVICES",
  "professional services": "PROFESSIONAL_SERVICES",
  "professional service / creative media": "PROFESSIONAL_SERVICES",
  "professional services + tech": "PROFESSIONAL_SERVICES",
  "legal": "PROFESSIONAL_SERVICES",
  "hr consulting": "PROFESSIONAL_SERVICES",
  "recruitment": "PROFESSIONAL_SERVICES",
  "accounting": "PROFESSIONAL_SERVICES",
  "bookkeeping": "PROFESSIONAL_SERVICES",
  "notary public": "PROFESSIONAL_SERVICES",
  "taxation and profit strategist": "PROFESSIONAL_SERVICES",
  "personal assistance": "PROFESSIONAL_SERVICES",
  "virtual operations": "PROFESSIONAL_SERVICES",
  "virtual business support services": "PROFESSIONAL_SERVICES",
  "human capital/people operations": "PROFESSIONAL_SERVICES",
  "health_wellness": "HEALTH_WELLNESS",
  "health & wellness": "HEALTH_WELLNESS",
  "health and wellness": "HEALTH_WELLNESS",
  "healthcare": "HEALTH_WELLNESS",
  "wellness": "HEALTH_WELLNESS",
  "beauty & wellness": "HEALTH_WELLNESS",
  "mental health": "HEALTH_WELLNESS",
  "medical": "HEALTH_WELLNESS",
  "medtech": "HEALTH_WELLNESS",
  "womens health practitioner": "HEALTH_WELLNESS",
  "healthcare, functional wellness": "HEALTH_WELLNESS",
  "general health, wellness, hormones, fertility": "HEALTH_WELLNESS",
  "pelvic floor outpatient therapy": "HEALTH_WELLNESS",
  "psychotherapy": "HEALTH_WELLNESS",
  "creative_media": "CREATIVE_MEDIA",
  "creative & media": "CREATIVE_MEDIA",
  "creative": "CREATIVE_MEDIA",
  "creative/marketing": "CREATIVE_MEDIA",
  "creative, mental health": "CREATIVE_MEDIA",
  "finance": "FINANCE",
  "financial services": "FINANCE",
  "financial": "FINANCE",
  "financial planning": "FINANCE",
  "finance & trading": "FINANCE",
  "education": "EDUCATION",
  "birthworker, childbirth education": "EDUCATION",
  "real_estate": "REAL_ESTATE",
  "real estate": "REAL_ESTATE",
  "design, remodeling & real estate": "REAL_ESTATE",
  "creative, real estate, software": "REAL_ESTATE",
  "hospitality": "HOSPITALITY",
  "pizza catering": "HOSPITALITY",
  "travel": "HOSPITALITY",
  "travel agency": "HOSPITALITY",
  "travel advisory": "HOSPITALITY",
  "travel & identity": "HOSPITALITY",
  "travel (travel advisor)": "HOSPITALITY",
  "travel and coaching (i have 2 businesses)": "HOSPITALITY",
  "consumer": "CONSUMER",
  "beauty/ retail": "CONSUMER",
  "beauty": "CONSUMER",
  "retail- hobby/craft": "CONSUMER",
  "clothing brand": "CONSUMER",
  "food product": "CONSUMER",
  "food production": "CONSUMER",
  "wholesale b2b trade industry": "CONSUMER",
  "coaching": "COACHING",
  "coach": "COACHING",
  "functional medicine coaching": "COACHING",
  "hypnotherapy and life coaching": "COACHING",
  "sales coaching": "COACHING",
  "coaching and online programs": "COACHING",
  "career coach and small business consultant": "COACHING",
  "coach, wellness products": "COACHING",
  "coach & speaking": "COACHING",
  "coaching / personal growth & development / wellness": "COACHING",
  "executive advisor | coach": "COACHING",
  "other": "OTHER",
};

const INDUSTRY_EXTRA_MAP: Record<string, string> = {
  "Physical service": "PROFESSIONAL_SERVICES",
  Agency: "PROFESSIONAL_SERVICES",
  "Interior Design": "CREATIVE_MEDIA",
  "Fractional COO": "PROFESSIONAL_SERVICES",
  "Real estate, Staffing, Recruiting": "REAL_ESTATE",
  "Sound Healing & Peaceful Productivity Coaching": "HEALTH_WELLNESS",
  "Education, PR, Imagemaking, Culture": "EDUCATION",
  "Music entertainment": "CREATIVE_MEDIA",
  "Other - Real Estate": "REAL_ESTATE",
  "Nutrition Coach": "COACHING",
  "Speech and Language Pathology": "HEALTH_WELLNESS",
  "Creative/Interior Architecture & Design": "CREATIVE_MEDIA",
  "Forensic Neuropsychology": "HEALTH_WELLNESS",
  "Agency (Marketing)": "CREATIVE_MEDIA",
  "Wellness, consulting, performing arts": "HEALTH_WELLNESS",
  "Consulting, Retail Marketing, Business Strategy & Operations":
    "PROFESSIONAL_SERVICES",
  "Angel Investor and Advisor": "FINANCE",
  "Consulting for SaaS/tech startups | Community builder": "TECH_SAAS",
  "Growth Advisor": "PROFESSIONAL_SERVICES",
  "Marketing/AI Agency": "TECH_SAAS",
  "Personal Advisory & Digital Products": "PROFESSIONAL_SERVICES",
  "SaaS, AI, content and writing, automation": "TECH_SAAS",
  "Creative and Internet Infrastructure": "TECH_SAAS",
  "Mattress Manufacturing and Retail": "CONSUMER",
  "Growth Marketing": "CREATIVE_MEDIA",
  "Promotional products, branding, swag, retail items, merch": "CONSUMER",
  Marketing: "CREATIVE_MEDIA",
  "Services: Private Pilates Business + Business Operations Consulting":
    "HEALTH_WELLNESS",
  "IT Services": "TECH_SAAS",
  "Other - Marketing": "CREATIVE_MEDIA",
  "Fitness/pilates studio owner": "HEALTH_WELLNESS",
  "Website design and storytelling": "CREATIVE_MEDIA",
  "Business Support & AI Systems Consulting": "TECH_SAAS",
  "Event Management & Business Operations": "PROFESSIONAL_SERVICES",
};

const INDUSTRY_TO_OTHER = new Set([
  "Community",
  "Manufacturing",
  "Nonprofit",
  "Nonprofit Consulting",
  "Construction",
  "Steel Manufacturing",
  "Design & Construction",
  "Construction, Boutique and Luxury Pool Builds",
  "Trades / Service",
  "Move Management",
  "Site services",
  "Design & Build",
  "Renewable Energy / Construction Management",
  "Dog Training",
  "Sourcing",
]);

const INDUSTRY_JUNK_BLANK = new Set([
  "Figuring it out",
  "I don\u2019t want to be matched with someone in the real estate industry",
]);

const REVENUE_MAP: Record<string, string> = {
  "pre_revenue": "PRE_REVENUE",
  "pre-revenue": "PRE_REVENUE",
  "$0": "PRE_REVENUE",
  "0": "PRE_REVENUE",
  "0_10k": "0_10K",
  "$0-$10k": "0_10K",
  "$0-$20k": "0_10K",
  "$3k to $10k": "0_10K",
  "10,000": "0_10K",
  "10k_50k": "10K_50K",
  "$10k-$50k": "10K_50K",
  "$10k": "10K_50K",
  "$10k-15k annually": "10K_50K",
  "50k_100k": "50K_100K",
  "$50k-$100k": "50K_100K",
  "50 - 100k": "50K_100K",
  "$75k+": "50K_100K",
  "$80k-$100k": "50K_100K",
  "100k_500k": "100K_500K",
  "$100k-$500k": "100K_500K",
  "100k": "100K_500K",
  "150-200k": "100K_500K",
  "$80k-$120k": "100K_500K",
  "$250-$500k": "100K_500K",
  "500k_1m": "500K_1M",
  "$500k-$1m": "500K_1M",
  "500k": "500K_1M",
  "1m_2m": "1M_2M",
  "$1m-$2m": "1M_2M",
  "$1000000": "1M_2M",
  "$1.2m": "1M_2M",
  "2m_5m": "2M_5M",
  "$2m-$5m": "2M_5M",
  "5m_10m": "5M_10M",
  "$5m-$10m": "5M_10M",
  "10m_20m": "10M_20M",
  "$10m-$20m": "10M_20M",
  "20m_plus": "20M_PLUS",
  "$20m+": "20M_PLUS",
  "prefer_not_to_say": "PREFER_NOT_TO_SAY",
  "prefer not to say": "PREFER_NOT_TO_SAY",
};

const REVENUE_BLANK = new Set([
  "7 figures",
  "-",
  "significant 6 fig",
  "pre-launch",
  "$0-$10k a month",
]);

const POSTCODE_REWRITE: Record<string, string> = {
  "4412;": "4412",
  "00000 (Dubai Hills)": "00000",
};

const POSTCODE_BLANK = new Set([
  "?",
  "-",
  "Don\u2019t matter",
  "Seattle, WA",
  "Beach Haven, NJ 08008, USA",
  "Dallas, TX 75225",
  "97069\u201d8",
  "PVH9+2P",
  "5016 / 5035",
]);

const CITY_TYPO_MAP: Record<string, string> = {
  "Forth Worth": "Fort Worth",
  LA: "Los Angeles",
  "Sao Paul": "S\u00e3o Paulo",
  "Sao Paulo": "S\u00e3o Paulo",
  "Newport Beach, CA": "Newport Beach",
  "Fairfax, VA": "Fairfax",
  Berkley: "Berkeley",
  "St Petersburg": "St. Petersburg",
  NA: "",
};

type Change = {
  recordId: string;
  email: string;
  field: string;
  from: string;
  to: string;
  action: "rewrite" | "blank";
};

const str = (v: unknown): string => {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => String(x)).join("; ");
  return String(v).trim();
};

function phoneFix(v: string): string | null {
  if (!v) return null;
  if (/@/.test(v)) return "";
  if (/[A-Za-z]/.test(v.replace(/\+/g, ""))) return "";
  return null;
}

function socialFix(v: string): string | null {
  if (!v) return null;
  if (/https?:\/\//i.test(v) || /(?:www\.)?(?:linkedin|instagram)\.com/i.test(v)) {
    return null;
  }
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(v)) return "";
  if (/^\+?[\d\s().\-]{7,}$/.test(v.trim())) return "";
  const lines = v
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  if (lines.every((l) => /^@?[A-Za-z0-9._\-]+$/.test(l))) return null;
  return "";
}

function computeChanges(
  records: AirtableRecord[],
  cityCaseMap: Map<string, string>
): Change[] {
  const changes: Change[] = [];

  for (const r of records) {
    const email = str(r.fields["email"]);
    const push = (
      field: string,
      from: string,
      to: string,
      action: "rewrite" | "blank"
    ) => {
      changes.push({ recordId: r.id, email, field, from, to, action });
    };

    const industry = str(r.fields["Industry"]);
    if (industry && !INDUSTRY_CODES.has(industry)) {
      const mapped = INDUSTRY_MAP[industry.toLowerCase()];
      if (mapped) {
        push("Industry", industry, mapped, "rewrite");
      } else if (Object.prototype.hasOwnProperty.call(INDUSTRY_EXTRA_MAP, industry)) {
        push("Industry", industry, INDUSTRY_EXTRA_MAP[industry], "rewrite");
      } else if (INDUSTRY_TO_OTHER.has(industry)) {
        push("Industry", industry, "OTHER", "rewrite");
        const existingOther = str(r.fields["Other industry"]);
        if (!existingOther) {
          push("Other industry", "", industry, "rewrite");
        }
      } else if (INDUSTRY_JUNK_BLANK.has(industry)) {
        push("Industry", industry, "", "blank");
      }
    }

    const revenue = str(r.fields["Revenue"]);
    if (revenue && !REVENUE_CODES.has(revenue)) {
      const key = revenue.toLowerCase();
      if (REVENUE_BLANK.has(key)) push("Revenue", revenue, "", "blank");
      else {
        const mapped = REVENUE_MAP[key];
        if (mapped) push("Revenue", revenue, mapped, "rewrite");
      }
    }

    const phone = str(r.fields["phone number"]);
    const phoneTo = phoneFix(phone);
    if (phoneTo !== null) push("phone number", phone, phoneTo, "blank");

    const social = str(r.fields["social media"]);
    const socialTo = socialFix(social);
    if (socialTo !== null) push("social media", social, socialTo, "blank");

    const postCode = str(r.fields["post code"]);
    if (postCode) {
      if (POSTCODE_BLANK.has(postCode)) {
        push("post code", postCode, "", "blank");
      } else if (Object.prototype.hasOwnProperty.call(POSTCODE_REWRITE, postCode)) {
        push("post code", postCode, POSTCODE_REWRITE[postCode], "rewrite");
      }
    }

    const city = str(r.fields["City"]);
    if (city) {
      if (Object.prototype.hasOwnProperty.call(CITY_TYPO_MAP, city)) {
        const to = CITY_TYPO_MAP[city];
        push("City", city, to, to === "" ? "blank" : "rewrite");
      } else if (city.toLowerCase() === "na") {
        push("City", city, "", "blank");
      } else {
        const canonical = cityCaseMap.get(city.toLowerCase());
        if (canonical && canonical !== city) {
          push("City", city, canonical, "rewrite");
        }
      }
    }

    const membership = str(r.fields["Membership"]);
    if (membership === "CANCELLED") {
      push("Membership", membership, "Cancelled", "rewrite");
    }
  }

  return changes;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function writeReport(rows: Array<Record<string, string>>, file: string): void {
  if (rows.length === 0) {
    fs.writeFileSync(file, "", "utf8");
    return;
  }
  const header = Object.keys(rows[0]);
  const lines = [
    header.join(","),
    ...rows.map((row) => header.map((h) => csvEscape(row[h] ?? "")).join(",")),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function applyChanges(
  client: ReturnType<typeof createAirtableClient>,
  changes: Change[]
): Promise<number> {
  const byRecord = new Map<string, { email: string; patch: Record<string, string> }>();
  for (const c of changes) {
    let entry = byRecord.get(c.recordId);
    if (!entry) {
      entry = { email: c.email, patch: {} };
      byRecord.set(c.recordId, entry);
    }
    entry.patch[c.field] = c.to;
  }

  const backupRows = [...byRecord.entries()].map(([id, e]) => ({
    recordId: id,
    email: e.email,
    ...e.patch,
  }));

  const payloads = [...byRecord.entries()].map(([id, e]) => ({
    id,
    fields: e.patch,
  }));

  const BATCH = 10;
  let done = 0;
  for (let i = 0; i < payloads.length; i += BATCH) {
    const batch = payloads.slice(i, i + BATCH);
    await client.updateRecords(MEMBERS_TABLE, batch, { typecast: true });
    done += batch.length;
    console.log(`  applied ${done}/${payloads.length} records`);
    await sleep(250);
  }

  const outDir = path.join(process.cwd(), "tmp");
  writeReport(backupRows, path.join(outDir, "members-cleanup-backup.csv"));
  return payloads.length;
}

async function main() {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    console.error("Missing AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID in .env");
    process.exit(1);
  }

  const client = createAirtableClient({ apiKey: token, baseId });

  const records = await client.listRecords(MEMBERS_TABLE, {
    fields: [
      "email",
      "First Name",
      "Last Name",
      "Age",
      "City",
      "Timezone",
      "post code",
      "phone number",
      "Phone prefix",
      "Industry",
      "Business stage",
      "Revenue",
      "Other industry",
      "social media",
      "Membership",
      "Payment",
      "Onboarding status",
      "Date joined",
    ],
  });
  console.log(`Fetched ${records.length} members`);

  const cityRecords = await client.listRecords("ALL CITIES", { fields: ["City"] });
  const cityCaseMap = new Map<string, string>();
  for (const c of cityRecords) {
    const name = str(c.fields["City"]);
    if (name) cityCaseMap.set(name.toLowerCase(), name);
  }

  const changes = computeChanges(records, cityCaseMap);
  console.log(`Proposed changes: ${changes.length}`);

  const byField = new Map<string, { rewrites: number; blanks: number }>();
  for (const c of changes) {
    const s = byField.get(c.field) ?? { rewrites: 0, blanks: 0 };
    if (c.action === "blank") s.blanks += 1;
    else s.rewrites += 1;
    byField.set(c.field, s);
  }
  for (const [field, s] of [...byField.entries()].sort()) {
    console.log(`  ${field}: ${s.rewrites} rewrites, ${s.blanks} blanks`);
  }

  const outDir = path.join(process.cwd(), "tmp");
  const reportRows = changes.map((c) => ({
    recordId: c.recordId,
    email: c.email,
    field: c.field,
    from: c.from,
    to: c.to,
    action: c.action,
  }));

  if (!APPLY) {
    writeReport(reportRows, path.join(outDir, "members-cleanup-report.csv"));
    console.log("\nDRY RUN — no changes written.");
    console.log(`Report: tmp/members-cleanup-report.csv (${reportRows.length} rows)`);
    console.log("Run with --apply to write these changes.");
    return;
  }

  writeReport(reportRows, path.join(outDir, "members-cleanup-report.csv"));
  console.log("\nAPPLYING changes...");
  const applied = await applyChanges(client, changes);
  console.log(`Applied to ${applied} records. Backup: tmp/members-cleanup-backup.csv`);

  const verify = await client.listRecords(MEMBERS_TABLE, {
    fields: ["email", "City", "post code", "phone number", "Industry", "Revenue", "Other industry", "social media", "Membership"],
  });
  const remaining = computeChanges(verify, cityCaseMap);
  console.log(`\nVerification — remaining fixable values: ${remaining.length}`);
  const remByField = new Map<string, number>();
  for (const c of remaining) remByField.set(c.field, (remByField.get(c.field) ?? 0) + 1);
  for (const [f, n] of remByField) console.log(`  ${f}: ${n}`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
