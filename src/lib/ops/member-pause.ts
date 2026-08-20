/**
 * Ops-side intro pause management.
 *
 * "Recurring intro status" = Paused blocks introduction delivery in both
 * engines (see @/lib/introduction/pause-state). This module gives the ops
 * dashboard real write paths for pausing/resuming intros — replacing manual
 * Airtable edits — plus the expired-pause scan used by the expiry cron.
 */
import { createAirtableClient, type AirtableClient, type AirtableRecord } from "@/lib/integrations/airtable";
import { MEMBERS_TABLE, MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { parsePauseUntil, resolveIntroPauseState } from "@/lib/introduction/pause-state";

const PAUSE_FIELDS = [
  MEMBER_FIELDS.name,
  MEMBER_FIELDS.email,
  MEMBER_FIELDS.recurringIntroStatus,
  MEMBER_FIELDS.recurringPauseUntil,
];

export function getOpsAirtableClient(): AirtableClient {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) throw new Error("Airtable is not configured");
  return createAirtableClient({ apiKey: token, baseId });
}

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

export interface MemberPauseSnapshot {
  airtableRecordId: string;
  name: string;
  email: string;
  recurringIntroStatus: string;
  recurringPauseUntil: string;
  state: "active" | "paused" | "excluded" | "unknown";
  isPaused: boolean;
  pauseUntilDate: string | null;
  missingDate: boolean;
}

export function pauseSnapshotFromRecord(record: AirtableRecord): MemberPauseSnapshot {
  const status = fieldStr(record.fields, MEMBER_FIELDS.recurringIntroStatus);
  const pauseUntil = fieldStr(record.fields, MEMBER_FIELDS.recurringPauseUntil);
  const resolved = resolveIntroPauseState(status, pauseUntil || null);
  return {
    airtableRecordId: record.id,
    name: fieldStr(record.fields, MEMBER_FIELDS.name),
    email: fieldStr(record.fields, MEMBER_FIELDS.email),
    recurringIntroStatus: status,
    recurringPauseUntil: pauseUntil,
    state: resolved.state,
    isPaused: resolved.isPaused,
    pauseUntilDate: resolved.pauseUntilDate
      ? resolved.pauseUntilDate.toISOString().slice(0, 10)
      : null,
    missingDate: resolved.missingDate,
  };
}

export async function getMemberPauseSnapshot(
  airtableRecordId: string,
  airtable: AirtableClient = getOpsAirtableClient()
): Promise<MemberPauseSnapshot | null> {
  try {
    const record = await airtable.getRecord(MEMBERS_TABLE, airtableRecordId);
    return pauseSnapshotFromRecord(record);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg) || /RECORD_NOT_FOUND/i.test(msg)) return null;
    throw err;
  }
}

export interface PauseActionOptions {
  airtableRecordId: string;
  clerkUserId: string;
  mode: string;
  /** ISO date or date-only string. Blank = pause indefinitely (flag it). */
  pauseUntil?: string | null;
}

function logPauseEvent(event: string, input: PauseActionOptions, extra: Record<string, unknown> = {}) {
  console.error(
    JSON.stringify({
      event,
      airtableRecordId: input.airtableRecordId,
      actorClerkUserId: input.clerkUserId,
      mode: input.mode,
      ...extra,
    })
  );
}

export async function setMemberPause(
  input: PauseActionOptions,
  airtable: AirtableClient = getOpsAirtableClient()
): Promise<{ record: AirtableRecord; warnings: string[] }> {
  const warnings: string[] = [];
  const pauseUntilRaw = (input.pauseUntil ?? "").trim();

  let pauseUntilValue = "";
  if (pauseUntilRaw) {
    const parsed = parsePauseUntil(pauseUntilRaw);
    if (!parsed) {
      throw new Error(`Invalid pause-until date: ${JSON.stringify(pauseUntilRaw)}`);
    }
    pauseUntilValue = parsed.toISOString().slice(0, 10);
  } else {
    warnings.push(
      "No resume date provided — introductions stay paused indefinitely until resumed manually."
    );
  }

  await airtable.updateRecords(MEMBERS_TABLE, [
    {
      id: input.airtableRecordId,
      fields: {
        [MEMBER_FIELDS.recurringIntroStatus]: "Paused",
        [MEMBER_FIELDS.recurringPauseUntil]: pauseUntilValue,
      },
    },
  ]);
  logPauseEvent("intro_pause_set", input, {
    pauseUntil: pauseUntilValue || null,
    indefinite: !pauseUntilValue,
  });
  const record = await airtable.getRecord(MEMBERS_TABLE, input.airtableRecordId);
  return { record, warnings };
}

export async function resumeMemberIntros(
  input: PauseActionOptions,
  airtable: AirtableClient = getOpsAirtableClient()
): Promise<{ record: AirtableRecord }> {
  await airtable.updateRecords(MEMBERS_TABLE, [
    {
      id: input.airtableRecordId,
      fields: {
        [MEMBER_FIELDS.recurringIntroStatus]: "Active",
        [MEMBER_FIELDS.recurringPauseUntil]: "",
      },
    },
  ]);
  logPauseEvent("intro_pause_resumed", input);
  const record = await airtable.getRecord(MEMBERS_TABLE, input.airtableRecordId);
  return { record };
}

export interface ExpiredPauseRow {
  airtableRecordId: string;
  name: string;
  email: string;
  pauseUntil: string;
}

/**
 * Members whose intro pause date has passed but whose status is still
 * "Paused". Missing/unparsable dates are never auto-resumed (fail closed) —
 * the ops health scan flags those instead.
 */
export function expiredPausesFromRecords(
  records: AirtableRecord[],
  now: Date = new Date()
): ExpiredPauseRow[] {
  const rows: ExpiredPauseRow[] = [];
  for (const record of records) {
    const status = fieldStr(record.fields, MEMBER_FIELDS.recurringIntroStatus);
    if ((status || "").trim().toLowerCase() !== "paused") continue;
    const pauseUntil = fieldStr(record.fields, MEMBER_FIELDS.recurringPauseUntil);
    const date = parsePauseUntil(pauseUntil || null);
    if (!date) continue;
    if (date.getTime() >= now.getTime()) continue;
    rows.push({
      airtableRecordId: record.id,
      name: fieldStr(record.fields, MEMBER_FIELDS.name),
      email: fieldStr(record.fields, MEMBER_FIELDS.email),
      pauseUntil,
    });
  }
  return rows;
}

export async function listPauseCandidates(
  airtable: AirtableClient = getOpsAirtableClient()
): Promise<AirtableRecord[]> {
  return airtable.listRecords(MEMBERS_TABLE, { fields: PAUSE_FIELDS });
}

export async function autoResumeExpiredPauses(
  airtable: AirtableClient = getOpsAirtableClient(),
  now: Date = new Date()
): Promise<{ resumed: ExpiredPauseRow[] }> {
  const records = await listPauseCandidates(airtable);
  const expired = expiredPausesFromRecords(records, now);
  if (expired.length === 0) return { resumed: [] };

  await airtable.updateRecordsBatched(
    MEMBERS_TABLE,
    expired.map((row) => ({
      id: row.airtableRecordId,
      fields: {
        [MEMBER_FIELDS.recurringIntroStatus]: "Active",
        [MEMBER_FIELDS.recurringPauseUntil]: "",
      },
    }))
  );
  console.error(
    JSON.stringify({
      event: "intro_pause_expired_auto_resumed",
      count: expired.length,
      memberIds: expired.map((r) => r.airtableRecordId),
    })
  );
  return { resumed: expired };
}
