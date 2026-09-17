/**
 * Export the last 30 members with only the columns collected during the
 * signup process (widget steps: account, location, business, payment,
 * goal, help, expertise, connection + attribution captured at signup).
 * Usage: npx tsx scripts/export-last-30-signups.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { MEMBERS_TABLE } from "../src/lib/ops/airtable-fields";

dotenv.config();

const SIGNUP_COLUMNS = [
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
  "Other industry",
  "Business stage",
  "Revenue",
  "Business description",
  "social media",
  "Current 90-day goal",
  "Help wanted",
  "Help wanted context",
  "Expertise",
  "Expertise context",
  "Connection type",
  "Membership",
  "Payment",
  "Stripe Customer ID",
  "Onboarding status",
  "Last completed signup step",
  "Date joined",
  "Memberstack ID",
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
] as const;

function cellValue(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) {
    return v.map((item) => (item && typeof item === "object" ? String(item) : String(item))).join("; ");
  }
  return String(v);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function dateKey(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
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
    filterByFormula: `OR({Onboarding status} = "COMPLETE", {Onboarding status} = "COMPLETED")`,
    fields: [...SIGNUP_COLUMNS],
    maxRecords: 100,
  });

  const sorted = [...records].sort((a, b) => {
    const ja = dateKey(cellValue(a.fields, "Date joined"));
    const jb = dateKey(cellValue(b.fields, "Date joined"));
    if (ja !== jb) return jb - ja;
    return String(b.createdTime || "").localeCompare(String(a.createdTime || ""));
  });

  const last30 = sorted.slice(0, 30);

  const header = SIGNUP_COLUMNS.map(csvEscape).join(",");
  const rows = last30.map((r) =>
    SIGNUP_COLUMNS.map((c) => csvEscape(cellValue(r.fields, c))).join(",")
  );

  const outPath = path.join(process.cwd(), "tmp", "last-30-members-signup.csv");
  fs.writeFileSync(outPath, [header, ...rows].join("\n") + "\n", "utf8");

  console.log(`Exported ${last30.length} member(s) to ${outPath}`);
  console.log(`Columns (${SIGNUP_COLUMNS.length}): ${SIGNUP_COLUMNS.join(", ")}`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
