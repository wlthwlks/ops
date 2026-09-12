/**
 * SweatPals → Airtable membership reconciliation (access gating).
 *
 * SweatPals is the billing source of truth. For every member with SweatPals
 * linkage (rows in `sweatpals_memberships`), re-fetch membership state via the
 * SweatPals external API (lookup-only) and mirror the derived state to the
 * Airtable billing columns. NEVER creates Airtable members. NEVER modifies
 * SweatPals.
 *
 * Default: dry-run (zero Airtable writes). Writes require explicit --apply.
 *
 * Apply mode is resumable: progress is checkpointed to
 * reports/sweatpals-reconcile-progress.json after every member; re-running
 * --apply resumes (skips processed members, retries failed ones). --reset
 * starts over.
 *
 * Usage:
 *   npm run sweatpals:reconcile                    (dry-run)
 *   npm run sweatpals:reconcile -- --limit=50
 *   npm run sweatpals:reconcile -- --email=member@example.com
 *   npm run sweatpals:reconcile -- --apply
 *   npm run sweatpals:reconcile -- --apply --reset
 */
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { reconcileSweatpalsMember } from "../src/lib/forms/sweatpals/verify-membership";
import {
  listSweatpalsReconcileKeys,
  type SweatpalsReconcileKey,
} from "../src/lib/forms/sweatpals/reconcile";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

const REPORTS_DIR = path.join(process.cwd(), "reports");
const CHECKPOINT_FILE = path.join(REPORTS_DIR, "sweatpals-reconcile-progress.json");
const REPORT_FILE = path.join(REPORTS_DIR, "sweatpals-reconcile-report.json");
const GAP_MS = 200;

type CheckpointStatus = "written" | "unchanged" | "unresolved" | "api_error" | "failed";

type Checkpoint = {
  runId: string;
  mode: "apply";
  startedAt: string;
  updatedAt: string;
  status: "in_progress" | "complete";
  totals: { scanned: number; written: number; failed: number };
  done: Record<string, CheckpointStatus>;
};

function parseArgs(argv: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [key, val] = arg.slice(2).split("=");
      opts[key] = val ?? "true";
    }
  }
  return opts;
}

function keyFor(k: SweatpalsReconcileKey): string {
  return k.email || k.phone || k.memberId || "unknown";
}

function loadCheckpoint(): Checkpoint | null {
  try {
    const raw = fs.readFileSync(CHECKPOINT_FILE, "utf8");
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  cp.updatedAt = new Date().toISOString();
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

type Category =
  | "active_ok"
  | "paused"
  | "inactive_revoked"
  | "unresolved"
  | "api_error"
  | "not_configured"
  | "airtable_member_not_found"
  | "airtable_member_conflict";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apply = Boolean(args.apply);
  const reset = Boolean(args.reset);
  const limit = parseInt(args.limit || "", 10) || 0;

  const apiKey = (process.env.SWEATPALS_API_KEY || "").trim();
  const communityId = (process.env.SWEATPALS_COMMUNITY_ID || "").trim();
  if (!apiKey || !communityId) {
    console.error(
      "Missing SWEATPALS_API_KEY / SWEATPALS_COMMUNITY_ID. Configure env before reconciling."
    );
    process.exit(1);
  }

  let keys = await listSweatpalsReconcileKeys({ limit: limit || 1000 });
  if (args.email) {
    const email = args.email.trim().toLowerCase();
    keys = keys.filter((k) => (k.email || "").toLowerCase() === email);
    if (keys.length === 0) {
      keys = [
        { memberId: null, email, phone: null, lastSyncedAt: null },
      ];
    }
  }
  if (args.phone) {
    const phone = args.phone.trim();
    keys = keys.filter((k) => k.phone === phone);
    if (keys.length === 0) {
      keys = [{ memberId: null, email: null, phone, lastSyncedAt: null }];
    }
  }
  if (limit > 0) keys = keys.slice(0, limit);

  console.log(
    `SweatPals reconcile: ${keys.length} member(s), mode=${apply ? "apply" : "dry-run"}`
  );

  const checkpoint: Checkpoint =
    apply && !reset
      ? (loadCheckpoint() ?? {
          runId: `${Date.now()}`,
          mode: "apply",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "in_progress",
          totals: { scanned: 0, written: 0, failed: 0 },
          done: {},
        })
      : {
          runId: `${Date.now()}`,
          mode: "apply",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "in_progress",
          totals: { scanned: 0, written: 0, failed: 0 },
          done: {},
        };

  const tally: Record<Category, number> = {
    active_ok: 0,
    paused: 0,
    inactive_revoked: 0,
    unresolved: 0,
    api_error: 0,
    not_configured: 0,
    airtable_member_not_found: 0,
    airtable_member_conflict: 0,
  };
  const details: Record<
    string,
    { status: string; mirrorStatus: string; changed: number; reason?: string }
  > = {};
  let totalChanged = 0;

  for (const key of keys) {
    const id = keyFor(key);
    if (checkpoint.done[id] && !reset) {
      continue;
    }
    let res;
    try {
      res = await reconcileSweatpalsMember({
        memberstackId: key.memberId || undefined,
        emails: [key.email || undefined],
        phone: key.phone || undefined,
        mirrorEmail: key.email || undefined,
        dryRun: !apply,
      });
    } catch (e) {
      console.error(`[failed] ${id}: ${e instanceof Error ? e.message : String(e)}`);
      if (apply) {
        checkpoint.totals.failed += 1;
        checkpoint.done[id] = "failed";
        saveCheckpoint(checkpoint);
      }
      tally.api_error += 1;
      details[id] = {
        status: "failed",
        mirrorStatus: "failed",
        changed: 0,
        reason: e instanceof Error ? e.message : String(e),
      };
      continue;
    }

    const cat: Category =
      res.status === "active"
        ? "active_ok"
        : res.status === "paused"
          ? "paused"
          : res.status === "inactive"
            ? "inactive_revoked"
            : res.status === "unresolved"
              ? "unresolved"
              : res.status === "api_error"
                ? "api_error"
                : res.status === "not_configured"
                  ? "not_configured"
                  : res.status === "airtable_member_conflict"
                    ? "airtable_member_conflict"
                    : "airtable_member_not_found";
    tally[cat] += 1;
    totalChanged += res.changedCount;
    details[id] = {
      status: res.status,
      mirrorStatus: res.mirrorStatus,
      changed: res.changedCount,
      reason: res.reason,
    };

    if (apply) {
      checkpoint.totals.scanned += 1;
      if (res.mirrorStatus === "updated") checkpoint.totals.written += 1;
      checkpoint.done[id] =
        res.mirrorStatus === "updated"
          ? "written"
          : res.mirrorStatus === "shadowed" || res.changedCount === 0
            ? "unchanged"
            : res.status === "unresolved"
              ? "unresolved"
              : "api_error";
      saveCheckpoint(checkpoint);
    }

    await new Promise((r) => setTimeout(r, GAP_MS));
  }

  if (apply) {
    checkpoint.status = "complete";
    saveCheckpoint(checkpoint);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run",
    scanned: keys.length,
    totalChanged,
    tally,
    details,
  };
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(summary, null, 2));

  console.log("");
  console.log("=== SweatPals reconcile summary ===");
  for (const [k, v] of Object.entries(tally)) {
    if (v > 0) console.log(`  ${k}: ${v}`);
  }
  console.log(`  fields changed: ${totalChanged}`);
  console.log(`Report: ${REPORT_FILE}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
