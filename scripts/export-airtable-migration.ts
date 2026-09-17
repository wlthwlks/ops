/**
 * READ-ONLY migration export of every USED Airtable table to a single .xlsx.
 *
 *   npm run airtable:export-migration
 *   npm run airtable:export-migration -- --output=tmp/custom.xlsx
 *
 * Scope rules:
 *   - Only tables and fields that are actually referenced in src/ or scripts/
 *     code are exported. Unused tables (INDUSTRIES, CITY WLKS) and deprecated
 *     ones (DONUT DATA — op registered deprecated/productionEnabled:false) are
 *     skipped, as are canonical fields with zero code references.
 *   - Matching/introduction-related columns are placed LAST within each sheet,
 *     and intro-related tables are the LAST sheets in the workbook.
 *
 * Records are read WITHOUT a fields[] projection (full paginated reads), so
 * fields that exist only in legacy scripts (e.g. MEMBERS "Country"/"Traction"/
 * "Days Active") simply come out blank when the live base lacks them.
 *
 * Requires: AIRTABLE_GET_DATA_TOKEN, AIRTABLE_BASE_ID.
 */
import * as dotenv from "dotenv";
import { mkdirSync } from "fs";
import { dirname } from "path";
import ExcelJS from "exceljs";
import { createAirtableClient, type AirtableRecord } from "../src/lib/integrations/airtable";
import { AIRTABLE_TABLES } from "../src/lib/airtable/schema";

dotenv.config();

const DEFAULT_OUTPUT = "tmp/airtable-migration-export.xlsx";

export function parseExportArgs(argv: string[]): { output: string } {
  let output = DEFAULT_OUTPUT;
  for (const arg of argv) {
    if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length).trim();
      if (!output) throw new Error("--output requires a path");
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run airtable:export-migration -- [--output=PATH]",
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

type TableSpec = {
  sheetName: string;
  tableName: string;
  intro: boolean;
  /** Used fields in export order; intro-related columns come last. */
  fields: string[];
  /** 0-based index of the first intro-related column (fields.length = none). */
  introFrom?: number;
  note?: string;
};

const TABLES: TableSpec[] = [
  {
    sheetName: "MEMBERS",
    tableName: AIRTABLE_TABLES.MEMBERS,
    intro: false,
    fields: [
      "Name",
      "email",
      "Slack Email",
      "First Name",
      "Last Name",
      "Age",
      "phone number",
      "Phone prefix",
      "post code",
      "City",
      "City relation",
      "Country",
      "Industry",
      "Revenue",
      "Traction",
      "Days Active",
      "Membership",
      "Payment",
      "Date joined",
      "Cancellation date",
      "Service access until",
      "Stripe Customer ID",
      "Memberstack ID",
      "Paid Plans (price ids)",
      "Stripe Subscription ID",
      "Stripe Price ID",
      "Memberstack Plan ID",
      "Stripe subscription status",
      "Cancel at period end",
      "Cancellation requested at",
      "Cancellation effective at",
      "Last invoice ID",
      "Last invoice status",
      "Billing last synced at",
      "Last Stripe event ID",
      "Billing pause until",
      "Onboarding status",
      "Last completed signup step",
      "Profile schema version",
      "Onboarding completed at",
      "Profile last updated at",
      "Timezone",
      "UTM Source",
      "UTM Medium",
      "UTM Campaign",
      "UTM Content",
      "UTM Term",
      "Google Click ID",
      "Facebook Click ID",
      "Initial landing page",
      "Initial referrer",
      "First attribution captured at",
      "Email suppression newsletter",
      "Email suppression churned",
      "Email suppression active",
      "Availability",
      "Availability v2",
      "Topics to Discuss",
      "Business stage",
      "Connection type",
      "Business description",
      "Current 90-day goal",
      "Goal updated at",
      "Help wanted",
      "Help wanted context",
      "Expertise",
      "Expertise context",
      "Recurring intro status",
      "Recurring pause until",
      "First introduction status",
      "First introduction sent at",
      "Recurring eligible from",
      "Business name",
      "Business website",
      "social media",
      "Professional Headline",
      "Profile Bio",
    ],
    introFrom: 56,
    note: "'Country', 'Traction', 'Days Active' are referenced only by legacy scripts and may be empty in the live base.",
  },
  {
    sheetName: "ALL CITIES",
    tableName: AIRTABLE_TABLES.ALL_CITIES,
    intro: false,
    fields: ["City", "Country", "Slack channels", "Form enabled", "City Tier"],
  },
  {
    sheetName: "COUNTRIES",
    tableName: AIRTABLE_TABLES.COUNTRIES,
    intro: false,
    fields: ["Name", "Active", "ALL CITIES"],
  },
  {
    sheetName: "Signups",
    tableName: "Signups",
    intro: false,
    fields: ["Status", "Name", "Email"],
  },
  {
    sheetName: "MATCH GROUPS",
    tableName: AIRTABLE_TABLES.MATCH_GROUPS,
    intro: true,
    fields: [
      "Member 1",
      "Introduction date",
      "Status",
      "Source",
      "Cycle ID",
      "Slack Channel",
      "Slack Conversation ID",
      "Slack Message Timestamp",
      "Send error",
    ],
  },
  {
    sheetName: "MATCHING OPTIONS",
    tableName: AIRTABLE_TABLES.MATCHING_OPTIONS,
    intro: true,
    fields: ["Name", "Type", "Category", "Kind", "Active", "Form enabled", "Status", "Option", "Label"],
  },
  {
    sheetName: "SLACK CHANNELS",
    tableName: AIRTABLE_TABLES.SLACK_CHANNELS,
    intro: true,
    fields: [
      "Name",
      "Cities",
      "Channel status/donut",
      "Slack Channel ID",
      "Timezone",
      "group size",
      "Intro type",
      "Strict group size",
      "Intro message template",
      "Intro frequency weeks",
      "Next introduction date",
      "Intro local time",
      "Scheduling mode",
      "Google Calendar enabled",
      "Outlook enabled",
      "Meeting duration minutes",
      "Auto schedule meeting",
    ],
    introFrom: 6,
  },
  {
    sheetName: "Introduction data",
    tableName: "Introduction data",
    intro: true,
    fields: ["Cycle ID", "Cities", "in channel", "introduced", "excluded", "intros made", "Intro date"],
  },
];

export function serializeCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((v) => serializeCell(v) ?? "").filter((v) => v !== "").join(", ") || null;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function rowValues(record: AirtableRecord, fields: string[]): Array<string | number | boolean | null> {
  const values: Array<string | number | boolean | null> = [];
  for (const field of fields) {
    values.push(serializeCell(record.fields[field]));
  }
  return values;
}

function columnWidth(values: Array<unknown>, min = 10, max = 42): number {
  let longest = min;
  for (const v of values) {
    const len = v === null || v === undefined ? 0 : String(v).length;
    if (len > longest) longest = len;
    if (longest >= max) return max;
  }
  return longest;
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

  console.log("Migration export: READ-ONLY (no writes to Airtable)");
  const airtable = createAirtableClient({
    apiKey: requireEnv("AIRTABLE_GET_DATA_TOKEN"),
    baseId: requireEnv("AIRTABLE_BASE_ID"),
  });

  const workbook = new ExcelJS.Workbook();
  const overviewSheet = workbook.addWorksheet("Overview");
  const overview: Array<{ sheet: string; table: string; rows: number; cols: number; intro: string; note: string }> = [];

  for (const spec of TABLES) {
    console.log(`Reading ${spec.tableName}…`);
    let records: AirtableRecord[] = [];
    let note = spec.note ?? "";
    try {
      records = await airtable.listRecords(spec.tableName);
      console.log(`  ${records.length} rows`);
    } catch (e) {
      const missing =
        e instanceof Error &&
        e.message.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND");
      if (missing) {
        note = [note, "Table not found in live base (403) — exported empty."].filter(Boolean).join(" ");
        console.log(`  table not found in live base — exporting empty sheet`);
      } else {
        throw e;
      }
    }

    const sheet = workbook.addWorksheet(spec.sheetName);
    const columns = ["Record ID", ...spec.fields];
    sheet.addRow(columns);
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };

    for (const record of records) {
      sheet.addRow([record.id, ...rowValues(record, spec.fields)]);
    }

    for (let i = 1; i <= columns.length; i++) {
      const col = sheet.getColumn(i);
      const values = records.map((r, idx) => sheet.getRow(idx + 2).getCell(i).value);
      col.width = columnWidth(values, 10, 42);
    }
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    overview.push({
      sheet: spec.sheetName,
      table: spec.tableName,
      rows: records.length,
      cols: columns.length,
      intro: spec.intro ? "yes" : "no",
      note,
    });
  }

  overviewSheet.addRow(["Sheet", "Airtable table", "Rows", "Columns", "Intro-related", "Notes"]);
  overviewSheet.getRow(1).font = { bold: true };
  for (const row of overview) {
    overviewSheet.addRow([row.sheet, row.table, row.rows, row.cols, row.intro, row.note]);
  }
  for (let i = 1; i <= 6; i++) {
    overviewSheet.getColumn(i).width = columnWidth(
      overview.map((r) => [r.sheet, r.table, r.rows, r.cols, r.intro, r.note][i - 1]),
      10,
      60
    );
  }
  overviewSheet.views = [{ state: "frozen", ySplit: 1 }];

  mkdirSync(dirname(args.output), { recursive: true });
  await workbook.xlsx.writeFile(args.output);

  console.log("\n=== Migration export summary ===");
  for (const row of overview) {
    console.log(`  ${row.sheet.padEnd(20)} rows=${String(row.rows).padStart(6)}  cols=${String(row.cols).padStart(3)}  intro=${row.intro}`);
  }
  console.log(`\nXLSX written: ${args.output}`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("export-airtable-migration.ts") ||
    process.argv[1].includes("export-airtable-migration"));

if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e : e);
    process.exit(1);
  });
}
