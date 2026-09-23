/**
 * READ-ONLY export of all current churned members to an .xlsx.
 *
 *   npm run members:export-churned
 *   npm run members:export-churned -- --limit=50
 *   npm run members:export-churned -- --output=tmp/custom.xlsx
 *
 * "Churned member" = qualifying subscription fully ended (status canceled)
 * and no qualifying active/trialing subscription — the SAME census that feeds
 * the Klaviyo churned list (computeKlaviyoCensus).
 *
 * Each Stripe customer is joined to a MEMBERS row by Stripe Customer ID
 * (fallback: unique email). Customers with no matching Airtable record are
 * skipped. No writes are made to Airtable, Stripe, or Klaviyo.
 *
 * Columns: Email, Name, Country, City, Zipcode, Date joined.
 * Country is resolved through MEMBERS "City relation" → ALL CITIES → COUNTRIES.
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

const DEFAULT_OUTPUT = "tmp/churned-members.xlsx";

const MEMBER_EXPORT_FIELDS = [
  MEMBER_FIELDS.email,
  MEMBER_FIELDS.name,
  MEMBER_FIELDS.firstName,
  MEMBER_FIELDS.lastName,
  MEMBER_FIELDS.city,
  MEMBER_FIELDS.cityRelation,
  MEMBER_FIELDS.postCode,
  MEMBER_FIELDS.dateJoined,
  MEMBER_FIELDS.stripeCustomerId,
] as const;

export function parseExportArgs(argv: string[]): {
  limit?: number;
  output: string;
} {
  let limit: number | undefined;
  let output = DEFAULT_OUTPUT;

  for (const arg of argv) {
    if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --limit value: ${arg}`);
      }
      limit = n;
    } else if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length).trim();
      if (!output) throw new Error("--output requires a path");
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run members:export-churned -- [--limit=N] [--output=PATH]",
          "",
          "  --limit=N     cap the Stripe churn census listing at N customers (sanity runs)",
          `  --output=PATH output file (default ${DEFAULT_OUTPUT})`,
        ].join("\n")
      );
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return { limit, output };
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

/** ISO datetime → YYYY-MM-DD when parseable, raw string otherwise. */
function formatDateJoined(value: string): string {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return trimmed;
  return new Date(ms).toISOString().slice(0, 10);
}

type MemberEntry = {
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  cityText: string;
  cityRelationId: string;
  zip: string;
  dateJoined: string;
};

async function fetchMemberIndex(
  airtable: ReturnType<typeof createAirtableClient>
): Promise<{ byCustomerId: Map<string, MemberEntry>; byEmail: Map<string, MemberEntry[]> }> {
  const byCustomerId = new Map<string, MemberEntry>();
  const byEmail = new Map<string, MemberEntry[]>();

  const records = await airtable.listRecords("Members", {
    fields: [...MEMBER_EXPORT_FIELDS],
  });
  for (const record of records) {
    const entry: MemberEntry = {
      email: normalizeEmailForIndex(fieldStr(record.fields, MEMBER_FIELDS.email)),
      name: fieldStr(record.fields, MEMBER_FIELDS.name),
      firstName: fieldStr(record.fields, MEMBER_FIELDS.firstName),
      lastName: fieldStr(record.fields, MEMBER_FIELDS.lastName),
      cityText: fieldStr(record.fields, MEMBER_FIELDS.city),
      cityRelationId: firstLinkId(record.fields[MEMBER_FIELDS.cityRelation]) ?? "",
      zip: fieldStr(record.fields, MEMBER_FIELDS.postCode),
      dateJoined: fieldStr(record.fields, MEMBER_FIELDS.dateJoined),
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

type ChurnedRow = {
  email: string;
  name: string;
  country: string;
  city: string;
  zip: string;
  dateJoined: string;
};

function resolveRow(
  membership: ActiveMembershipSubscription,
  entry: MemberEntry,
  citiesById: Map<string, { city: string; country: string }>
): ChurnedRow {
  const linked = entry.cityRelationId ? citiesById.get(entry.cityRelationId) : undefined;
  const city = linked?.city || entry.cityText;
  const country = linked?.country ?? "";

  const email = extractStripeCustomerEmail(membership.customer) ?? entry.email;

  let name = entry.name || `${entry.firstName} ${entry.lastName}`.trim();
  if (!name) {
    const names = namesFromStripeCustomer(membership.customer, email);
    name = `${names.firstName} ${names.lastName}`.trim();
  }

  return {
    email,
    name,
    country,
    city,
    zip: entry.zip,
    dateJoined: formatDateJoined(entry.dateJoined),
  };
}

function requireEnv(name: string): string {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const COLUMNS: Array<{ header: string; width: number }> = [
  { header: "Email", width: 32 },
  { header: "Name", width: 28 },
  { header: "Country", width: 18 },
  { header: "City", width: 20 },
  { header: "Zipcode", width: 12 },
  { header: "Date joined", width: 14 },
];

async function main() {
  let args: ReturnType<typeof parseExportArgs>;
  try {
    args = parseExportArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.log("Churned-members export: READ-ONLY (no writes)");
  if (args.limit) console.log(`Census limit per Stripe listing: ${args.limit}`);
  console.log("");

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

  console.log("Computing Stripe churn census…");
  const census = await computeKlaviyoCensus({
    stripe,
    membershipPriceIds: allow,
    limit: args.limit,
  });
  console.log(`  active:   ${census.active.length}`);
  console.log(`  churned:  ${census.churned.length}\n`);

  console.log("Fetching Airtable members…");
  const { byCustomerId, byEmail } = await fetchMemberIndex(airtable);
  console.log(`  member rows read: ${byEmail.size} unique emails\n`);

  console.log("Fetching city/country catalogue…");
  const citiesById = await fetchCityCountries(airtable);
  console.log(`  city records: ${citiesById.size}\n`);

  const rows: ChurnedRow[] = [];
  let skippedNoMatch = 0;
  for (const membership of census.churned) {
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
    rows.push(resolveRow(membership, entry, citiesById));
  }
  rows.sort((a, b) => a.email.localeCompare(b.email));

  console.log("=== Export summary ===");
  console.log(`  churned rows: ${rows.length} (skipped no Airtable match: ${skippedNoMatch})`);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Churned");

  sheet.columns = COLUMNS.map((c) => ({
    header: c.header,
    key: c.header,
    width: c.width,
  }));
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    sheet.addRow({
      Email: row.email || null,
      Name: row.name || null,
      Country: row.country || null,
      City: row.city || null,
      Zipcode: row.zip || null,
      "Date joined": row.dateJoined || null,
    });
  }

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: COLUMNS.length },
  };

  mkdirSync(dirname(args.output), { recursive: true });
  await workbook.xlsx.writeFile(args.output);
  console.log(`\nXLSX written: ${args.output} (sheet: Churned, ${rows.length} rows)`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("export-churned-members.ts") ||
    process.argv[1].includes("export-churned-members"));

if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e : e);
    process.exit(1);
  });
}
