/**
 * READ-ONLY export of cities with few active members for the SweatPals
 * handoff.
 *
 *   npm run airtable:export-small-cities
 *   npm run airtable:export-small-cities -- --output=tmp/custom.xlsx
 *
 * "Active member" = qualifying active/trialing Stripe subscription
 * (pause-guarded), same census as members:export-xlsx. City membership comes
 * from the MEMBERS "City relation" link → ALL CITIES; country is resolved
 * through the city → COUNTRIES.
 *
 * Sheet 1 "Members": active members who live in a city with 1–11 active
 * members (Name, email, Country, City).
 * Sheet 2 "Cities": those qualifying cities with their active-member counts.
 *
 * Requires: AIRTABLE_GET_DATA_TOKEN, AIRTABLE_BASE_ID, STRIPE_SECRET_KEY
 * (plus the billing-catalog price configuration).
 */
import * as dotenv from "dotenv";
import { mkdirSync } from "fs";
import { dirname } from "path";
import ExcelJS from "exceljs";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import {
  getStripeClient,
  getStripeNativeMembershipPriceIds,
} from "../src/lib/integrations/stripe";
import { resolveNativeMembershipAllowlist } from "../src/lib/billing/service-access-sync";
import {
  computeKlaviyoCensus,
  fetchCityCountries,
} from "../src/lib/billing/klaviyo-membership-sync";
import {
  namesFromStripeCustomer,
  type ActiveMembershipSubscription,
} from "../src/lib/billing/historical-stripe-member-repair";
import { extractStripeCustomerEmail } from "../src/lib/billing/webhook-invoice-sync";
import { MEMBER_FIELDS } from "../src/lib/ops/airtable-fields";

dotenv.config();

const DEFAULT_OUTPUT = "tmp/small-cities-members.xlsx";
/** Cities with strictly fewer than this many active members qualify. */
const MAX_ACTIVE = 11;

export function parseExportArgs(argv: string[]): { output: string } {
  let output = DEFAULT_OUTPUT;
  for (const arg of argv) {
    if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length).trim();
      if (!output) throw new Error("--output requires a path");
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run airtable:export-small-cities -- [--output=PATH]",
          "",
          `  --output=PATH output file (default ${DEFAULT_OUTPUT})`,
        ].join("\n")
      );
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return { output };
}

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return v == null ? "" : String(v).trim();
}

function normalizeEmailForIndex(email: string): string {
  return (email || "").trim().toLowerCase();
}

function firstLinkId(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === "string" && v.startsWith("rec")) return v;
    }
    return null;
  }
  if (typeof value === "string" && value.startsWith("rec")) return value;
  return null;
}

type MemberEntry = {
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  cityText: string;
  cityRelationId: string;
};

async function fetchMemberIndex(
  airtable: ReturnType<typeof createAirtableClient>
): Promise<{ byCustomerId: Map<string, MemberEntry>; byEmail: Map<string, MemberEntry[]> }> {
  const byCustomerId = new Map<string, MemberEntry>();
  const byEmail = new Map<string, MemberEntry[]>();

  const records = await airtable.listRecords("Members", {
    fields: [
      MEMBER_FIELDS.email,
      MEMBER_FIELDS.name,
      MEMBER_FIELDS.firstName,
      MEMBER_FIELDS.lastName,
      MEMBER_FIELDS.city,
      MEMBER_FIELDS.cityRelation,
      MEMBER_FIELDS.stripeCustomerId,
    ],
  });

  for (const record of records) {
    const entry: MemberEntry = {
      email: normalizeEmailForIndex(fieldStr(record.fields, MEMBER_FIELDS.email)),
      name: fieldStr(record.fields, MEMBER_FIELDS.name),
      firstName: fieldStr(record.fields, MEMBER_FIELDS.firstName),
      lastName: fieldStr(record.fields, MEMBER_FIELDS.lastName),
      cityText: fieldStr(record.fields, MEMBER_FIELDS.city),
      cityRelationId: firstLinkId(record.fields[MEMBER_FIELDS.cityRelation]) ?? "",
    };
    const customerId = fieldStr(record.fields, MEMBER_FIELDS.stripeCustomerId);
    if (customerId && !byCustomerId.has(customerId)) {
      byCustomerId.set(customerId, entry);
    }
    if (entry.email) {
      const list = byEmail.get(entry.email) ?? [];
      list.push(entry);
      byEmail.set(entry.email, list);
    }
  }

  return { byCustomerId, byEmail };
}

type ActiveMemberRow = {
  name: string;
  email: string;
  country: string;
  city: string;
  cityRecordId: string;
};

function resolveMemberRow(
  membership: ActiveMembershipSubscription,
  entry: MemberEntry | undefined,
  citiesById: Map<string, { city: string; country: string }>
): ActiveMemberRow | null {
  if (!entry) return null;
  const linked = entry.cityRelationId ? citiesById.get(entry.cityRelationId) : undefined;
  const city = linked?.city || entry.cityText;
  if (!city) return null;
  const country = linked?.country ?? "";

  const email = extractStripeCustomerEmail(membership.customer) ?? entry.email;
  let name = entry.name || `${entry.firstName} ${entry.lastName}`.trim();
  if (!name) {
    const names = namesFromStripeCustomer(membership.customer, email);
    name = `${names.firstName} ${names.lastName}`.trim();
  }

  return {
    name,
    email,
    country,
    city,
    cityRecordId: entry.cityRelationId,
  };
}

function requireEnv(name: string): string {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

async function main() {
  let args: ReturnType<typeof parseExportArgs>;
  try {
    args = parseExportArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.log("Small-cities export: READ-ONLY (no writes)");

  let allow: Set<string>;
  try {
    allow = resolveNativeMembershipAllowlist(
      getStripeNativeMembershipPriceIds({
        requireConfigured: true,
        failClosedInProduction: false,
      })
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
  console.log(`Membership price_ allowlist (${allow.size}): ${[...allow].join(", ")}\n`);

  const stripe = getStripeClient();
  const airtable = createAirtableClient({
    apiKey: requireEnv("AIRTABLE_GET_DATA_TOKEN"),
    baseId: requireEnv("AIRTABLE_BASE_ID"),
  });

  console.log("Computing Stripe active census…");
  const census = await computeKlaviyoCensus({ stripe, membershipPriceIds: allow });
  console.log(`  active: ${census.active.length}\n`);

  console.log("Fetching Airtable members…");
  const { byCustomerId, byEmail } = await fetchMemberIndex(airtable);
  console.log(`  member rows read: ${byEmail.size} unique emails\n`);

  console.log("Fetching city/country catalogue…");
  const citiesById = await fetchCityCountries(airtable);
  console.log(`  city records: ${citiesById.size}\n`);

  const rows: ActiveMemberRow[] = [];
  let skippedNoMatch = 0;
  let skippedNoCity = 0;
  for (const membership of census.active) {
    let entry = byCustomerId.get(membership.stripeCustomerId);
    if (!entry) {
      const email = normalizeEmailForIndex(extractStripeCustomerEmail(membership.customer) ?? "");
      const candidates = email ? (byEmail.get(email) ?? []) : [];
      entry = candidates[0];
    }
    if (!entry) {
      skippedNoMatch++;
      continue;
    }
    const row = resolveMemberRow(membership, entry, citiesById);
    if (!row) {
      skippedNoCity++;
      continue;
    }
    rows.push(row);
  }
  console.log(`Active members joined: ${rows.length} (skipped: ${skippedNoMatch} no Airtable match, ${skippedNoCity} no city)\n`);

  const countsByCity = new Map<string, { name: string; count: number }>();
  for (const row of rows) {
    const bucket = countsByCity.get(row.cityRecordId) ?? { name: row.city, count: 0 };
    bucket.count += 1;
    countsByCity.set(row.cityRecordId, bucket);
  }

  const qualifying = [...countsByCity.values()]
    .filter((c) => c.count <= MAX_ACTIVE)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const qualifyingCities = new Set(qualifying.map((c) => c.name));

  const memberRows = rows
    .filter((r) => qualifyingCities.has(r.city))
    .sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name));

  console.log(`Cities with ≤${MAX_ACTIVE} active members: ${qualifying.length}\n`);
  for (const c of qualifying) {
    console.log(`  ${String(c.count).padStart(3)}  ${c.name}`);
  }
  console.log(`\nMembers in those cities: ${memberRows.length}`);

  const workbook = new ExcelJS.Workbook();

  const membersSheet = workbook.addWorksheet("Members");
  membersSheet.addRow(["Name", "email", "Country", "City"]);
  membersSheet.getRow(1).font = { bold: true };
  for (const row of memberRows) {
    membersSheet.addRow([row.name, row.email, row.country, row.city]);
  }
  membersSheet.getColumn(1).width = 28;
  membersSheet.getColumn(2).width = 34;
  membersSheet.getColumn(3).width = 18;
  membersSheet.getColumn(4).width = 18;
  membersSheet.views = [{ state: "frozen", ySplit: 1 }];

  const citiesSheet = workbook.addWorksheet("Cities");
  citiesSheet.addRow(["City name", "Active members"]);
  citiesSheet.getRow(1).font = { bold: true };
  for (const c of qualifying) {
    citiesSheet.addRow([c.name, c.count]);
  }
  citiesSheet.getColumn(1).width = 24;
  citiesSheet.getColumn(2).width = 16;
  citiesSheet.views = [{ state: "frozen", ySplit: 1 }];

  mkdirSync(dirname(args.output), { recursive: true });
  await workbook.xlsx.writeFile(args.output);
  console.log(`\nXLSX written: ${args.output} (sheets: Members + Cities)`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("export-small-cities.ts") ||
    process.argv[1].includes("export-small-cities"));

if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e : e);
    process.exit(1);
  });
}
