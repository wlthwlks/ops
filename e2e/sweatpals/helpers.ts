/**
 * Shared helpers for the SweatPals E2E suite.
 *
 * - Loads .env / .env.local (local overrides win) BEFORE any DB import.
 * - Installs a widget test harness: fake $memberstackDom + fetch wrapper that
 *   attaches ALLOW_MEMBERSTACK_TEST_AUTH headers to our API calls, so the
 *   signup widget authenticates without real Memberstack.
 * - Postgres + Airtable readers for the "connection between databases" checks.
 */
import * as dotenv from "dotenv";
import type { Page } from "@playwright/test";
import { desc, eq } from "drizzle-orm";
import type { AppDb } from "../../src/db";
import type * as SchemaNS from "../../src/db/schema";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

export function uniqueEmail(prefix: string): string {
  return `${prefix}+${Date.now()}-${Math.floor(Math.random() * 1e4)}@wlth.test`;
}

/**
 * Real, deliverable test emails (SweatPals verifies buyer emails — fake domains
 * fail verification). Env override: SWEATPALS_E2E_EMAILS (comma-separated).
 */
export function e2eEmail(index: number): string {
  const list = (process.env.SWEATPALS_E2E_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const defaults = ["sotacodeprivate@gmail.com", "holarina1@gmail.com", "sotacodework@gmail.com"];
  const pool = list.length ? list : defaults;
  return pool[index % pool.length];
}

/** Full NZ test phone (+64…). Env override: SWEATPALS_E2E_PHONE. */
export function e2ePhoneFull(): string {
  return (process.env.SWEATPALS_E2E_PHONE || "+642885198896").trim();
}

/** Local part of the NZ test phone (without the +64 prefix). */
export function e2ePhoneLocal(): string {
  return e2ePhoneFull().replace(/^\+64/, "");
}

export function testMemberId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

export function testAuthHeaders(memberId: string, email: string) {
  return {
    "Content-Type": "application/json",
    "x-test-memberstack-id": memberId,
    "x-test-memberstack-email": email,
  };
}

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A JWT-looking token whose payload carries the member id (decoded by the widget). */
export function makeFakeJwt(memberId: string): string {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: memberId })}.e2e`;
}

/**
 * Inject the fake Memberstack DOM + test-auth fetch wrapper before any page
 * script runs. Must be installed before page.goto / page.reload.
 *
 * Also blocks Clerk's client handshake traffic: the dev host page doesn't need
 * Clerk, and its handshake triggers full-page redirects mid-flow.
 */
export async function installWidgetHarness(
  page: Page,
  opts: { memberId: string; email: string }
): Promise<void> {
  await page.route("**://*.clerk.accounts.dev/**", (route) => route.abort());
  const accessToken = makeFakeJwt(opts.memberId);
  await page.addInitScript(() => {
    // Hide automation fingerprints (runs in every frame incl. js.stripe.com).
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    } catch {
      /* ignore */
    }
    // Record Stripe pe-change state for debugging bot-blocked card entry.
    const w = window as unknown as { __stripePeChanges?: unknown[] };
    w.__stripePeChanges = [];
    window.addEventListener("message", (e) => {
      try {
        const d = e.data as { action?: string; payload?: { event?: string; data?: unknown } };
        if (d?.action === "stripe-frame-event" && d?.payload?.event === "pe-change") {
          w.__stripePeChanges!.push({
            at: Date.now(),
            complete: (d.payload.data as { complete?: boolean })?.complete ?? null,
            empty: (d.payload.data as { empty?: boolean })?.empty ?? null,
          });
        }
      } catch {
        /* ignore */
      }
    });
  });
  await page.addInitScript(
    ({ memberId, email, token }) => {
      const w = window as unknown as {
        $memberstackDom?: Record<string, unknown>;
      };
      w.$memberstackDom = {
        signupMemberEmailPassword: async () => ({
          data: {
            tokens: { accessToken: token, expires: Date.now() + 86_400_000, type: "bearer" },
            member: { id: memberId, auth: { email } },
          },
        }),
        loginMemberEmailPassword: async () => ({
          data: {
            tokens: { accessToken: token, expires: Date.now() + 86_400_000, type: "bearer" },
            member: { id: memberId, auth: { email } },
          },
        }),
        getMemberCookie: () => undefined,
      };

      const origFetch = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const isOurApi =
          url.startsWith("/api/") ||
          /localhost:\d+\/api\//.test(url) ||
          /127\.0\.0\.1:\d+\/api\//.test(url);
        if (isOurApi) {
          const headers = new Headers(init?.headers || {});
          if (!headers.has("x-test-memberstack-id")) headers.set("x-test-memberstack-id", memberId);
          if (!headers.has("x-test-memberstack-email")) headers.set("x-test-memberstack-email", email);
          return origFetch(input, { ...(init || {}), headers });
        }
        return origFetch(input, init);
      };
    },
    { memberId: opts.memberId, email: opts.email, token: accessToken }
  );
}

export type SweatpalsDbRow = {
  id: string;
  memberId: string | null;
  membershipName: string | null;
  membershipTierId: string | null;
  active: boolean;
  paused: boolean;
  pauseFuturePayments: boolean;
  actualTo: string | null;
  sweatpalsEmail: string | null;
  sweatpalsPhone: string | null;
};

async function loadDb(): Promise<{ db: AppDb; schema: typeof SchemaNS }> {
  const dbMod = (await import("../../src/db")) as { db: AppDb; default?: { db: AppDb } };
  const schemaMod = (await import("../../src/db/schema")) as
    | typeof SchemaNS
    | { default: typeof SchemaNS };
  // Playwright's TS transform may wrap ESM modules under `default`.
  const dbHolder = (dbMod.default ?? dbMod) as { db: AppDb };
  const schemaHolder = schemaMod as unknown as {
    default?: typeof SchemaNS;
    [key: string]: unknown;
  };
  const schema = (schemaHolder.default ?? schemaMod) as typeof SchemaNS;
  return { db: dbHolder.db, schema };
}

export async function getSweatpalsRowsForMember(memberId: string): Promise<SweatpalsDbRow[]> {
  const { db, schema } = await loadDb();
  const rows = await db
    .select({
      id: schema.sweatpalsMemberships.id,
      memberId: schema.sweatpalsMemberships.memberId,
      membershipName: schema.sweatpalsMemberships.membershipName,
      membershipTierId: schema.sweatpalsMemberships.membershipTierId,
      active: schema.sweatpalsMemberships.active,
      paused: schema.sweatpalsMemberships.paused,
      pauseFuturePayments: schema.sweatpalsMemberships.pauseFuturePayments,
      actualTo: schema.sweatpalsMemberships.actualTo,
      sweatpalsEmail: schema.sweatpalsMemberships.sweatpalsEmail,
      sweatpalsPhone: schema.sweatpalsMemberships.sweatpalsPhone,
    })
    .from(schema.sweatpalsMemberships)
    .where(eq(schema.sweatpalsMemberships.memberId, memberId))
    .orderBy(desc(schema.sweatpalsMemberships.lastSyncedAt))
    .limit(10);
  return rows.map((r): SweatpalsDbRow => ({
    id: r.id,
    memberId: r.memberId,
    membershipName: r.membershipName,
    membershipTierId: r.membershipTierId,
    active: r.active,
    paused: r.paused,
    pauseFuturePayments: r.pauseFuturePayments,
    actualTo: r.actualTo ? (r.actualTo as Date).toISOString() : null,
    sweatpalsEmail: r.sweatpalsEmail,
    sweatpalsPhone: r.sweatpalsPhone,
  }));
}

/** Pick a seeded SweatPals member with an active membership (feed-synced). */
export async function pickSeededActiveMember(): Promise<{
  email: string;
  membershipName: string;
} | null> {
  const { db, schema } = await loadDb();
  const rows = await db
    .select({
      email: schema.sweatpalsMemberships.sweatpalsEmail,
      membershipName: schema.sweatpalsMemberships.membershipName,
    })
    .from(schema.sweatpalsMemberships)
    .where(eq(schema.sweatpalsMemberships.active, true))
    .limit(5);
  const row = rows.find((r) => r.email);
  if (!row?.email) return null;
  return { email: row.email, membershipName: row.membershipName || "" };
}

export async function signupCreationExists(memberstackId: string): Promise<boolean> {
  const { db, schema } = await loadDb();
  const rows = await db
    .select({ id: schema.signupMemberCreations.memberstackId })
    .from(schema.signupMemberCreations)
    .where(eq(schema.signupMemberCreations.memberstackId, memberstackId))
    .limit(1);
  return rows.length > 0;
}

export type AirtableMemberRecord = {
  id: string;
  fields: Record<string, unknown>;
};

export async function airtableFindMember(memberstackId: string): Promise<AirtableMemberRecord[]> {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) throw new Error("Airtable env not configured for E2E");
  const formula = encodeURIComponent(`{Memberstack ID}='${memberstackId}'`);
  const res = await fetch(
    `https://api.airtable.com/v0/${baseId}/MEMBERS?filterByFormula=${formula}&pageSize=5`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    throw new Error(`Airtable lookup failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { records: AirtableMemberRecord[] };
  return json.records;
}

// —— Test-data cleanup (runs after every test) ——

const testIdentities: { memberId: string; email: string }[] = [];

export function registerTestIdentity(id: { memberId: string; email: string }): void {
  testIdentities.push(id);
}

/**
 * Remove everything this test run created: SweatPals snapshot rows, signup
 * lock rows and the Airtable member records for the registered identities.
 * (SweatPals-side memberships cannot be deleted via the lookup-only API.)
 */
export async function cleanupAllTestData(): Promise<string[]> {
  const { db, schema } = await loadDb();
  const cleaned: string[] = [];
  for (const t of testIdentities) {
    try {
      await db
        .delete(schema.sweatpalsMemberships)
        .where(eq(schema.sweatpalsMemberships.memberId, t.memberId));
      await db
        .delete(schema.sweatpalsMemberships)
        .where(eq(schema.sweatpalsMemberships.sweatpalsEmail, t.email));
      await db
        .delete(schema.signupMemberCreations)
        .where(eq(schema.signupMemberCreations.memberstackId, t.memberId));
      cleaned.push(`pg:${t.memberId}`);
    } catch {
      /* ignore */
    }
    try {
      const records = await airtableFindMember(t.memberId);
      const token = process.env.AIRTABLE_GET_DATA_TOKEN;
      const baseId = process.env.AIRTABLE_BASE_ID;
      for (const r of records) {
        await fetch(`https://api.airtable.com/v0/${baseId}/MEMBERS/${r.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        cleaned.push(`airtable:${r.id}`);
      }
    } catch {
      /* ignore */
    }
  }
  testIdentities.length = 0;
  return cleaned;
}
