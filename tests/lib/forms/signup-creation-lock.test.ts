import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { AppDb } from "@/db";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

/**
 * Concurrency / idempotency tests for initial Airtable Member creation
 * during signup. These verify the guarantee that two concurrent requests
 * (bootstrap vs. Memberstack webhook, or duplicate webhook redeliveries)
 * for the SAME Memberstack member cannot produce two Airtable rows.
 *
 * Architecture
 * ------------
 * - Airtable is mocked (in-memory list/create/update).
 * - PostgreSQL is mocked with PGlite (WASM embedded Postgres) so the
 *   `signup_member_creations` lock table is exercised for real. A single
 *   PGlite instance is shared per-test via a Proxy standing in for `@/db`.
 * - Real concurrency is exercised using `Promise.all` for race tests,
 *   plus sequential / delayed sequences for the other scenarios in spec §8.
 */

// ─── DB mock wiring ──────────────────────────────────────────────────────────

let activeDb: AppDb | undefined;

// Production code does `import { db } from "@/db"`. The factory exposes a
// Proxy that always routes property access to the lazily-initialized
// per-test PGlite instance. This mirrors the production live-binding `db`
// proxy and lets us swap PGlite instances between tests.
vi.mock("@/db", () => {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (!activeDb) {
        throw new Error(
          "activeDb not initialized — call setupDb() in beforeEach"
        );
      }
      const inner = activeDb as unknown as Record<string | symbol, unknown>;
      const value = inner[prop as string];
      return typeof value === "function" ? value.bind(inner) : value;
    },
  };
  return { db: new Proxy({}, handler) };
});

// ─── Airtable mock wiring ─────────────────────────────────────────────────────

// We drive the in-memory Airtable via these controllers from each test.
let airtableRows: Array<{ id: string; fields: Record<string, unknown> }> = [];
let createRecords: ReturnType<typeof vi.fn>;
let updateRecords: ReturnType<typeof vi.fn>;
let listRecords: ReturnType<typeof vi.fn>;
let nextAirtableId = 0;

function resetAirtableMock() {
  airtableRows = [];
  nextAirtableId = 0;
  listRecords = vi.fn(async (
    _table: string,
    opts?: { filterByFormula?: string; maxRecords?: number }
  ) => {
    const formula = opts?.filterByFormula ?? "";
    // The formulas produced by members-sync.ts filter by Memberstack ID
    // (`{Memberstack ID} = 'X'`) or by normalized email
    // (`LOWER({email}) = 'x@y.z'`). Parse the compared literal out so the
    // mock returns the correct filtered subset.
    let msIdFilter: string | null = null;
    let emailFilter: string | null = null;
    const msMatch = formula.match(/\{Memberstack ID\}\s*=\s*'([^']*)'/);
    if (msMatch) msIdFilter = msMatch[1];
    const emailMatch = formula.match(/LOWER\(\{email\}\)\s*=\s*'([^']*)'/);
    if (emailMatch) emailFilter = emailMatch[1];

    let rows = airtableRows;
    if (msIdFilter) {
      rows = rows.filter(
        (r) =>
          String((r.fields as Record<string, unknown>)[MEMBER_FIELDS.memberstackId] ?? "")
            .trim() === msIdFilter
      );
    } else if (emailFilter) {
      rows = rows.filter(
        (r) =>
          String((r.fields as Record<string, unknown>)[MEMBER_FIELDS.email] ?? "")
            .trim()
            .toLowerCase() === emailFilter
      );
    }
    if (opts?.maxRecords && rows.length > opts.maxRecords) {
      rows = rows.slice(0, opts.maxRecords);
    }
    return rows;
  });

  createRecords = vi.fn(async (
    _table: string,
    rows: Array<{ fields: Record<string, unknown> }>
  ) => {
    return rows.map((r) => {
      const id = `rec${++nextAirtableId}`;
      const row = { id, fields: { ...r.fields } };
      airtableRows.push(row);
      return row;
    });
  });

  updateRecords = vi.fn(async (
    _table: string,
    rows: Array<{ id: string; fields: Record<string, unknown> }>
  ) => {
    return rows.map((r) => {
      const existing = airtableRows.find((x) => x.id === r.id);
      if (existing) {
        existing.fields = { ...existing.fields, ...r.fields };
        return existing;
      }
      const row = { id: r.id, fields: { ...r.fields } };
      airtableRows.push(row);
      return row;
    });
  });
}

vi.mock("@/lib/integrations/airtable", () => ({
  createAirtableClient: () => ({
    listRecords,
    createRecords,
    updateRecords,
    updateRecordsBatched: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

// ─── Test lifecycle ──────────────────────────────────────────────────────────

let pglite: PGlite;

async function setupDb() {
  pglite = new PGlite();
  activeDb = drizzle(pglite, { schema }) as unknown as AppDb;
  await pglite.exec(`
    CREATE TABLE signup_member_creations (
      memberstack_id TEXT PRIMARY KEY NOT NULL,
      email_normalized TEXT NOT NULL,
      status TEXT DEFAULT 'CREATING' NOT NULL,
      created_by TEXT NOT NULL,
      airtable_record_id TEXT,
      attempt_count INTEGER DEFAULT 1 NOT NULL,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX signup_member_creations_ms_id_uidx ON signup_member_creations (memberstack_id);
    CREATE INDEX signup_member_creations_email_idx ON signup_member_creations (email_normalized);
    CREATE INDEX signup_member_creations_status_idx ON signup_member_creations (status);
  `);
  // Shorten wait constants to keep tests fast.
  process.env.NEW_SIGNUP_WIDGET_ENABLED = "true";
  process.env.MAKE_SHADOW_MODE = "false";
  process.env.AIRTABLE_GET_DATA_TOKEN = "pat_test";
  process.env.AIRTABLE_BASE_ID = "appTEST";
}

async function teardownDb() {
  activeDb = undefined;
  if (pglite) await pglite.close();
}

async function loadModules() {
  vi.resetModules();
  const mod = await import("@/lib/forms/airtable/members-sync");
  const lockMod = await import("@/lib/forms/airtable/signup-creation-lock");
  return { mod, lockMod };
}

describe("upsertMinimalSignupMember — idempotent Airtable member creation", () => {
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vi.clearAllMocks();
    resetAirtableMock();
    for (const [k, v] of Object.entries({
      NEW_SIGNUP_WIDGET_ENABLED: process.env.NEW_SIGNUP_WIDGET_ENABLED,
      MAKE_SHADOW_MODE: process.env.MAKE_SHADOW_MODE,
      AIRTABLE_GET_DATA_TOKEN: process.env.AIRTABLE_GET_DATA_TOKEN,
      AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
    })) {
      prevEnv[k] = v;
    }
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function expectOneAirtableMember(memberstackId: string, email: string) {
    expect(createRecords).toHaveBeenCalledTimes(1);
    expect(airtableRows.length).toBe(1);
    const f = airtableRows[0].fields as Record<string, unknown>;
    expect(f[MEMBER_FIELDS.memberstackId]).toBe(memberstackId);
    expect(String(f[MEMBER_FIELDS.email]).toLowerCase()).toBe(email.toLowerCase());
  }

  // ─── Spec §8.1: Brand-new signup creates exactly one Airtable member ────────

  it("brand-new bootstrap signup creates exactly one Airtable member", async () => {
    const { mod } = await loadModules();
    const result = await mod.upsertMinimalSignupMember(
      {
        memberstackId: "mem_brand_new",
        email: "brand@new.com",
        firstName: "Brand",
        lastName: "New",
      },
      undefined,
      { caller: "bootstrap" }
    );
    expect(result.created).toBe(true);
    expect(result.deferred).toBeFalsy();
    expect(result.record).not.toBeNull();
    expectOneAirtableMember("mem_brand_new", "brand@new.com");
  });

  // ─── Spec §8.2: Bootstrap followed by member.created results in one record ───

  it("bootstrap then member.created webhook yields exactly one Airtable row", async () => {
    const { mod } = await loadModules();
    await mod.upsertMinimalSignupMember(
      {
        memberstackId: "mem_seq_1",
        email: "seq@one.com",
        firstName: "Seq",
        lastName: "One",
      },
      undefined,
      { caller: "bootstrap" }
    );
    const r2 = await mod.upsertMinimalSignupMember(
      {
        memberstackId: "mem_seq_1",
        email: "seq@one.com",
        firstName: "Seq",
        lastName: "One",
      },
      undefined,
      { caller: "memberstack_webhook" }
    );
    expect(r2.deferred).toBeFalsy();
    expect(r2.record).not.toBeNull();
    expect(createRecords).toHaveBeenCalledTimes(1);
    expect(airtableRows.length).toBe(1);
  });

  // ─── Spec §8.3: member.created followed closely by bootstrap ─────────────────

  it("member.created webhook then bootstrap yields exactly one Airtable row", async () => {
    const { mod } = await loadModules();
    // Webhook first — it becomes the canonical creator since bootstrap hasn't
    // claimed the lock yet.
    await mod.upsertMinimalSignupMember(
      {
        memberstackId: "mem_seq_2",
        email: "seq@two.com",
        firstName: "Seq",
        lastName: "Two",
      },
      undefined,
      { caller: "memberstack_webhook" }
    );
    // Bootstrap arrives afterwards — must find the existing record and
    // reconcile it; must NOT create a second row.
    const r2 = await mod.upsertMinimalSignupMember(
      {
        memberstackId: "mem_seq_2",
        email: "seq@two.com",
        firstName: "Seq",
        lastName: "Two",
      },
      undefined,
      { caller: "bootstrap" }
    );
    expect(r2.created).toBe(false);
    expect(r2.record).not.toBeNull();
    expect(createRecords).toHaveBeenCalledTimes(1);
    expect(airtableRows.length).toBe(1);
  });

  // ─── Spec §8.4: Two concurrent bootstrap requests result in one record ───────

  it("two concurrent bootstrap requests for the same member create one Airtable row", async () => {
    const { mod } = await loadModules();
    // Tighten the bootstrap wait so the loser polls quickly.
    const { WEBHOOK_WAIT_TIMEOUT_MS, BOOTSTRAP_WAIT_TIMEOUT_MS } =
      await import("@/lib/forms/airtable/signup-creation-lock");
    // Confirm we picked up the real constants (sanity only).
    expect(BOOTSTRAP_WAIT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(WEBHOOK_WAIT_TIMEOUT_MS).toBeGreaterThan(0);

    const [a, b] = await Promise.all([
      mod.upsertMinimalSignupMember(
        {
          memberstackId: "mem_race",
          email: "race@conc.com",
          firstName: "Race",
          lastName: "Concurrent",
        },
        undefined,
        { caller: "bootstrap" }
      ),
      mod.upsertMinimalSignupMember(
        {
          memberstackId: "mem_race",
          email: "race@conc.com",
          firstName: "Race",
          lastName: "Concurrent",
        },
        undefined,
        { caller: "bootstrap" }
      ),
    ]);

    // Exactly one of them is the creator; the other reconciles.
    const creators = [a, b].filter((r) => r.created);
    expect(creators.length).toBe(1);
    expect(airtableRows.length).toBe(1);
    expect([a, b].every((r) => r.record && !r.deferred)).toBe(true);
  });

  // ─── Spec §8.5: Duplicate Memberstack webhook deliveries ──────────────────────

  it("duplicate member.created webhook deliveries create exactly one Airtable row", async () => {
    const { mod } = await loadModules();
    const [a, b] = await Promise.all([
      mod.upsertMinimalSignupMember(
        {
          memberstackId: "mem_dup",
          email: "dup@wh.com",
          firstName: "Dup",
          lastName: "Wh",
        },
        undefined,
        { caller: "memberstack_webhook" }
      ),
      mod.upsertMinimalSignupMember(
        {
          memberstackId: "mem_dup",
          email: "dup@wh.com",
          firstName: "Dup",
          lastName: "Wh",
        },
        undefined,
        { caller: "memberstack_webhook" }
      ),
    ]);

    // Even though BOTH are non-canonical webhook callers, the lock guarantees
    // only one creates. The other either reconciles OR defers — both are safe.
    expect(airtableRows.length).toBe(1);
    const creators = [a, b].filter((r) => r.created);
    expect(creators.length).toBe(1);
    // The losing webhook either reconciled (record set, deferred false) or
    // deferred (no record). We do NOT assert exactly which — both are valid
    // outcomes of the OS-scheduling-dependent race. Concretely, the strong
    // invariant — airtableRows.length === 1 — proves no duplicate was created.
    const loser = [a, b].find((r) => !r.created)!;
    expect(loser.created).toBe(false);
    // And neither loser outcome produced a fresh Airtable row.
    expect(airtableRows.length).toBe(1);
  });

  // ─── Spec §8.6: Existing matching Memberstack ID updates instead of creates ─

  it("existing matching Memberstack ID reconciles instead of creating", async () => {
    airtableRows.push({
      id: "rec_existing_ms",
      fields: {
        [MEMBER_FIELDS.memberstackId]: "mem_existing",
        [MEMBER_FIELDS.email]: "existing@ms.com",
        [MEMBER_FIELDS.onboardingStatus]: "OLD_STATUS",
      },
    });
    const { mod } = await loadModules();
    const result = await mod.upsertMinimalSignupMember(
      {
        memberstackId: "mem_existing",
        email: "existing@ms.com",
        firstName: "Upd",
        lastName: "Name",
      },
      undefined,
      { caller: "bootstrap" }
    );
    expect(result.created).toBe(false);
    expect(createRecords).not.toHaveBeenCalled();
    expect(updateRecords).toHaveBeenCalledOnce();
    expect(airtableRows.length).toBe(1);
  });

  // ─── Spec §8.7: Existing same email + blank Memberstack ID safely reconciles ─

  it("existing same email with blank Memberstack ID reconciles (recovery path)", async () => {
    airtableRows.push({
      id: "rec_blank_ms",
      fields: {
        [MEMBER_FIELDS.email]: "recover@email.com",
        [MEMBER_FIELDS.memberstackId]: "", // blank — recovery target
      },
    });
    const { mod } = await loadModules();
    const result = await mod.upsertMinimalSignupMember(
      {
        memberstackId: "mem_recover_new",
        email: "recover@email.com",
        firstName: "Recover",
        lastName: "Path",
      },
      undefined,
      { caller: "bootstrap" }
    );
    expect(result.created).toBe(false);
    expect(createRecords).not.toHaveBeenCalled();
    expect(airtableRows.length).toBe(1);
    const fields = airtableRows[0].fields as Record<string, unknown>;
    expect(fields[MEMBER_FIELDS.memberstackId]).toBe("mem_recover_new");
  });

  // ─── Spec §8.8: Existing same email + different non-empty Memberstack ID ─────

  it("email already owned by a different non-empty Memberstack ID surfaces MEMBER_IDENTITY_CONFLICT", async () => {
    airtableRows.push({
      id: "rec_conflict",
      fields: {
        [MEMBER_FIELDS.email]: "jane@example.com",
        [MEMBER_FIELDS.memberstackId]: "mem_OLD",
      },
    });
    const { mod } = await loadModules();
    await expect(
      mod.upsertMinimalSignupMember(
        {
          memberstackId: "mem_NEW",
          email: "jane@example.com",
          firstName: "Jane",
          lastName: "Conflict",
        },
        undefined,
        { caller: "bootstrap" }
      )
    ).rejects.toMatchObject({
      code: "MEMBER_IDENTITY_CONFLICT",
      status: 409,
    });
    // The existing row must NOT be silently overwritten (no create, no update).
    expect(createRecords).not.toHaveBeenCalled();
    expect(updateRecords).not.toHaveBeenCalled();
    const fields = airtableRows[0].fields as Record<string, unknown>;
    expect(fields[MEMBER_FIELDS.memberstackId]).toBe("mem_OLD");
  });

  // ─── Spec §8.9: Multiple Airtable rows with same normalized email detected ──

  it("multiple existing rows for the same normalized email are detected and not silently modified", async () => {
    airtableRows.push({
      id: "rec_dup_a",
      fields: {
        [MEMBER_FIELDS.email]: "multi@email.com",
        [MEMBER_FIELDS.memberstackId]: "mem_A",
      },
    });
    airtableRows.push({
      id: "rec_dup_b",
      fields: {
        [MEMBER_FIELDS.email]: "multi@email.com",
        [MEMBER_FIELDS.memberstackId]: "mem_B",
      },
    });
    const { mod } = await loadModules();
    await expect(
      mod.upsertMinimalSignupMember(
        {
          memberstackId: "mem_NEW_ID",
          email: "multi@email.com",
          firstName: "Multi",
          lastName: "Dup",
        },
        undefined,
        { caller: "bootstrap" }
      )
    ).rejects.toMatchObject({
      code: "AIRTABLE_DUPLICATE_MEMBER",
      status: 409,
    });
    expect(createRecords).not.toHaveBeenCalled();
    expect(updateRecords).not.toHaveBeenCalled();
  });

  // ─── Spec §8.10: Retry after a partial/transient failure remains safe ────────

  it("retry after a transient Airtable write failure does not create duplicate rows", async () => {
    const { mod } = await loadModules();
    // First create throws on the Airtable call.
    const shouldFail = true;
    createRecords.mockImplementationOnce(async () => {
      if (shouldFail) throw new Error("Transient Airtable 503");
      return [];
    });
    await expect(
      mod.upsertMinimalSignupMember(
        {
          memberstackId: "mem_retry",
          email: "retry@fail.com",
          firstName: "Retry",
          lastName: "Fail",
        },
        undefined,
        { caller: "bootstrap" }
      )
    ).rejects.toThrow();
    // The lock row is now FAILED; airtable is empty. A retry must:
    //   - see the FAILED row, re-acquire (status !== CREATING triggers reAcquire)
    //   - re-check Airtable (still empty), then create only one row.
    const result = await mod.upsertMinimalSignupMember(
      {
        memberstackId: "mem_retry",
        email: "retry@fail.com",
        firstName: "Retry",
        lastName: "Fail",
      },
      undefined,
      { caller: "bootstrap" }
    );
    expect(result.created).toBe(true);
    expect(airtableRows.length).toBe(1);
  });

  // ─── Extra: webhook defers when bootstrap holds the lock without creating ───

  it("webhook defers when a CREATING lock is held but no Airtable row appears", async () => {
    const { mod, lockMod } = await loadModules();
    // Manually pre-claim the lock so the webhook sees a CREATING row owned by
    // bootstrap that never completes within the webhook's wait window.
    await lockMod.acquireSignupCreation({
      memberstackId: "mem_pre_claim",
      email: "pre@claim.com",
      source: "bootstrap",
    });
    const result = await mod.upsertMinimalSignupMember(
      {
        memberstackId: "mem_pre_claim",
        email: "pre@claim.com",
        firstName: "Pre",
        lastName: "Claim",
      },
      undefined,
      { caller: "memberstack_webhook" }
    );
    expect(result.deferred).toBe(true);
    expect(result.record).toBeNull();
    expect(createRecords).not.toHaveBeenCalled();
    expect(airtableRows.length).toBe(0);
  });

  // ─── Extra: webhook succeeds when bootstrap completes during webhook wait ────

  it("webhook reconciles when bootstrap completes the Airtable create mid-wait", async () => {
    const { mod, lockMod } = await loadModules();
    // Manually pre-claim the lock as bootstrap (representing bootstrap mid-
    // Airtable-create while the webhook arrives and polls).
    await lockMod.acquireSignupCreation({
      memberstackId: "mem_late",
      email: "late@wh.com",
      source: "bootstrap",
    });
    // Start the webhook — it sees the CREATING lock and enters its poll
    // loop waiting for `airtable_record_id` to appear.
    const webhookP = mod.upsertMinimalSignupMember(
      {
        memberstackId: "mem_late",
        email: "late@wh.com",
        firstName: "Late",
        lastName: "Wh",
      },
      undefined,
      { caller: "memberstack_webhook" }
    );
    // Yield so the webhook reaches its poll loop.
    await new Promise((r) => setTimeout(r, 5));
    // Simulate bootstrap completing: the Airtable row is created and the
    // lock row transitions to CREATED with airtable_record_id populated.
    airtableRows.push({
      id: "rec_bs_late",
      fields: {
        [MEMBER_FIELDS.memberstackId]: "mem_late",
        [MEMBER_FIELDS.email]: "late@wh.com",
      },
    });
    await lockMod.markSignupCreationComplete({
      memberstackId: "mem_late",
      airtableRecordId: "rec_bs_late",
    });
    // The webhook's next poll cycle should observe CREATED +
    // airtable_record_id, re-resolve Airtable, find the bootstrap-created
    // row, and reconcile it instead of creating its own.
    const webResult = await webhookP;
    expect(webResult.deferred).toBeFalsy();
    expect(webResult.record?.id).toBe("rec_bs_late");
    expect(createRecords).not.toHaveBeenCalled();
    expect(airtableRows.length).toBe(1);
  });

  // ─── Extra: identity conflict is also surfaced from the webhook path ────────

  it("webhook path also surfaces MEMBER_IDENTITY_CONFLICT", async () => {
    airtableRows.push({
      id: "rec_wh_conflict",
      fields: {
        [MEMBER_FIELDS.email]: "ct@email.com",
        [MEMBER_FIELDS.memberstackId]: "mem_OLD_WH",
      },
    });
    const { mod } = await loadModules();
    await expect(
      mod.upsertMinimalSignupMember(
        {
          memberstackId: "mem_NEW_WH",
          email: "ct@email.com",
          firstName: "Ct",
          lastName: "Wh",
        },
        undefined,
        { caller: "memberstack_webhook" }
      )
    ).rejects.toMatchObject({ code: "MEMBER_IDENTITY_CONFLICT", status: 409 });
  });

  // ─── Extra: lock table uniquely keys by Memberstack ID (sanity) ──────────────

  it("two different Memberstack IDs create two Airtable rows", async () => {
    const { mod } = await loadModules();
    await mod.upsertMinimalSignupMember(
      {
        memberstackId: "mem_uniq_a",
        email: "a@uniq.com",
        firstName: "Aa",
        lastName: "Bb",
      },
      undefined,
      { caller: "bootstrap" }
    );
    await mod.upsertMinimalSignupMember(
      {
        memberstackId: "mem_uniq_b",
        email: "b@uniq.com",
        firstName: "Bb",
        lastName: "Cc",
      },
      undefined,
      { caller: "bootstrap" }
    );
    expect(airtableRows.length).toBe(2);
  });
});