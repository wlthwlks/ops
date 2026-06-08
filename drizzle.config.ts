import { defineConfig } from "drizzle-kit";

// drizzle-kit needs a *direct* (unpooled) connection because pgbouncer in
// transaction-pool mode can't hold the session-level state DDL requires.
// POSTGRES_URL_NON_POOLING is provided by the Vercel Neon integration.
const url = process.env.POSTGRES_URL_NON_POOLING;
if (!url) {
  throw new Error(
    "POSTGRES_URL_NON_POOLING is not set. Either run via " +
      "`node --env-file=.env.development.local …` or pull it with " +
      "`vercel env pull .env.development.local --environment=production`."
  );
}

export default defineConfig({
  schema: "./src/db/schema/*.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  verbose: true,
  strict: true,
});
