import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// Provided by the Vercel/Neon Marketplace integration. In local dev pulled
// via `vercel env pull .env.development.local --environment=production` plus
// the connection-string overrides documented in the README.
const url = process.env.POSTGRES_URL;
if (!url) {
  throw new Error(
    "POSTGRES_URL is not set. Either run via " +
      "`node --env-file=.env.development.local …` or pull it with " +
      "`vercel env pull .env.development.local --environment=production` " +
      "(then paste the real Neon pooled URL into the file — Vercel writes " +
      "empty strings for sensitive vars)."
  );
}

const client = neon(url);
export const db = drizzle(client, { schema });
export type AppDb = typeof db;
