#!/usr/bin/env node
/**
 * Minimal, reliable drizzle-compatible migrator.
 *
 * Why this exists
 * ---------------
 * `drizzle-kit migrate` currently hangs in its progress UI when using the
 * `pg` driver against Neon (the spinner never resolves, even though the
 * underlying transaction commits). Rather than ship a migration command
 * that looks frozen, this script performs the exact same work drizzle-kit's
 * migrator does — reads `drizzle/meta/_journal.json`, splits each
 * `<tag>.sql` file on `--> statement-breakpoint`, applies unapplied
 * statements inside a single transaction, and records the hash in
 * `public.__drizzle_migrations` — then exits cleanly.
 *
 * It is fully compatible with the existing migrations ledger
 * (`public.__drizzle_migrations`, same hash algorithm as drizzle-orm) so
 * `drizzle-kit generate` / `push` / future `migrate` calls keep working.
 *
 * Usage:
 *   npm run db:migrate                         # uses POSTGRES_URL_NON_POOLING
 *   node --env-file=.env.local scripts/migrate.ts --schema=public
 *
 * Options:
 *   --schema=<name>      migrations schema (default: public — matches project history)
 *   --table=<name>       migrations table (default: __drizzle_migrations)
 *   --folder=<path>       migrations folder (default: ./drizzle)
 *   --dry-run            print what would be applied, write nothing
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Pool } from "pg";

type JournalEntry = {
  idx: number;
  tag: string;
  when: number;
  breakpoints: boolean;
};

type Args = {
  schema: string;
  table: string;
  folder: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    schema: "public",
    table: "__drizzle_migrations",
    folder: "./drizzle",
    dryRun: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") a.dryRun = true;
    else if (arg.startsWith("--schema=")) a.schema = arg.slice("--schema=".length);
    else if (arg.startsWith("--table=")) a.table = arg.slice("--table=".length);
    else if (arg.startsWith("--folder=")) a.folder = arg.slice("--folder=".length);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);

  const url = process.env.POSTGRES_URL_NON_POOLING;
  if (!url) {
    console.error("POSTGRES_URL_NON_POOLING is not set.");
    process.exit(1);
  }

  const journalPath = path.join(args.folder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    console.error(`Can't find ${journalPath}`);
    process.exit(1);
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: JournalEntry[];
  };

  // Load + hash every migration file
  const migrations = journal.entries.map((e) => {
    const file = path.join(args.folder, `${e.tag}.sql`);
    if (!fs.existsSync(file)) {
      console.error(`No file ${file} found in ${args.folder} folder`);
      process.exit(1);
    }
    const sql = fs.readFileSync(file, "utf8");
    const hash = crypto.createHash("sha256").update(sql).digest("hex");
    const stmts = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    return { tag: e.tag, folderMillis: e.when, hash, stmts };
  });

  const pool = new Pool({
    connectionString: url,
    max: 1,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30_000,
  });

  const client = await pool.connect();
  try {
    // Ensure migrations schema + table exist (mirrors drizzle-orm behaviour)
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${args.schema}"`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${args.schema}"."${args.table}" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    const { rows } = await client.query(
      `SELECT hash, created_at FROM "${args.schema}"."${args.table}" ORDER BY created_at ASC`
    );
    const appliedHashes = new Set(rows.map((r: { hash: string }) => r.hash));
    // Also use folderMillis to match drizzle-orm's "apply if folderMillis > last" rule,
    // so a manually-edited hash row without the canonical hash still skips correctly.
    const maxAppliedMillis = rows.reduce(
      (m: number, r: { created_at: string }) =>
        Math.max(m, Number(r.created_at) || 0),
      0
    );

    const pending = migrations.filter(
      (m) => !appliedHashes.has(m.hash) && m.folderMillis > maxAppliedMillis
    );

    if (pending.length === 0) {
      console.log("No new migrations to apply.");
      return;
    }

    console.log(`Applying ${pending.length} migration(s):`);
    for (const m of pending) {
      console.log(`  - ${m.tag}`);
      if (args.dryRun) continue;
      await client.query("BEGIN");
      try {
        for (const stmt of m.stmts) {
          await client.query(stmt);
        }
        await client.query(
          `INSERT INTO "${args.schema}"."${args.table}" (hash, created_at) VALUES ($1, $2)`,
          [m.hash, String(m.folderMillis)]
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        console.error(`Failed applying ${m.tag}:`, e instanceof Error ? e.message : e);
        process.exit(1);
      }
    }
    if (args.dryRun) {
      console.log("(dry-run: nothing was written)");
    } else {
      console.log("All migrations applied successfully.");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});