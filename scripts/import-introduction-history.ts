/**
 * Import historical Airtable Match-groups into the Postgres introduction ledger.
 *
 * Usage:
 *   npx tsx scripts/import-introduction-history.ts          (live import)
 *   npx tsx scripts/import-introduction-history.ts --dry-run (preview only)
 *
 * Reads existing Match-groups records from Airtable, resolves linked
 * Member records, and creates idempotent legacy introduction runs, groups
 * and members in Postgres.
 */
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { db } from "@/db";
import { introductionRuns } from "@/db/schema/introduction-runs";
import { introductionGroups } from "@/db/schema/introduction-groups";
import { introductionGroupMembers } from "@/db/schema/introduction-group-members";
import { eq } from "drizzle-orm";
import * as dotenv from "dotenv";

dotenv.config();

const BATCH_SIZE = 50;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateFingerprint(recordId: string, memberIds: string[]): string {
  const sorted = [...memberIds].sort();
  return `at-matchgroup-${recordId}-${sorted.join(",")}`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("🔍 DRY RUN — no writes will be performed\n");

  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!token || !baseId) {
    console.error("Missing AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID in .env");
    process.exit(1);
  }

  const airtable = createAirtableClient({ apiKey: token, baseId });

  // 1. Fetch existing fingerprints to skip already-imported records
  console.log("Checking existing imports...");
  const existingGroups = await db
    .select({ fp: introductionGroups.groupFingerprint })
    .from(introductionGroups)
    .where(eq(introductionGroups.source, "recurring"));
  const existingFingerprints = new Set(existingGroups.map((r) => r.fp));
  console.log(`  Found ${existingFingerprints.size} existing imported groups`);

  // 2. Fetch Members from Airtable for email resolution
  console.log("\nFetching Airtable Members for email resolution...");
  const memberRecords = await airtable.listRecords("Members", {
    fields: ["Name", "email", "Slack Email"],
  });
  const idToEmail = new Map<string, string>();
  const idToName = new Map<string, string>();
  for (const mr of memberRecords) {
    const email = normalizeEmail(String(mr.fields["Slack Email"] || mr.fields["email"] || ""));
    if (email) idToEmail.set(mr.id, email);
    idToName.set(mr.id, String(mr.fields["Name"] || ""));
  }
  console.log(`  Resolved ${idToEmail.size} member emails from ${memberRecords.length} records`);

  // 3. Fetch Match-groups from Airtable
  console.log("\nFetching Match-groups from Airtable...");
  const matchGroupRecords = await airtable.listRecords("Match groups", {
    fields: [
      "Member 1", "Introduction date", "Status", "Source",
      "Cycle ID", "Slack Channel", "Slack Conversation ID", "Slack Message Timestamp",
    ],
    filterByFormula: '{Status} = "Done/Sent"',
  });
  console.log(`  Fetched ${matchGroupRecords.length} Done/Sent Match-groups`);

  // 4. Process in batches
  let importedCount = 0;
  let skippedCount = 0;
  let totalMemberEmails = 0;

  for (let bi = 0; bi < matchGroupRecords.length; bi += BATCH_SIZE) {
    const batch = matchGroupRecords.slice(bi, bi + BATCH_SIZE);

    for (const rec of batch) {
      const member1Field = rec.fields["Member 1"];
      if (!Array.isArray(member1Field) || member1Field.length < 2) {
        skippedCount++;
        continue;
      }

      const memberAirtableIds = member1Field.map(String).filter(Boolean);
      const fingerprint = generateFingerprint(rec.id, memberAirtableIds);

      if (existingFingerprints.has(fingerprint)) {
        skippedCount++;
        continue;
      }

      const memberEmails = memberAirtableIds
        .map((id) => idToEmail.get(id))
        .filter((e): e is string => Boolean(e));

      if (dryRun) {
        console.log(
          `  [DRY RUN] Import: ${memberAirtableIds.length} members, ` +
          `${memberEmails.length} emails resolved, date=${rec.fields["Introduction date"]}`
        );
        importedCount++;
        continue;
      }

      // Create legacy run
      const runId = `legacy-${rec.id}`;
      await db
        .insert(introductionRuns)
        .values({
          id: runId,
          requestId: `legacy-import-${rec.id}`,
          source: "recurring",
          cycleDate: typeof rec.fields["Introduction date"] === "string"
            ? rec.fields["Introduction date"]
            : null,
          mode: "send",
          dryRun: false,
          status: "completed",
          summary: `Legacy import: ${memberAirtableIds.length} members`,
          completedAt: new Date(),
        })
        .onConflictDoNothing();

      // Create group
      const groupId = `legacy-group-${rec.id}`;
      const cycleId = String(rec.fields["Cycle ID"] || "");
      const slackChannelRaw = rec.fields["Slack Channel"];
      const slackChannelId = Array.isArray(slackChannelRaw)
        ? String(slackChannelRaw[0] || "")
        : String(slackChannelRaw || "");

      await db
        .insert(introductionGroups)
        .values({
          id: groupId,
          runId,
          source: "recurring",
          cycleId: cycleId || null,
          groupFingerprint: fingerprint,
          deliveryKey: `legacy-${rec.id}`,
          status: "sent",
          slackConversationId: String(rec.fields["Slack Conversation ID"] || "") || null,
          slackMessageTs: String(rec.fields["Slack Message Timestamp"] || "") || null,
          channelRecordId: slackChannelId || null,
          attemptCount: 1,
          sentAt: typeof rec.fields["Introduction date"] === "string"
            ? new Date(rec.fields["Introduction date"])
            : undefined,
        })
        .onConflictDoNothing();

      // Create group members
      for (const atId of memberAirtableIds) {
        const email = idToEmail.get(atId) || "";
        await db
          .insert(introductionGroupMembers)
          .values({
            id: `legacy-gm-${rec.id}-${atId}`,
            groupId,
            airtableRecordId: atId,
            emailSnapshot: email,
            role: "recurring",
          })
          .onConflictDoNothing();
        if (email && !dryRun) totalMemberEmails++;
      }

      importedCount++;
      console.log(
        `  Imported: ${idToName.get(memberAirtableIds[0]) || "?"} + ` +
        `${memberAirtableIds.length - 1} others (${rec.fields["Introduction date"]})`
      );
    }
  }

  console.log(`\n${dryRun ? "[DRY RUN] " : ""}Done:`);
  console.log(`  Imported: ${importedCount} groups`);
  console.log(`  Skipped:  ${skippedCount} groups (already existed or <2 members)`);
  console.log(`  Members:  ${totalMemberEmails} member emails indexed`);
  console.log(`  Total Match-groups: ${matchGroupRecords.length}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
