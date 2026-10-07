import { eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  introductionBannedPairs,
  type IntroductionBannedPair,
} from "@/db/schema";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import { MEMBERS_TABLE } from "@/lib/ops/airtable-fields";

export class BannedPairError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BannedPairError";
    this.code = code;
  }
}

/** Canonical, order-independent pair identity for a ban. */
export function bannedPairKey(keyA: string, keyB: string): string {
  return [keyA, keyB].sort().join("|");
}

/** Stable member key — record id when present, else lowercased email. */
export function bannedMemberKey(
  recordId: string | null | undefined,
  email: string | null | undefined
): string {
  if (recordId) return `at:${recordId}`;
  const e = (email ?? "").trim().toLowerCase();
  return e ? `em:${e}` : "";
}

/** Every banned pair key in the database. */
export async function loadBannedPairKeys(db: AppDb): Promise<Set<string>> {
  const rows = await db
    .select({ pairKey: introductionBannedPairs.pairKey })
    .from(introductionBannedPairs);
  return new Set(rows.map((r) => r.pairKey));
}

async function findMemberByEmail(
  airtable: AirtableClient,
  email: string
): Promise<AirtableRecord | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const escaped = normalized.replace(/"/g, '\\"');
  const records = await airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `LOWER({email}) = "${escaped}"`,
    fields: ["email", "Name", "First Name", "Last Name"],
  });
  return records[0] ?? null;
}

function memberName(record: AirtableRecord): string | null {
  const f = record.fields;
  const name = [f["First Name"], f["Last Name"]]
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || String(f["Name"] ?? "").trim() || null;
}

export interface CreateBannedPairInput {
  emailA: string;
  emailB: string;
  note?: string | null;
  operator?: string | null;
}

export async function createBannedPair(
  db: AppDb,
  airtable: AirtableClient,
  input: CreateBannedPairInput
): Promise<IntroductionBannedPair> {
  const a = await findMemberByEmail(airtable, input.emailA);
  if (!a) {
    throw new BannedPairError("MEMBER_NOT_FOUND", `No member found with email ${input.emailA}`);
  }
  const b = await findMemberByEmail(airtable, input.emailB);
  if (!b) {
    throw new BannedPairError("MEMBER_NOT_FOUND", `No member found with email ${input.emailB}`);
  }
  if (a.id === b.id) {
    throw new BannedPairError("SAME_MEMBER", "Cannot ban a member from matching with themselves");
  }

  const keyA = bannedMemberKey(a.id, String(a.fields["email"] ?? ""));
  const keyB = bannedMemberKey(b.id, String(b.fields["email"] ?? ""));
  const pairKey = bannedPairKey(keyA, keyB);

  const rows = await db
    .insert(introductionBannedPairs)
    .values({
      id: crypto.randomUUID(),
      memberAKey: keyA,
      memberBKey: keyB,
      pairKey,
      memberAEmail: String(a.fields["email"] ?? "") || null,
      memberBEmail: String(b.fields["email"] ?? "") || null,
      memberAName: memberName(a),
      memberBName: memberName(b),
      note: input.note?.trim() || null,
      createdBy: input.operator ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (!rows[0]) {
    throw new BannedPairError("ALREADY_BANNED", "This pair is already banned");
  }
  return rows[0];
}

export async function removeBannedPair(db: AppDb, id: string): Promise<boolean> {
  const rows = await db
    .delete(introductionBannedPairs)
    .where(eq(introductionBannedPairs.id, id))
    .returning({ id: introductionBannedPairs.id });
  return rows.length > 0;
}

export interface ResolvedBannedPair {
  id: string;
  memberAKey: string;
  memberBKey: string;
  memberAEmail: string | null;
  memberBEmail: string | null;
  memberAName: string | null;
  memberBName: string | null;
  note: string | null;
  createdAt: Date;
}

/** Re-resolve the current email/name for a member key (record-id based). */
async function resolveIdentity(
  airtable: AirtableClient,
  key: string,
  fallbackEmail: string | null,
  fallbackName: string | null
): Promise<{ email: string | null; name: string | null }> {
  if (!key.startsWith("at:")) {
    return { email: fallbackEmail, name: fallbackName };
  }
  const recordId = key.slice(3);
  try {
    const rec = await airtable.getRecord(MEMBERS_TABLE, recordId);
    const email = String(rec.fields["email"] ?? "").trim() || null;
    return { email, name: memberName(rec) };
  } catch {
    return { email: fallbackEmail, name: fallbackName };
  }
}

/**
 * List bans with live names/emails resolved from Airtable by record id, so
 * the UI stays correct even after a member updates their email.
 */
export async function listBannedPairs(
  db: AppDb,
  airtable: AirtableClient
): Promise<ResolvedBannedPair[]> {
  const rows = await db
    .select()
    .from(introductionBannedPairs)
    .orderBy(introductionBannedPairs.createdAt);
  const resolved: ResolvedBannedPair[] = [];
  for (const row of rows) {
    const [a, b] = await Promise.all([
      resolveIdentity(airtable, row.memberAKey, row.memberAEmail, row.memberAName),
      resolveIdentity(airtable, row.memberBKey, row.memberBEmail, row.memberBName),
    ]);
    resolved.push({
      id: row.id,
      memberAKey: row.memberAKey,
      memberBKey: row.memberBKey,
      memberAEmail: a.email,
      memberBEmail: b.email,
      memberAName: a.name,
      memberBName: b.name,
      note: row.note,
      createdAt: row.createdAt,
    });
  }
  return resolved;
}
