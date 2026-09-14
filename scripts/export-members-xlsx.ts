/**
 * READ-ONLY export of SweatPals members to an .xlsx for external partners.
 *
 *   npm run members:export-xlsx
 *   npm run members:export-xlsx -- --limit=50
 *   npm run members:export-xlsx -- --output=tmp/custom.xlsx
 *
 * Membership status comes from Stripe (same census as the Klaviyo sync):
 *   - active:  qualifying active/trialing subscription (pause-guarded)
 *   - churned: qualifying subscription fully ended (status canceled) and no
 *     qualifying active/trialing subscription
 *
 * Each Stripe customer is joined to a MEMBERS row by Stripe Customer ID
 * (fallback: unique email). Customers with no matching Airtable record are
 * skipped. No writes are made to Airtable, Stripe, or Klaviyo.
 *
 * Columns: Email, Phone, First Name, Last Name,
 * Airtable record_id, Stripe customer_id, Current price_id, Country, City,
 * Date joined, Age, Status.
 *
 * Phone is a single merged column: prefix + number are combined, formatting
 * is stripped to digits, and numbers missing a country code are completed
 * from the Country column when possible (see normalizePhone).
 *
 * A second sheet "Data quality" reports missing values per column with live
 * formulas (COUNTBLANK / COUNTA / COUNTIF / SUMPRODUCT + FILTER spills listing
 * the members missing each field). A third sheet "Data quality (active)"
 * repeats the same report restricted to Stripe-active members, and a fourth
 * sheet "Missing phone (active)" shows the full table for active members with
 * a blank Phone. Formulas target Excel 365 / Google Sheets dynamic
 * arrays. If you sort or filter the Members sheet the reports recalculate
 * live; re-running this command regenerates a clean file.
 *
 * Requires: AIRTABLE_GET_DATA_TOKEN, AIRTABLE_BASE_ID, STRIPE_SECRET_KEY
 * (plus the billing-catalog price configuration).
 */
import * as dotenv from "dotenv";
import { mkdirSync } from "fs";
import { createRequire } from "node:module";
import { dirname } from "path";
import ExcelJS from "exceljs";
import { createAirtableClient, type AirtableRecord } from "../src/lib/integrations/airtable";
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
import { resolveCountryIso2 } from "../src/lib/forms/reference-data";

// libphonenumber-js's ESM entry is broken under tsx (metadata import assertion
// mismatch), so load the CJS core + metadata directly via createRequire.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const phoneCore: any = createRequire(import.meta.url)("libphonenumber-js/core");
const phoneMetadataRaw = createRequire(import.meta.url)("libphonenumber-js/metadata.max.json");
const phoneMetadata =
  phoneMetadataRaw && typeof phoneMetadataRaw === "object" && "default" in phoneMetadataRaw
    ? (phoneMetadataRaw as { default: unknown }).default
    : phoneMetadataRaw;

dotenv.config();

const DEFAULT_OUTPUT = "tmp/sweatpals-members-export.xlsx";

const MEMBER_EXPORT_FIELDS = [
  MEMBER_FIELDS.email,
  MEMBER_FIELDS.firstName,
  MEMBER_FIELDS.lastName,
  MEMBER_FIELDS.phone,
  MEMBER_FIELDS.phonePrefix,
  MEMBER_FIELDS.city,
  MEMBER_FIELDS.cityRelation,
  MEMBER_FIELDS.dateJoined,
  MEMBER_FIELDS.age,
  MEMBER_FIELDS.stripeCustomerId,
  MEMBER_FIELDS.stripePriceId,
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
          "Usage: npm run members:export-xlsx -- [--limit=N] [--output=PATH]",
          "",
          "  --limit=N     cap each Stripe census listing at N customers (sanity runs)",
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

export type MemberExportEntry = {
  record: AirtableRecord;
  email: string;
  phonePrefix: string;
  phoneNumber: string;
  firstName: string;
  lastName: string;
  city: string;
  cityRelationId: string;
  dateJoined: string;
  age: string;
  stripeCustomerId: string;
  stripePriceId: string;
};

/** Full field-projected read of MEMBERS indexed by email and Stripe Customer ID. */
async function fetchMemberIndex(
  airtable: ReturnType<typeof createAirtableClient>
): Promise<{
  byCustomerId: Map<string, MemberExportEntry>;
  byEmail: Map<string, MemberExportEntry[]>;
}> {
  const byCustomerId = new Map<string, MemberExportEntry>();
  const byEmail = new Map<string, MemberExportEntry[]>();

  const records = await airtable.listRecords("Members", {
    fields: [...MEMBER_EXPORT_FIELDS],
  });
  for (const record of records) {
    const entry: MemberExportEntry = {
      record,
      email: normalizeEmailForIndex(fieldStr(record.fields, MEMBER_FIELDS.email)),
      phonePrefix: fieldStr(record.fields, MEMBER_FIELDS.phonePrefix),
      phoneNumber: fieldStr(record.fields, MEMBER_FIELDS.phone),
      firstName: fieldStr(record.fields, MEMBER_FIELDS.firstName),
      lastName: fieldStr(record.fields, MEMBER_FIELDS.lastName),
      city: fieldStr(record.fields, MEMBER_FIELDS.city),
      cityRelationId: firstLinkId(record.fields[MEMBER_FIELDS.cityRelation]) ?? "",
      dateJoined: fieldStr(record.fields, MEMBER_FIELDS.dateJoined),
      age: fieldStr(record.fields, MEMBER_FIELDS.age),
      stripeCustomerId: fieldStr(record.fields, MEMBER_FIELDS.stripeCustomerId),
      stripePriceId: fieldStr(record.fields, MEMBER_FIELDS.stripePriceId),
    };
    if (entry.stripeCustomerId && !byCustomerId.has(entry.stripeCustomerId)) {
      byCustomerId.set(entry.stripeCustomerId, entry);
    }
    if (entry.email) {
      const list = byEmail.get(entry.email) ?? [];
      list.push(entry);
      byEmail.set(entry.email, list);
    }
  }

  return { byCustomerId, byEmail };
}

export type ExportRow = {
  email: string;
  phone: string;
  firstName: string;
  lastName: string;
  airtableRecordId: string;
  stripeCustomerId: string;
  priceId: string;
  country: string;
  city: string;
  dateJoined: string;
  age: string;
  status: "active" | "churned";
};

function digitsOnly(value: string): string {
  return (value || "").replace(/[^0-9]/g, "");
}

/**
 * Merge Airtable phone prefix + number into one international string:
 *   - blank number → ""
 *   - strips formatting (spaces/dashes/parens), keeps one leading "+"
 *   - "+…" numbers are kept as-is (already merged)
 *   - "00…" international format → "+…"
 *   - stored prefix → "+<prefix><digits>" (guards double prefix)
 *   - no prefix → completed from the Country column when resolvable
 *     (libphonenumber national parse with manual fallback)
 * Junk entries (all zeros, <5 digits) → "".
 */
export function normalizePhone(
  phonePrefix: string,
  phoneNumber: string,
  country: string
): string {
  const raw = (phoneNumber || "").trim();
  if (!raw) return "";

  const hasPlus = raw.startsWith("+");
  const digits = digitsOnly(raw);
  if (!/[1-9]/.test(digits) || digits.length < 5) return "";

  if (hasPlus) return `+${digits}`;
  if (digits.startsWith("00")) {
    const rest = digits.slice(2);
    if (/[1-9]/.test(rest) && rest.length >= 5) return `+${rest}`;
    return digits;
  }

  const prefixDigits = digitsOnly(phonePrefix);
  if (prefixDigits) {
    if (digits.startsWith(prefixDigits)) return `+${digits}`;
    return `+${prefixDigits}${digits}`;
  }

  // No stored prefix — complete from the Country column when possible.
  const iso2 = resolveCountryIso2(country);
  if (iso2) {
    let dialCode: string | null = null;
    try {
      dialCode = `+${phoneCore.getCountryCallingCode(iso2, phoneMetadata)}`;
    } catch {
      dialCode = null;
    }
    if (dialCode) {
      const dialDigits = dialCode.replace("+", "");
      try {
        const parsed = phoneCore.parsePhoneNumberFromString(digits, iso2, phoneMetadata);
        if (parsed && parsed.isValid()) return parsed.format("E.164");
      } catch {
        /* fall through to manual merge */
      }
      const stripped = digits.replace(/^0+/, "");
      if (stripped) {
        if (stripped.startsWith(dialDigits)) return `+${stripped}`;
        return `+${dialDigits}${stripped}`;
      }
    }
  }

  return digits;
}

function resolveCityCountry(
  entry: MemberExportEntry | undefined,
  citiesById: Map<string, { city: string; country: string }>
): { city: string; country: string } {
  if (!entry) return { city: "", country: "" };
  const linked = entry.cityRelationId ? citiesById.get(entry.cityRelationId) : undefined;
  if (linked) {
    return { city: linked.city || entry.city, country: linked.country };
  }
  return { city: entry.city, country: "" };
}

function buildRows(
  memberships: ActiveMembershipSubscription[],
  status: "active" | "churned",
  byCustomerId: Map<string, MemberExportEntry>,
  byEmail: Map<string, MemberExportEntry[]>,
  citiesById: Map<string, { city: string; country: string }>
): { rows: ExportRow[]; skippedNoMatch: number } {
  const rows: ExportRow[] = [];
  let skippedNoMatch = 0;

  for (const membership of memberships) {
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

    const email =
      extractStripeCustomerEmail(membership.customer) ?? entry.email;
    const { city, country } = resolveCityCountry(entry, citiesById);

    let firstName = entry.firstName;
    let lastName = entry.lastName;
    if (!firstName && !lastName) {
      const names = namesFromStripeCustomer(membership.customer, email);
      firstName = names.firstName;
      lastName = names.lastName;
    }

    rows.push({
      email,
      phone: normalizePhone(entry.phonePrefix, entry.phoneNumber, country),
      firstName,
      lastName,
      airtableRecordId: entry.record.id,
      stripeCustomerId: membership.stripeCustomerId,
      priceId: membership.priceIds[0] ?? entry.stripePriceId,
      country,
      city,
      dateJoined: formatDateJoined(entry.dateJoined),
      age: entry.age,
      status,
    });
  }

  return { rows, skippedNoMatch };
}

function requireEnv(name: string): string {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const COLUMNS: Array<{ header: string; key: keyof ExportRow; width: number }> = [
  { header: "Email", key: "email", width: 32 },
  { header: "Phone", key: "phone", width: 18 },
  { header: "First Name", key: "firstName", width: 16 },
  { header: "Last Name", key: "lastName", width: 16 },
  { header: "Airtable record_id", key: "airtableRecordId", width: 18 },
  { header: "Stripe customer_id", key: "stripeCustomerId", width: 22 },
  { header: "Current price_id", key: "priceId", width: 26 },
  { header: "Country", key: "country", width: 16 },
  { header: "City", key: "city", width: 16 },
  { header: "Date joined", key: "dateJoined", width: 12 },
  { header: "Age", key: "age", width: 8 },
  { header: "Status", key: "status", width: 10 },
];

async function writeXlsx(
  rows: ExportRow[],
  output: string,
  skipped: { active: number; churned: number }
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Members");

  sheet.columns = COLUMNS.map((c) => ({
    header: c.header,
    key: String(c.key),
    width: c.width,
  }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle" };

  for (const row of rows) {
    const values: Record<string, string | null> = {};
    for (const c of COLUMNS) values[String(c.key)] = row[c.key] === "" ? null : row[c.key];
    sheet.addRow(values);
  }

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  addDataQualitySheet(workbook, rows.length, {
    sheetName: "Data quality",
    title: "SweatPals members export — data quality report",
    activeOnly: false,
    skipped,
  });
  addDataQualitySheet(workbook, rows.length, {
    sheetName: "Data quality (active)",
    title: "SweatPals members export — data quality report (ACTIVE members)",
    activeOnly: true,
  });
  addMissingPhoneSheet(workbook, rows.length);

  mkdirSync(dirname(output), { recursive: true });
  await workbook.xlsx.writeFile(output);
}

/** Excel column letter for a 1-based column index (1 → A). */
function columnLetter(index: number): string {
  return String.fromCharCode(64 + index);
}

/** Row labels mirroring the Members sheet columns, same order as COLUMNS. */
const REPORT_FIELDS: Array<{ header: string; memberCol: number }> = COLUMNS.map(
  (c, i) => ({ header: c.header, memberCol: i + 1 })
);

/** Core fields included in the "rows missing ≥1 field" summary. */
const CORE_FIELD_COLS = [1, 2, 3, 4, 8, 9, 10, 11];

function addDataQualitySheet(
  workbook: ExcelJS.Workbook,
  rowCount: number,
  options: {
    sheetName: string;
    title: string;
    activeOnly: boolean;
    skipped?: { active: number; churned: number };
  }
): void {
  const report = workbook.addWorksheet(options.sheetName);
  const last = rowCount + 1;
  const range = (col: number) => `Members!$${columnLetter(col)}$2:$${columnLetter(col)}$${last}`;
  const statusCol = REPORT_FIELDS.find((f) => f.header === "Status")!.memberCol;
  const statusRange = range(statusCol);
  const activeCond = options.activeOnly ? `*(${statusRange}="active")` : "";

  for (const [i] of REPORT_FIELDS.entries()) {
    report.getColumn(i + 1).width = 24;
  }
  report.getColumn(REPORT_FIELDS.length + 1).width = 20;

  // ── Summary block ──
  report.getCell("A1").value = options.title;
  report.getCell("A1").font = { bold: true, size: 14 };

  report.getCell("A2").value = "Generated at";
  report.getCell("B2").value = new Date().toISOString();

  const coreBlanks = CORE_FIELD_COLS.map((col) => `(${range(col)}="")`).join("+");

  if (options.activeOnly) {
    report.getCell("A3").value = "Active members (Stripe)";
    report.getCell("B3").value = { formula: `COUNTIF(${statusRange},"active")` };

    report.getCell("A4").value = "Active rows missing ≥1 core field";
    report.getCell("B4").value = {
      formula: `SUMPRODUCT(--(((${coreBlanks})*(${statusRange}="active"))>0))`,
    };

    for (const r of [2, 3, 4]) {
      report.getCell(`A${r}`).font = { bold: true };
    }
  } else {
    report.getCell("A3").value = "Total members exported";
    report.getCell("B3").value = { formula: `COUNTA(${range(1)})` };

    report.getCell("A4").value = "Active";
    report.getCell("B4").value = { formula: `COUNTIF(${statusRange},"active")` };

    report.getCell("A5").value = "Churned";
    report.getCell("B5").value = { formula: `COUNTIF(${statusRange},"churned")` };

    report.getCell("A6").value = "Rows missing ≥1 core field";
    report.getCell("B6").value = {
      formula: `SUMPRODUCT(--((${coreBlanks})>0))`,
    };

    report.getCell("A7").value = "Skipped — no Airtable match (not in Members sheet)";
    report.getCell("B7").value = options.skipped
      ? `active: ${options.skipped.active} · churned: ${options.skipped.churned}`
      : "";

    for (const r of [2, 3, 4, 5, 6, 7]) {
      report.getCell(`A${r}`).font = { bold: true };
    }
  }

  // ── Per-column table (mirrors Members columns A–M) ──
  const HEADER_ROW = 9;
  const COUNT_ROW = HEADER_ROW + 1;
  const RATE_ROW = COUNT_ROW + 1;
  const LABEL_ROW = RATE_ROW + 1;
  const SPILL_ROW = LABEL_ROW + 1;

  for (const field of REPORT_FIELDS) {
    const cell = report.getCell(HEADER_ROW, field.memberCol);
    cell.value = field.header;
    cell.font = { bold: true };
    cell.border = { bottom: { style: "thin" } };
  }
  report.getCell(HEADER_ROW, REPORT_FIELDS.length + 1).value = "";

  for (const field of REPORT_FIELDS) {
    const countCell = report.getCell(COUNT_ROW, field.memberCol);
    countCell.value = options.activeOnly
      ? { formula: `SUMPRODUCT((${range(field.memberCol)}="")*(${statusRange}="active"))` }
      : { formula: `COUNTBLANK(${range(field.memberCol)})` };
    countCell.border = { bottom: { style: "hair" } };

    const rateCell = report.getCell(RATE_ROW, field.memberCol);
    rateCell.value = { formula: `IF($B$3=0,"",1-${columnLetter(field.memberCol)}${COUNT_ROW}/$B$3)` };
    rateCell.numFmt = "0.0%";
  }
  report.getCell(COUNT_ROW, REPORT_FIELDS.length + 1).value = "Missing count";
  report.getCell(RATE_ROW, REPORT_FIELDS.length + 1).value = "Fill rate";
  report.getCell(COUNT_ROW, REPORT_FIELDS.length + 1).font = { bold: true };
  report.getCell(RATE_ROW, REPORT_FIELDS.length + 1).font = { bold: true };

  report.mergeCells(LABEL_ROW, 1, LABEL_ROW, REPORT_FIELDS.length);
  const labelCell = report.getCell(LABEL_ROW, 1);
  labelCell.value = options.activeOnly
    ? "ACTIVE members missing this field ↓  (emails; Airtable record_ids under the Email column)"
    : "Members missing this field ↓  (emails; Airtable record_ids under the Email column)";
  labelCell.font = { italic: true, color: { argb: "FF808080" } };

  // ── Spills listing the members missing each column ──
  const recordIdCol = REPORT_FIELDS.find((f) => f.header === "Airtable record_id")!.memberCol;
  for (const field of REPORT_FIELDS) {
    // Identifier is email, except for the Email column itself → record_id.
    const idCol = field.memberCol === 1 ? recordIdCol : 1;
    const cond = `(${range(field.memberCol)}="")${activeCond}`;
    const formula = `IFERROR(FILTER(${range(idCol)},${cond}),"")`;
    report.getCell(SPILL_ROW, field.memberCol).value = { formula };
  }
}

/**
 * "Missing phone (active)" sheet — the full Members table (all columns)
 * but only Stripe-active members whose Phone cell is blank, via a
 * single live FILTER spill.
 */
function addMissingPhoneSheet(workbook: ExcelJS.Workbook, rowCount: number): void {
  const sheet = workbook.addWorksheet("Missing phone (active)");
  const last = rowCount + 1;
  const range = (col: number) => `Members!$${columnLetter(col)}$2:$${columnLetter(col)}$${last}`;

  const phoneCol = REPORT_FIELDS.find((f) => f.header === "Phone")!.memberCol;
  const statusCol = REPORT_FIELDS.find((f) => f.header === "Status")!.memberCol;
  const tableRange = `Members!$A$2:$${columnLetter(REPORT_FIELDS.length)}$${last}`;
  const cond = `(${range(phoneCol)}="")*(${range(statusCol)}="active")`;

  sheet.getCell("A1").value = "Active members missing phone numbers";
  sheet.getCell("A1").font = { bold: true, size: 14 };

  sheet.getCell("A2").value = "Generated at";
  sheet.getCell("A2").font = { bold: true };
  sheet.getCell("B2").value = new Date().toISOString();

  sheet.getCell("A3").value = "Members in this sheet";
  sheet.getCell("A3").font = { bold: true };
  sheet.getCell("B3").value = { formula: `SUMPRODUCT(--(${cond}))` };

  const HEADER_ROW = 5;
  const SPILL_ROW = HEADER_ROW + 1;

  for (const [i, field] of REPORT_FIELDS.entries()) {
    sheet.getColumn(i + 1).width = COLUMNS[i].width;
    const cell = sheet.getCell(HEADER_ROW, field.memberCol);
    cell.value = field.header;
    cell.font = { bold: true };
    cell.border = { bottom: { style: "thin" } };
  }

  sheet.getCell(SPILL_ROW, 1).value = {
    formula: `IFERROR(FILTER(${tableRange},${cond}),"")`,
  };
  sheet.views = [{ state: "frozen", ySplit: HEADER_ROW }];
}

async function main() {
  let args: ReturnType<typeof parseExportArgs>;
  try {
    args = parseExportArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.log("Export mode: READ-ONLY (no Airtable/Stripe/Klaviyo writes)");
  if (args.limit) console.log(`Census limit per Stripe listing: ${args.limit}`);
  console.log("");

  const airtableToken = requireEnv("AIRTABLE_GET_DATA_TOKEN");
  const airtableBaseId = requireEnv("AIRTABLE_BASE_ID");

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
    apiKey: airtableToken,
    baseId: airtableBaseId,
  });

  console.log("Computing Stripe census (active+trialing / canceled)...");
  const census = await computeKlaviyoCensus({
    stripe,
    membershipPriceIds: allow,
    limit: args.limit,
  });
  console.log(`  active:   ${census.active.length}`);
  console.log(`  churned:  ${census.churned.length}\n`);

  console.log("Fetching Airtable members...");
  const { byCustomerId, byEmail } = await fetchMemberIndex(airtable);
  console.log(`  member rows read: ${byEmail.size} unique emails\n`);

  console.log("Fetching city/country catalogue...");
  const citiesById = await fetchCityCountries(airtable);
  console.log(`  city records: ${citiesById.size}\n`);

  const active = buildRows(census.active, "active", byCustomerId, byEmail, citiesById);
  const churned = buildRows(census.churned, "churned", byCustomerId, byEmail, citiesById);

  const rows = [...active.rows, ...churned.rows];
  console.log("=== Export summary ===");
  console.log(`  active rows:      ${active.rows.length} (skipped no Airtable match: ${active.skippedNoMatch})`);
  console.log(`  churned rows:     ${churned.rows.length} (skipped no Airtable match: ${churned.skippedNoMatch})`);
  console.log(`  total rows:       ${rows.length}`);

  await writeXlsx(rows, args.output, {
    active: active.skippedNoMatch,
    churned: churned.skippedNoMatch,
  });
  console.log(
    `\nXLSX written: ${args.output} (sheets: Members + Data quality + Data quality (active) + Missing phone (active))`
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("export-members-xlsx.ts") ||
    process.argv[1].includes("export-members-xlsx"));

if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e : e);
    process.exit(1);
  });
}
