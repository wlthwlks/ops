import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

type Schema = typeof schema;
export type AppDb = NeonHttpDatabase<Schema>;

// POSTGRES_URL is supplied by the Vercel/Neon integration and is flagged
// Sensitive — Vercel only decrypts it at runtime, never during build. So we
// MUST NOT read it at module-evaluation time, otherwise Next.js's page-data
// collection step (which imports every route module to extract metadata)
// fails with "POSTGRES_URL is not set" even though the value is fine at
// runtime. The proxy below defers connection setup until the first property
// access — i.e. when an actual request handler reaches for `db.select()`.
let _db: AppDb | undefined;

function ensureDb(): AppDb {
  if (_db) return _db;
  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      "POSTGRES_URL is not set at runtime. Confirm the Neon integration is " +
        "connected to the Vercel project (Marketplace → Neon → Connect to Project), " +
        "or for local dev paste the pooled connection string into .env.development.local."
    );
  }
  _db = drizzle(neon(url), { schema });
  return _db;
}

export const db = new Proxy({} as AppDb, {
  get(_target, prop, receiver) {
    const inner = ensureDb() as unknown as Record<string | symbol, unknown>;
    const value = inner[prop as string];
    return typeof value === "function" ? value.bind(inner) : value;
  },
}) as AppDb;
