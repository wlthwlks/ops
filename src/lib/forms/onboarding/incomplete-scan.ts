/**
 * Scan Airtable for stale incomplete onboarding rows (bounded).
 * Does not touch matching/introductions.
 */
import { getFormsAirtableClient } from "@/lib/forms/airtable/members-sync";
import { MEMBER_FIELDS, MEMBERS_TABLE } from "@/lib/ops/airtable-fields";
import { recordIntegrationError } from "@/lib/forms/webhooks/store";

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

const STALE_STATUSES = [
  "ACCOUNT_CREATED",
  "LOCATION",
  "BUSINESS",
  "PAYMENT_PENDING",
  "GOAL",
  "HELP_WANTED",
  "EXPERTISE",
  "CONNECTION",
];

export async function scanIncompleteOnboarding(input?: {
  staleHours?: number;
  maxRecords?: number;
}): Promise<{
  checked: number;
  stale: number;
  samples: Array<{
    airtableRecordId: string;
    email: string;
    onboardingStatus: string;
    memberstackId: string;
  }>;
}> {
  const staleHours = input?.staleHours ?? 48;
  const maxRecords = input?.maxRecords ?? 100;
  const cutoff = Date.now() - staleHours * 3600_000;

  const airtable = getFormsAirtableClient();
  // Filter formula: onboarding status in incomplete set (best-effort; field must exist)
  const statusOr = STALE_STATUSES.map(
    (s) => `{${MEMBER_FIELDS.onboardingStatus}} = '${s}'`
  ).join(", ");
  let records;
  try {
    records = await airtable.listRecords(MEMBERS_TABLE, {
      filterByFormula: `OR(${statusOr})`,
      maxRecords,
      fields: [
        MEMBER_FIELDS.email,
        MEMBER_FIELDS.onboardingStatus,
        MEMBER_FIELDS.memberstackId,
        MEMBER_FIELDS.dateJoined,
        MEMBER_FIELDS.name,
      ],
    });
  } catch {
    // Field may not exist yet
    return { checked: 0, stale: 0, samples: [] };
  }

  const samples: Array<{
    airtableRecordId: string;
    email: string;
    onboardingStatus: string;
    memberstackId: string;
  }> = [];

  for (const r of records) {
    const status = fieldStr(r.fields, MEMBER_FIELDS.onboardingStatus);
    const joined = fieldStr(r.fields, MEMBER_FIELDS.dateJoined);
    const joinedMs = joined ? new Date(joined).getTime() : NaN;
    // Prefer date joined; if missing treat as stale candidate
    const isOld = !Number.isFinite(joinedMs) || joinedMs < cutoff;
    if (!isOld) continue;
    samples.push({
      airtableRecordId: r.id,
      email: fieldStr(r.fields, MEMBER_FIELDS.email),
      onboardingStatus: status,
      memberstackId: fieldStr(r.fields, MEMBER_FIELDS.memberstackId),
    });
  }

  if (samples.length > 0) {
    await recordIntegrationError({
      code: "ONBOARDING_STATE_INVALID",
      source: "cron",
      operation: "check-incomplete-onboarding",
      title: `${samples.length} incomplete onboarding member(s) older than ${staleHours}h`,
      message: samples
        .slice(0, 10)
        .map((s) => `${s.email || s.airtableRecordId}:${s.onboardingStatus}`)
        .join("; "),
      severity: "warning",
      details: { count: samples.length, samples: samples.slice(0, 20) },
    });
  }

  return { checked: records.length, stale: samples.length, samples: samples.slice(0, 50) };
}
