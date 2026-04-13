import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "path";
import fs from "fs";

function getDb() {
  const dbUrl = process.env.DATABASE_URL;

  if (dbUrl && dbUrl.startsWith("postgres")) {
    throw new Error(
      "Postgres support requires drizzle-orm/node-postgres. Set up separately for production."
    );
  }

  const dbPath = dbUrl || path.join(process.cwd(), "data", "ops.db");
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");

  const db = drizzle(sqlite, { schema });

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS op_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op_slug TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      log TEXT NOT NULL DEFAULT '',
      summary TEXT
    )
  `);

  return db;
}

export const db = getDb();
export type AppDb = typeof db;
