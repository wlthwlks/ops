/**
 * Optional dry-run migration: split legacy help/expertise codes out of context text.
 * Default is dry-run. Do not pass --apply in automated agents.
 *
 *   npx tsx scripts/migrate-matching-preferences.ts --dry-run
 *   npx tsx scripts/migrate-matching-preferences.ts --apply
 */
import "dotenv/config";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { MEMBER_FIELDS, MEMBERS_TABLE } from "../src/lib/ops/airtable-fields";

const LEGACY_HELP = new Set([
  "GROWTH_MARKETING",
  "SALES",
  "PRODUCT",
  "FUNDRAISING",
  "OPERATIONS",
  "HIRING",
  "FINANCE",
  "TECHNOLOGY",
  "MINDSET",
  "NETWORKING",
]);
const LEGACY_EXP = new Set([
  "GROWTH_MARKETING",
  "SALES",
  "PRODUCT",
  "FUNDRAISING",
  "OPERATIONS",
  "HIRING",
  "FINANCE",
  "TECHNOLOGY",
  "LEADERSHIP",
  "INDUSTRY_KNOWLEDGE",
]);

function parse(context: string, known: Set<string>) {
  const parts = context
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const codes: string[] = [];
  const prose: string[] = [];
  for (const p of parts) {
    if (known.has(p)) codes.push(p);
    else prose.push(p);
  }
  return { codes, prose: prose.join(", ") };
}

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;
  console.log(dryRun ? "DRY RUN (no writes)" : "APPLY mode — writing Airtable");

  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    console.error("Missing AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID");
    process.exit(1);
  }

  const airtable = createAirtableClient({ apiKey: token, baseId });
  const rows = await airtable.listRecords(MEMBERS_TABLE, {
    fields: [
      MEMBER_FIELDS.email,
      MEMBER_FIELDS.helpWanted,
      MEMBER_FIELDS.helpWantedContext,
      MEMBER_FIELDS.expertise,
      MEMBER_FIELDS.expertiseContext,
    ],
  });

  let candidates = 0;
  for (const r of rows) {
    const helpLinks = Array.isArray(r.fields[MEMBER_FIELDS.helpWanted])
      ? (r.fields[MEMBER_FIELDS.helpWanted] as unknown[])
      : [];
    const expLinks = Array.isArray(r.fields[MEMBER_FIELDS.expertise])
      ? (r.fields[MEMBER_FIELDS.expertise] as unknown[])
      : [];
    const helpCtx = fieldStr(r.fields, MEMBER_FIELDS.helpWantedContext);
    const expCtx = fieldStr(r.fields, MEMBER_FIELDS.expertiseContext);

    const helpParsed = helpLinks.length === 0 ? parse(helpCtx, LEGACY_HELP) : null;
    const expParsed = expLinks.length === 0 ? parse(expCtx, LEGACY_EXP) : null;

    const patch: Record<string, unknown> = {};
    if (helpParsed && helpParsed.codes.length) {
      // Legacy static codes cannot become linked records without MATCHING OPTIONS map.
      // Clean prose only; leave codes documented in dry-run output.
      patch[MEMBER_FIELDS.helpWantedContext] = helpParsed.prose;
      console.log(
        `  ${r.id} help legacy codes: ${helpParsed.codes.join(", ")} → context prose cleaned`
      );
      candidates++;
    }
    if (expParsed && expParsed.codes.length) {
      patch[MEMBER_FIELDS.expertiseContext] = expParsed.prose;
      console.log(
        `  ${r.id} expertise legacy codes: ${expParsed.codes.join(", ")} → context prose cleaned`
      );
      candidates++;
    }

    if (!dryRun && Object.keys(patch).length) {
      await airtable.updateRecords(MEMBERS_TABLE, [{ id: r.id, fields: patch }], {
        typecast: true,
      });
    }
  }

  console.log(`\nCandidates touched: ${candidates}`);
  if (dryRun) console.log("Re-run with --apply to write (manual only).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
