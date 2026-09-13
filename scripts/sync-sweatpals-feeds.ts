/**
 * SweatPals lifecycle feed sync (manual run).
 *
 * Polls the zapier-provider feeds (new-members / cancelled-members /
 * renewed-members) and reconciles fresh rows into the local snapshot +
 * Airtable billing mirror. Default: dry-run (no Airtable writes).
 *
 * Usage:
 *   npm run sweatpals:sync-feeds                 (dry-run, all feeds)
 *   npm run sweatpals:sync-feeds -- --apply
 *   npm run sweatpals:sync-feeds -- --feed=new-members --limit=1
 */
import * as dotenv from "dotenv";
import { syncSweatpalsFeeds } from "../src/lib/forms/sweatpals/feeds";

// Prefer local overrides (.env.local) so the preview DB / staging keys win
// when both files exist.
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = (process.env.SWEATPALS_API_KEY || "").trim();
  if (!apiKey) {
    console.error("Missing SWEATPALS_API_KEY. Configure env before syncing feeds.");
    process.exit(1);
  }

  const feed = (args.feed || "all") as "all" | "new-members" | "cancelled-members" | "renewed-members";
  const apply = Boolean(args.apply);
  const maxPages = parseInt(args.limit || "", 10) || 5;
  const pageSize = parseInt(args.pageSize || "", 10) || 20;

  console.log(
    `SweatPals feed sync: feed=${feed}, mode=${apply ? "apply" : "dry-run"}, maxPages=${maxPages}, pageSize=${pageSize}`
  );

  const results = await syncSweatpalsFeeds({ feed, apply, maxPages, pageSize });
  for (const r of results) {
    console.log(
      `  ${r.feed}: scanned=${r.scanned} processed=${r.processed} synced=${r.synced} ` +
        `failed=${r.failed} skipped_no_identity=${r.skippedNoIdentity} ` +
        `cursor=${r.cursorAdvancedTo ?? (r.nextCursor ? `${r.nextCursor} (dry-run)` : "-")}` +
        (r.lastReconcileError ? ` LAST_ERROR=${r.lastReconcileError}` : "") +
        (r.error ? ` ERROR=${r.error}` : "")
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
