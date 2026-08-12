/**
 * Read-only audit of Airtable MEMBERS duplicate / identity-conflict state.
 *
 * Reports (does NOT modify):
 *   - duplicate normalized emails (more than one row with same LOWER(email))
 *   - duplicate Memberstack IDs (more than one row with same Memberstack ID)
 *   - conflicting identities (same email but different non-empty Memberstack IDs)
 *   - rows whose Memberstack ID is blank
 *   - lock rows in `signup_member_creations` that are stuck in CREATING/FAILED
 *
 * Usage:
 *   npx tsx scripts/audit-airtable-member-duplicates.ts                # full audit
 *   npx tsx scripts/audit-airtable-member-duplicates.ts --no-airtable   # DB only
 *
 * The script never writes to Airtable or Postgres.
 */
import * as dotenv from "dotenv";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { MEMBER_FIELDS, MEMBERS_TABLE } from "../src/lib/ops/airtable-fields";
import { normalizeEmailStrict, maskEmail } from "../src/lib/billing/reconcile-stripe-customers";
import { db } from "../src/db";
import { signupMemberCreations } from "../src/db/schema";

interface RawMember {
  id: string;
  email: string;
  memberstackId: string;
  createdTime?: string;
}

function summaryRow(label: string, value: string | number) {
  console.log(`  ${label.padEnd(40)} ${value}`);
}

async function auditAirtable(): Promise<void> {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    console.error("Missing AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID");
    process.exit(1);
  }
  const client = createAirtableClient({ apiKey: token, baseId });

  console.log("\n=== Airtable MEMBERS duplicate audit (read-only) ===\n");

  const records = await client.listRecords(MEMBERS_TABLE, {
    fields: [
      MEMBER_FIELDS.email,
      MEMBER_FIELDS.memberstackId,
      "Created Time",
    ] as unknown as string[],
    // No filterByFormula — we need to see ALL rows to detect duplicates.
    // Airtable paginates internally; listRecords handles iteration.
  });

  const fieldStr = (
    f: Record<string, unknown>,
    key: string
  ): string => {
    const v = f[key];
    if (v == null) return "";
    if (Array.isArray(v)) return String(v[0] ?? "").trim();
    return String(v).trim();
  };

  const members: RawMember[] = records.map((r) => ({
    id: r.id,
    email: normalizeEmailStrict(fieldStr(r.fields as Record<string, unknown>, MEMBER_FIELDS.email)),
    memberstackId: fieldStr(r.fields as Record<string, unknown>, MEMBER_FIELDS.memberstackId),
  }));

  const byEmail = new Map<string, RawMember[]>();
  const byMsId = new Map<string, RawMember[]>();
  const blankMsId: RawMember[] = [];
  for (const m of members) {
    if (m.email) {
      const list = byEmail.get(m.email) ?? [];
      list.push(m);
      byEmail.set(m.email, list);
    }
    if (m.memberstackId) {
      const list = byMsId.get(m.memberstackId) ?? [];
      list.push(m);
      byMsId.set(m.memberstackId, list);
    } else {
      blankMsId.push(m);
    }
  }

  const dupEmails = [...byEmail.entries()].filter(([, list]) => list.length > 1);
  const dupMsIds = [...byMsId.entries()].filter(([, list]) => list.length > 1);

  // Identity conflicts: an email has rows with DIFFERENT non-empty Memberstack IDs.
  const identityConflicts: Array<{
    emailMasked: string;
    airtableIds: string[];
    memberstackIds: string[];
  }> = [];
  for (const [email, list] of byEmail.entries()) {
    const distinctMsIds = new Set(
      list.map((m) => m.memberstackId).filter(Boolean)
    );
    if (distinctMsIds.size > 1) {
      identityConflicts.push({
        emailMasked: maskEmail(email),
        airtableIds: list.map((m) => m.id),
        memberstackIds: list.map((m) => m.memberstackId),
      });
    }
  }

  summaryRow("Total Airtable member rows", members.length);
  summaryRow("Rows with blank Memberstack ID", blankMsId.length);
  summaryRow("Duplicate normalized emails", dupEmails.length);
  summaryRow("Duplicate Memberstack IDs", dupMsIds.length);
  summaryRow("Identity conflicts (email <> multiple MS IDs)", identityConflicts.length);

  if (dupEmails.length > 0) {
    console.log("\n  --- duplicate normalized emails ---");
    for (const [email, list] of dupEmails.slice(0, 50)) {
      console.log(
        `  ${maskEmail(email)}  rows=${list.length}  ids=${list
          .map((m) => m.id)
          .join(",")}`
      );
    }
    if (dupEmails.length > 50) console.log(`  ... and ${dupEmails.length - 50} more`);
  }

  if (dupMsIds.length > 0) {
    console.log("\n  --- duplicate Memberstack IDs ---");
    for (const [msId, list] of dupMsIds.slice(0, 50)) {
      console.log(
        `  ${msId}  rows=${list.length}  ids=${list.map((m) => m.id).join(",")}`
      );
    }
    if (dupMsIds.length > 50) console.log(`  ... and ${dupMsIds.length - 50} more`);
  }

  if (identityConflicts.length > 0) {
    console.log("\n  --- identity conflicts (email owned by >1 MS ID) ---");
    for (const c of identityConflicts.slice(0, 50)) {
      console.log(
        `  ${c.emailMasked}  airtableIds=${c.airtableIds.join(",")}  msIds=${c.memberstackIds.join(",")}`
      );
    }
    if (identityConflicts.length > 50)
      console.log(`  ... and ${identityConflicts.length - 50} more`);
  }

  if (blankMsId.length > 0) {
    console.log("\n  --- rows with blank Memberstack ID (recovery candidates) ---");
    for (const m of blankMsId.slice(0, 20)) {
      console.log(`  airtableId=${m.id}  email=${maskEmail(m.email)}`);
    }
    if (blankMsId.length > 20)
      console.log(`  ... and ${blankMsId.length - 20} more`);
  }
}

async function auditLocks(): Promise<void> {
  console.log("\n=== signup_member_creations lock state (read-only) ===\n");

  let total = 0;
  let creating = 0;
  let created = 0;
  let failed = 0;
  const stuck: Array<{ memberstackId: string; status: string; updatedAt: string }> = [];

  try {
    const rows = await db
      .select({
        memberstackId: signupMemberCreations.memberstackId,
        emailNormalized: signupMemberCreations.emailNormalized,
        status: signupMemberCreations.status,
        airtableRecordId: signupMemberCreations.airtableRecordId,
        updatedAt: signupMemberCreations.updatedAt,
      })
      .from(signupMemberCreations);
    total = rows.length;
    for (const r of rows) {
      if (r.status === "CREATING") {
        creating++;
        const ageMs = r.updatedAt ? Date.now() - r.updatedAt.getTime() : Infinity;
        if (ageMs > 120_000) {
          stuck.push({
            memberstackId: r.memberstackId,
            status: r.status,
            updatedAt: r.updatedAt ? r.updatedAt.toISOString() : "null",
          });
        }
      } else if (r.status === "CREATED") created++;
      else if (r.status === "FAILED") failed++;
    }
  } catch (e) {
    console.log(`  (Could not read signup_member_creations: ${(e as Error).message})`);
    return;
  }

  summaryRow("Total lock rows", total);
  summaryRow("In CREATING", creating);
  summaryRow("In CREATED", created);
  summaryRow("In FAILED", failed);
  summaryRow("Stuck CREATING (age > 2 min)", stuck.length);

  if (stuck.length > 0) {
    console.log("\n  --- stuck CREATING lock rows ---");
    for (const s of stuck.slice(0, 50)) {
      console.log(`  ms_id=${s.memberstackId}  status=${s.status}  updated=${s.updatedAt}`);
    }
  }
}

async function main() {
  dotenv.config();
  const noAirtable = process.argv.includes("--no-airtable");
  if (!noAirtable) await auditAirtable();
  await auditLocks();
  console.log("\nAudit complete — read-only, no rows were modified.\n");
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});