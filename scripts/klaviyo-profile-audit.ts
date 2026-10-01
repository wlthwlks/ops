/**
 * READ-ONLY audit of every Klaviyo profile, with an optional suppression step.
 *
 *   npm run klaviyo:audit-profiles                        # audit only (no writes)
 *   npm run klaviyo:audit-profiles -- --apply             # audit, then suppress unused
 *   npm run klaviyo:audit-profiles -- --limit=1000        # sanity run (cap the scan)
 *   npm run klaviyo:audit-profiles -- --delay-ms=500      # override throttle between pages
 *   npm run klaviyo:audit-profiles -- --fresh             # ignore checkpoint, restart scan
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
 * Audit output is streamed to tmp/klaviyo-unused-profiles.csv. `--apply` then
 * bulk-suppresses the unused + billable emails. Suppression removes profiles
 * from Klaviyo's active/billable count WITHOUT deleting them or their history.
 * Active and churned members are never touched.
 *
 * Checkpoint/resume: the last page cursor + running counts are written to
 * <output>.checkpoint.json after every page, and the Active/Churned email sets
 * are cached to <output>.membership.json. If a run is interrupted (transient
 * network/empty-body glitches are retried, but a hard kill can still happen),
 * re-running the same command resumes from the checkpoint instead of rescanning
 * from zero. Pass --fresh to discard the checkpoint and start over.
 *
 * Rate limits: GET /api/profiles is 3/s burst and 60/min steady, so a full scan
 * of ~53k profiles takes ~9-10 minutes. The scan is throttled to stay under the
 * steady limit (see --delay-ms). Transient network/empty-body errors are retried.
 */
import * as dotenv from "dotenv";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { createKlaviyoClient } from "../src/lib/integrations/klaviyo";

dotenv.config();

const DEFAULT_OUTPUT = "tmp/klaviyo-unused-profiles.csv";
const DEFAULT_DELAY_MS = 1050;
const CSV_HEADER = "email,bucket,consent,suppressed,can_receive_email_marketing";

type Counts = {
  total: number;
  active: number;
  churned: number;
  unusedBillable: number;
  unusedSuppressed: number;
};

type Membership = { activeEmails: string[]; churnedEmails: string[] };
type Checkpoint = { cursor: string | null; counts: Counts };

function membershipPath(output: string): string {
  return `${output}.membership.json`;
}

function checkpointPath(output: string): string {
  return `${output}.checkpoint.json`;
}

function requireEnv(name: string): string {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function zeroCounts(): Counts {
  return { total: 0, active: 0, churned: 0, unusedBillable: 0, unusedSuppressed: 0 };
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

export function parseAuditArgs(argv: string[]): {
  apply: boolean;
  fresh: boolean;
  limit?: number;
  delayMs: number;
  output: string;
} {
  const apply = argv.includes("--apply");
  const fresh = argv.includes("--fresh");
  let limit: number | undefined;
  let delayMs = DEFAULT_DELAY_MS;
  let output = DEFAULT_OUTPUT;

  for (const arg of argv) {
    if (arg === "--apply" || arg === "--fresh") continue;
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
          "Usage: npm run klaviyo:audit-profiles -- [--apply] [--fresh] [--limit=N] [--delay-ms=N] [--output=PATH]",
          "",
          "  --apply       suppress unused + billable profiles after the audit",
          "  --fresh       discard any checkpoint and restart the scan from the beginning",
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

  return { apply, fresh, limit, delayMs, output };
}

function classify(
  entry: { email: string; consent: string; suppressed: boolean; canReceiveEmailMarketing: boolean },
  activeSet: Set<string>,
  churnedSet: Set<string>,
  counts: Counts
): string | null {
  counts.total++;
  if (activeSet.has(entry.email)) {
    counts.active++;
    return null;
  }
  if (churnedSet.has(entry.email)) {
    counts.churned++;
    return null;
  }
  if (entry.canReceiveEmailMarketing) counts.unusedBillable++;
  else counts.unusedSuppressed++;
  return [
    entry.email,
    "unused",
    entry.consent || "MISSING",
    entry.suppressed ? "true" : "false",
    entry.canReceiveEmailMarketing ? "true" : "false",
  ].join(",");
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
  console.log(`Throttle: ${args.delayMs}ms/page  Limit: ${args.limit ?? "none"}  Fresh: ${args.fresh}\n`);

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

  mkdirSync(dirname(args.output), { recursive: true });

  const mPath = membershipPath(args.output);
  const cPath = checkpointPath(args.output);
  const checkpoint = args.fresh ? null : readJson<Checkpoint>(cPath);

  let activeSet: Set<string>;
  let churnedSet: Set<string>;
  let startCursor: string | undefined;
  let counts: Counts;

  if (checkpoint) {
    const membership = readJson<Membership>(mPath);
    if (!membership) {
      console.error(
        `Checkpoint found but membership cache (${mPath}) is missing. Re-run with --fresh.`
      );
      process.exit(1);
    }
    activeSet = new Set(membership.activeEmails);
    churnedSet = new Set(membership.churnedEmails);
    startCursor = checkpoint.cursor ?? undefined;
    counts = checkpoint.counts;
    console.log(`Resuming from checkpoint — ${counts.total} profiles already scanned.\n`);
  } else {
    console.log(`Fetching Active list (${activeListId}) members...`);
    activeSet = await klaviyo.listProfilesInList(activeListId, { delayMs: args.delayMs });
    console.log(`  active: ${activeSet.size}`);

    console.log(`Fetching Churned list (${churnedListId}) members...`);
    churnedSet = await klaviyo.listProfilesInList(churnedListId, { delayMs: args.delayMs });
    console.log(`  churned: ${churnedSet.size}\n`);

    writeJsonAtomic(mPath, {
      activeEmails: [...activeSet],
      churnedEmails: [...churnedSet],
    });

    startCursor = undefined;
    counts = zeroCounts();
    writeFileSync(args.output, CSV_HEADER + "\n");
  }

  console.log("Scanning all profiles (email-marketing state)...");
  await klaviyo.listAllProfilesForAudit({
    delayMs: args.delayMs,
    limit: args.limit,
    startCursor,
    onPage: (pageEntries, page, nextCursor) => {
      const rows: string[] = [];
      for (const e of pageEntries) {
        const row = classify(e, activeSet, churnedSet, counts);
        if (row) rows.push(row);
      }
      if (rows.length) appendFileSync(args.output, rows.join("\n") + "\n");
      writeJsonAtomic(cPath, { cursor: nextCursor, counts });
      if (page % 50 === 0) {
        console.log(`  scanned ${counts.total} profiles (page ${page})`);
      }
    },
  });

  rmSync(cPath, { force: true });

  const unusedTotal = counts.unusedBillable + counts.unusedSuppressed;
  console.log("\n=== Audit summary ===");
  console.log(`  total profiles scanned: ${counts.total}`);
  console.log(`  active members:         ${counts.active}`);
  console.log(`  churned members:        ${counts.churned}`);
  console.log(`  UNUSED (total):         ${unusedTotal}`);
  console.log(`    unused + billable:    ${counts.unusedBillable}  <-- suppress candidates`);
  console.log(`    unused + suppressed:  ${counts.unusedSuppressed}`);
  console.log(`\nWrote ${unusedTotal} unused profiles to ${args.output}`);

  if (!args.apply) {
    console.log("\nAUDIT ONLY — no Klaviyo writes made. Pass --apply to suppress unused profiles.");
    return;
  }

  if (counts.unusedBillable === 0) {
    console.log("\nNo unused billable profiles to suppress.");
    return;
  }

  const emails = readFileSync(args.output, "utf8")
    .split("\n")
    .slice(1)
    .filter((line) => line.trim())
    .map((line) => line.split(","))
    .filter((cols) => cols[4] === "true")
    .map((cols) => cols[0]);

  console.log(`\nSuppressing ${emails.length} unused + billable profiles...`);
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
