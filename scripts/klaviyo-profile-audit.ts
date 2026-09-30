/**
 * READ-ONLY audit of every Klaviyo profile, with an optional suppression step.
 *
 *   npm run klaviyo:audit-profiles                        # audit only (no writes)
 *   npm run klaviyo:audit-profiles -- --apply             # audit, then suppress unused
 *   npm run klaviyo:audit-profiles -- --limit=1000        # sanity run (cap the scan)
 *   npm run klaviyo:audit-profiles -- --delay-ms=500      # override throttle between pages
 *
 * "Used" profiles are those in the Active list (KLAVIYO_ACTIVE_LIST_ID) or the
 * Churned list (KLAVIYO_CHURNED_LIST_ID) — the two lists the membership sync
 * maintains. Everything else is "unused".
 *
 * For each profile we record Klaviyo's email-marketing consent, whether it is
 * suppressed, and Klaviyo's own `can_receive_email_marketing` flag (the closest
 * proxy to "billable"): a profile is only billable when Klaviyo can still email
 * it. Unused + billable profiles are the ones costing money.
 *
 * Audit output is written to tmp/klaviyo-unused-profiles.csv. `--apply` then
 * bulk-suppresses the unused + billable emails. Suppression removes profiles
 * from Klaviyo's active/billable count WITHOUT deleting them or their history.
 * Active and churned members are never touched.
 *
 * Rate limits: GET /api/profiles is 3/s burst and 60/min steady, so a full scan
 * of ~53k profiles takes ~9-10 minutes. The scan is throttled to stay under the
 * steady limit (see --delay-ms).
 */
import * as dotenv from "dotenv";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { createKlaviyoClient } from "../src/lib/integrations/klaviyo";

dotenv.config();

const DEFAULT_OUTPUT = "tmp/klaviyo-unused-profiles.csv";
const DEFAULT_DELAY_MS = 1050;

function requireEnv(name: string): string {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export function parseAuditArgs(argv: string[]): {
  apply: boolean;
  limit?: number;
  delayMs: number;
  output: string;
} {
  const apply = argv.includes("--apply");
  let limit: number | undefined;
  let delayMs = DEFAULT_DELAY_MS;
  let output = DEFAULT_OUTPUT;

  for (const arg of argv) {
    if (arg === "--apply") continue;
    if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --limit value: ${arg}`);
      limit = n;
    } else if (arg.startsWith("--delay-ms=")) {
      const n = parseInt(arg.slice("--delay-ms=".length), 10);
      if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid --delay-ms value: ${arg}`);
      delayMs = n;
    } else if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length).trim();
      if (!output) throw new Error(`Invalid --output value: ${arg}`);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run klaviyo:audit-profiles -- [--apply] [--limit=N] [--delay-ms=N] [--output=PATH]",
          "",
          "  --apply       suppress unused + billable profiles after the audit",
          "  --limit=N     cap the profile scan at N profiles (sanity runs)",
          "  --delay-ms=N  throttle between paginated reads (default 1050, to respect 60/min)",
          "  --output=PATH CSV path for the unused-profile report",
        ].join("\n")
      );
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return { apply, limit, delayMs, output };
}

async function main() {
  let args: ReturnType<typeof parseAuditArgs>;
  try {
    args = parseAuditArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.log(`Mode: ${args.apply ? "AUDIT + SUPPRESS" : "AUDIT ONLY (no writes)"}`);
  console.log(`Throttle: ${args.delayMs}ms/page  Limit: ${args.limit ?? "none"}\n`);

  let apiKey: string;
  let activeListId: string;
  let churnedListId: string;
  try {
    apiKey = requireEnv("KLAVIYO_PRIVATE_API_KEY");
    activeListId = requireEnv("KLAVIYO_ACTIVE_LIST_ID");
    churnedListId = requireEnv("KLAVIYO_CHURNED_LIST_ID");
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  const klaviyo = createKlaviyoClient({
    apiKey,
    revision: (process.env.KLAVIYO_API_REVISION || "").trim() || undefined,
  });

  console.log(`Fetching Active list (${activeListId}) members...`);
  const activeEmails = await klaviyo.listProfilesInList(activeListId, { delayMs: args.delayMs });
  console.log(`  active: ${activeEmails.size}`);

  console.log(`Fetching Churned list (${churnedListId}) members...`);
  const churnedEmails = await klaviyo.listProfilesInList(churnedListId, { delayMs: args.delayMs });
  console.log(`  churned: ${churnedEmails.size}\n`);

  console.log("Scanning all profiles (email-marketing state)...");
  const entries = await klaviyo.listAllProfilesForAudit({
    delayMs: args.delayMs,
    limit: args.limit,
    onPage: (_pageEntries, page) => {
      if (page % 50 === 0) {
        console.log(`  scanned ${page * 100} profiles (page ${page})`);
      }
    },
  });

  const unused = entries.filter(
    (e) => !activeEmails.has(e.email) && !churnedEmails.has(e.email)
  );
  const activeCount = entries.filter((e) => activeEmails.has(e.email)).length;
  const churnedCount = entries.filter((e) => churnedEmails.has(e.email)).length;
  const unusedBillable = unused.filter((e) => e.canReceiveEmailMarketing);
  const unusedSuppressed = unused.filter((e) => !e.canReceiveEmailMarketing);

  console.log("\n=== Audit summary ===");
  console.log(`  total profiles scanned: ${entries.length}`);
  console.log(`  active members:         ${activeCount}`);
  console.log(`  churned members:        ${churnedCount}`);
  console.log(`  UNUSED (total):         ${unused.length}`);
  console.log(`    unused + billable:    ${unusedBillable.length}  <-- suppress candidates`);
  console.log(`    unused + suppressed:  ${unusedSuppressed.length}`);

  const csvLines = [
    "email,bucket,consent,suppressed,can_receive_email_marketing",
    ...unused.map((e) =>
      [
        e.email,
        "unused",
        e.consent || "MISSING",
        e.suppressed ? "true" : "false",
        e.canReceiveEmailMarketing ? "true" : "false",
      ].join(",")
    ),
  ];
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, csvLines.join("\n") + "\n");
  console.log(`\nWrote ${unused.length} unused profiles to ${args.output}`);

  if (!args.apply) {
    console.log("\nAUDIT ONLY — no Klaviyo writes made. Pass --apply to suppress unused profiles.");
    return;
  }

  if (unusedBillable.length === 0) {
    console.log("\nNo unused billable profiles to suppress.");
    return;
  }

  console.log(`\nSuppressing ${unusedBillable.length} unused + billable profiles...`);
  const emails = unusedBillable.map((e) => e.email);
  const jobs = await klaviyo.suppressProfilesByEmail(emails, { delayMs: 200 });
  console.log(`  suppression jobs submitted: ${jobs.calls} (${jobs.requested} emails)`);
  await klaviyo.waitForSuppressionJobs(jobs.jobIds);
  console.log(`  done — ${jobs.requested} profiles suppressed (removed from billable count).`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("klaviyo-profile-audit.ts") ||
    process.argv[1].includes("klaviyo-profile-audit"));

if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e : e);
    process.exit(1);
  });
}
