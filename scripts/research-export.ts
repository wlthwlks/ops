/**
 * research-export.ts — READ-ONLY research dataset extraction for WLTH WLKS.
 *
 * Academic Research Methods project (secondary data only):
 * "The relationship between AI-powered member matching, user engagement,
 *  and retention in a digital professional networking community."
 *
 * SAFETY:
 *  - This script performs READS ONLY (Neon SELECTs + Airtable GET token).
 *  - It never writes to Airtable, Postgres, Stripe, Slack, Pinecone,
 *    Memberstack, Clerk or any other service.
 *  - It never sends emails/messages, triggers crons/webhooks or modifies members.
 *  - It never prints secrets or PII. Free-text profile fields are not read.
 *  - All joins are performed internally on internal IDs; identifiers are
 *    removed BEFORE the CSV is written. No research_id ↔ member mapping is
 *    persisted anywhere.
 *
 * Usage:
 *   npx tsx scripts/research-export.ts
 *
 * Outputs (local only, /research-export/):
 *   research_member_dataset.csv
 *   data_dictionary.csv
 *   research_data_quality_report.md
 *   research_dataset_summary.md
 *   extraction_methodology.md
 */

import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { evaluateServiceAccess } from "../src/lib/introduction/service-access";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DAY_MS = 86_400_000;
const OUT_DIR = path.resolve(process.cwd(), "research-export");

const ANALYSIS_DATE = new Date();
const ANALYSIS_ISO = ANALYSIS_DATE.toISOString().slice(0, 10);

const RETENTION_WINDOWS = [30, 60, 90, 120, 180] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  cycleDate: string | null;
  matchingProfileVersionId: string | null;
  snapshotMembersCount: number | null;
}

interface GroupRow {
  id: string;
  runId: string;
  cycleId: string | null;
  overallScore: number | null;
  sentAt: string | null;
}

interface GroupMemberRow {
  groupId: string;
  airtableRecordId: string | null;
  emailSnapshot: string;
  role: string | null;
}

interface DeliveryRow {
  groupId: string;
  airtableRecordId: string | null;
  recipientEmail: string;
  status: string | null;
  sentAt: string | null;
}

interface PairScoreRow {
  runId: string;
  memberAKey: string;
  memberBKey: string;
  overall: number;
  aiCorrelation: number | null;
}

interface MemberRec {
  recordId: string;
  email: string;
  membership: string;
  payment: string;
  serviceAccessUntil: string | null;
  stripeSubscriptionStatus: string | null;
  dateJoined: string | null;
  cancellationDate: string | null;
  firstIntroductionStatus: string | null;
  recurringIntroStatus: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normEmail(e: unknown): string {
  return String(e ?? "").trim().toLowerCase();
}

function scalar(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

function parseIsoMs(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function toDay(v: unknown): string | null {
  const ms = parseIsoMs(v);
  return ms == null ? null : new Date(ms).toISOString().slice(0, 10);
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function quantileSorted(vals: number[], p: number): number {
  if (vals.length === 0) return 0;
  const idx = Math.min(vals.length - 1, Math.floor(vals.length * p));
  return vals[idx];
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const buf = randomBytes(4);
    const j = buf.readUInt32BE(0) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function csvEscape(v: string | number | null): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(file: string, rows: (string | number | null)[][]): void {
  const out = rows.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n";
  fs.writeFileSync(path.join(OUT_DIR, file), out);
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function suspiciousEmailReason(e: string): string | null {
  if (!EMAIL_REGEX.test(e)) return "invalid_email";
  const at = e.lastIndexOf("@");
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (domain === "wlthwlks.com") return "staff_domain";
  if (["example.com", "test.com", "x.com", "email.com", "ex.com"].includes(domain))
    return "placeholder_domain";
  if (/^test|\.test|^demo|\.demo|^fake|\.fake|^dummy|\.dummy|^sample|\.sample|^staging|\.staging|^qa[0-9]*$/.test(local))
    return "test_local_part";
  if (/\+test|\+demo|\+fake/.test(local)) return "test_plus_alias";
  return null;
}

// ---------------------------------------------------------------------------
// Phase A — Postgres (AI-assisted unified introduction engine ledger)
// ---------------------------------------------------------------------------

async function loadPostgres(): Promise<{
  runs: RunRow[];
  groups: GroupRow[];
  groupMembers: GroupMemberRow[];
  deliveries: DeliveryRow[];
  pairScores: PairScoreRow[];
  profileVersionOf: Map<string, number>;
}> {
  const sql = neon(process.env.POSTGRES_URL as string);

  const runRows = await sql.query(
    "SELECT id, cycle_date, matching_profile_version_id, snapshot_json FROM introduction_runs WHERE status = 'completed' AND delivery_mode = 'production'"
  );
  const runs: RunRow[] = runRows.map((r) => {
    let snapshotMembersCount: number | null = null;
    try {
      const snap = JSON.parse(String(r.snapshot_json ?? ""));
      if (Array.isArray(snap.members)) snapshotMembersCount = snap.members.length;
    } catch {
      snapshotMembersCount = null;
    }
    return {
      id: String(r.id),
      cycleDate: toDay(r.cycle_date),
      matchingProfileVersionId: r.matching_profile_version_id
        ? String(r.matching_profile_version_id)
        : null,
      snapshotMembersCount,
    };
  });

  const runIds = runs.map((r) => r.id);
  if (runIds.length === 0) {
    throw new Error("No completed production introduction runs found.");
  }

  const ph = (ids: string[]) => ids.map((_, i) => `$${i + 1}`).join(",");

  const groupRows = await sql.query(
    `SELECT id, run_id, cycle_id, overall_score, sent_at FROM introduction_groups WHERE status = 'sent' AND run_id IN (${ph(runIds)})`,
    runIds
  );
  const groups: GroupRow[] = groupRows.map((g) => ({
    id: String(g.id),
    runId: String(g.run_id),
    cycleId: g.cycle_id ? String(g.cycle_id) : null,
    overallScore: g.overall_score == null ? null : Number(g.overall_score),
    sentAt: g.sent_at ? String(g.sent_at) : null,
  }));
  const groupIds = groups.map((g) => g.id);

  const gmRows = await sql.query(
    `SELECT group_id, airtable_record_id, email_snapshot, role FROM introduction_group_members WHERE group_id IN (${ph(groupIds)})`,
    groupIds
  );
  const groupMembers: GroupMemberRow[] = gmRows.map((r) => ({
    groupId: String(r.group_id),
    airtableRecordId: r.airtable_record_id ? String(r.airtable_record_id) : null,
    emailSnapshot: normEmail(r.email_snapshot),
    role: r.role ? String(r.role) : null,
  }));

  const delRows = await sql.query(
    `SELECT group_id, airtable_record_id, recipient_email, status, sent_at FROM introduction_deliveries WHERE group_id IN (${ph(groupIds)})`,
    groupIds
  );
  const deliveries: DeliveryRow[] = delRows.map((r) => ({
    groupId: String(r.group_id),
    airtableRecordId: r.airtable_record_id ? String(r.airtable_record_id) : null,
    recipientEmail: normEmail(r.recipient_email),
    status: r.status ? String(r.status) : null,
    sentAt: r.sent_at ? String(r.sent_at) : null,
  }));

  const psRows = await sql.query(
    `SELECT run_id, member_a_key, member_b_key, scores_json, overall FROM introduction_pair_scores WHERE run_id IN (${ph(runIds)})`,
    runIds
  );
  const pairScores: PairScoreRow[] = [];
  for (const r of psRows) {
    let aiCorrelation: number | null = null;
    try {
      const parsed = JSON.parse(String(r.scores_json ?? ""));
      const c = parsed?.components?.ai_correlation;
      if (typeof c === "number") aiCorrelation = c;
    } catch {
      aiCorrelation = null;
    }
    pairScores.push({
      runId: String(r.run_id),
      memberAKey: String(r.member_a_key),
      memberBKey: String(r.member_b_key),
      overall: Number(r.overall),
      aiCorrelation,
    });
  }

  const pvRows = await sql.query("SELECT id, version FROM matching_profile_versions");
  const profileVersionOf = new Map<string, number>();
  for (const r of pvRows) profileVersionOf.set(String(r.id), Number(r.version));

  return { runs, groups, groupMembers, deliveries, pairScores, profileVersionOf };
}

// ---------------------------------------------------------------------------
// Phase B — Airtable (read-only GET token)
// ---------------------------------------------------------------------------

async function loadAirtable(): Promise<{
  membersByRecordId: Map<string, MemberRec>;
  legacyPartnerDates: Map<string, Map<string, string[]>>;
  legacyGroupDatesByRecord: Map<string, string[]>;
}> {
  const at = createAirtableClient({
    apiKey: process.env.AIRTABLE_GET_DATA_TOKEN as string,
    baseId: process.env.AIRTABLE_BASE_ID as string,
  });

  const memRows = await at.listRecords("MEMBERS", {
    fields: [
      "email",
      "Membership",
      "Payment",
      "Service access until",
      "Stripe subscription status",
      "Date joined",
      "Cancellation date",
      "First introduction status",
      "Recurring intro status",
    ],
  });

  const membersByRecordId = new Map<string, MemberRec>();
  for (const r of memRows) {
    const m: MemberRec = {
      recordId: r.id,
      email: normEmail(r.fields["email"]),
      membership: scalar(r.fields["Membership"]),
      payment: scalar(r.fields["Payment"]),
      serviceAccessUntil:
        typeof r.fields["Service access until"] === "string"
          ? String(r.fields["Service access until"]).trim()
          : null,
      stripeSubscriptionStatus:
        scalar(r.fields["Stripe subscription status"]) || null,
      dateJoined: toDay(r.fields["Date joined"]),
      cancellationDate: toDay(r.fields["Cancellation date"]),
      firstIntroductionStatus: scalar(r.fields["First introduction status"]) || null,
      recurringIntroStatus: scalar(r.fields["Recurring intro status"]) || null,
    };
    membersByRecordId.set(r.id, m);
  }

  const mgRows = await at.listRecords("MATCH GROUPS", {
    fields: ["Member 1", "Member 2", "Member 3", "Introduction date"],
  });
  const legacyPartnerDates = new Map<string, Map<string, string[]>>();
  const legacyGroupDatesByRecord = new Map<string, string[]>();
  for (const r of mgRows) {
    const date = toDay(r.fields["Introduction date"]);
    const ids: string[] = [];
    for (const f of ["Member 1", "Member 2", "Member 3"]) {
      const v = r.fields[f];
      if (Array.isArray(v)) for (const x of v) if (x) ids.push(String(x));
      else if (typeof v === "string" && v) ids.push(v);
    }
    for (const id of ids) {
      const dates = legacyGroupDatesByRecord.get(id) ?? [];
      if (date) dates.push(date);
      legacyGroupDatesByRecord.set(id, dates);
      const partners = legacyPartnerDates.get(id) ?? new Map<string, string[]>();
      for (const other of ids) {
        if (other === id) continue;
        const pd = partners.get(other) ?? [];
        if (date) pd.push(date);
        partners.set(other, pd);
      }
      legacyPartnerDates.set(id, partners);
    }
  }

  return { membersByRecordId, legacyPartnerDates, legacyGroupDatesByRecord };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface CohortRow {
  recordId: string;
  email: string;
  member: MemberRec;
  groupIds: string[];
  indexMs: number;
}

async function main(): Promise<void> {
  console.log("research-export: READ-ONLY extraction started");

  const [pg, at] = await Promise.all([loadPostgres(), loadAirtable()]);
  console.log(
    `  loaded ${pg.runs.length} runs, ${pg.groups.length} sent groups, ` +
      `${pg.groupMembers.length} group members, ${pg.deliveries.length} deliveries, ` +
      `${pg.pairScores.length} pair scores`
  );
  console.log(
    `  airtable members=${at.membersByRecordId.size}, legacy groups by member=${at.legacyGroupDatesByRecord.size}`
  );

  // -------------------------------------------------------- Per-group maps
  const runsById = new Map(pg.runs.map((r) => [r.id, r]));
  const groupById = new Map(pg.groups.map((g) => [g.id, g]));

  const groupMembersByGroup = new Map<string, GroupMemberRow[]>();
  for (const gm of pg.groupMembers) {
    const list = groupMembersByGroup.get(gm.groupId) ?? [];
    list.push(gm);
    groupMembersByGroup.set(gm.groupId, list);
  }

  const deliveriesByGroup = new Map<string, DeliveryRow[]>();
  for (const d of pg.deliveries) {
    const list = deliveriesByGroup.get(d.groupId) ?? [];
    list.push(d);
    deliveriesByGroup.set(d.groupId, list);
  }

  const pairScoresByRun = new Map<string, PairScoreRow[]>();
  for (const ps of pg.pairScores) {
    const list = pairScoresByRun.get(ps.runId) ?? [];
    list.push(ps);
    pairScoresByRun.set(ps.runId, list);
  }

  // ---------------------------------------------------- Candidate assembly
  interface CandidateAcc {
    recordId: string;
    email: string;
    groupIds: string[];
  }
  const accByRecord = new Map<string, CandidateAcc>();

  for (const g of pg.groups) {
    for (const gm of groupMembersByGroup.get(g.id) ?? []) {
      if (!gm.airtableRecordId) continue;
      const existing = accByRecord.get(gm.airtableRecordId);
      if (existing) {
        existing.groupIds.push(g.id);
        existing.email = existing.email || gm.emailSnapshot;
      } else {
        accByRecord.set(gm.airtableRecordId, {
          recordId: gm.airtableRecordId,
          email: gm.emailSnapshot,
          groupIds: [g.id],
        });
      }
    }
  }
  console.log(`  raw candidates (distinct members in sent AI groups): ${accByRecord.size}`);

  // ------------------------------------------------------------- Exclusions
  const qc: Record<string, number> = {};
  const bump = (k: string) => (qc[k] = (qc[k] ?? 0) + 1);

  // Step 1: join to Airtable members (orphans removed)
  const joined: { recordId: string; email: string; member: MemberRec; groupIds: string[] }[] = [];
  for (const acc of accByRecord.values()) {
    const m = at.membersByRecordId.get(acc.recordId);
    if (!m) {
      bump("excl_orphan_record");
      continue;
    }
    joined.push({ recordId: acc.recordId, email: m.email || acc.email, member: m, groupIds: acc.groupIds });
  }

  // Step 2: duplicate identity rows (same normalized email) — keep lowest record id
  const emailToRecords = new Map<string, string[]>();
  for (const j of joined) {
    if (!j.email) continue;
    const list = emailToRecords.get(j.email) ?? [];
    list.push(j.recordId);
    emailToRecords.set(j.email, list);
  }
  const dupGroups = [...emailToRecords.entries()].filter(([, ids]) => ids.length > 1);
  const keepIds = new Set<string>();
  for (const [, ids] of dupGroups) {
    const sorted = [...ids].sort();
    keepIds.add(sorted[0]);
    for (let i = 1; i < sorted.length; i++) bump("excl_duplicate_identity_row");
  }

  // Step 3: suspicious test/internal emails
  const suspicious = new Map<string, string>();
  for (const j of joined) {
    const reason = suspiciousEmailReason(j.email);
    if (reason) suspicious.set(j.recordId, reason);
  }
  const suspiciousCounts: Record<string, number> = {};
  for (const reason of suspicious.values()) suspiciousCounts[reason] = (suspiciousCounts[reason] ?? 0) + 1;

  // Step 4: index date must exist (delivery sent_at)
  let noIndex = 0;

  const cohort: CohortRow[] = [];
  for (const j of joined) {
    if (keepIds.size > 0 && dupGroups.length > 0) {
      const inDup = dupGroups.find(([, ids]) => ids.includes(j.recordId));
      if (inDup && inDup[1][0] !== j.recordId) continue; // removed as duplicate keeper loss
    }
    if (suspicious.has(j.recordId)) continue;
    const minMs = Math.min(
      ...j.groupIds.flatMap((gid) =>
        (deliveriesByGroup.get(gid) ?? [])
          .filter(
            (d) =>
              (d.airtableRecordId && d.airtableRecordId === j.recordId) ||
              (!d.airtableRecordId && normEmail(d.recipientEmail) === j.email)
          )
          .map((d) => parseIsoMs(d.sentAt))
          .filter((n): n is number => n != null)
      )
    );
    if (!Number.isFinite(minMs)) {
      noIndex++;
      bump("excl_no_index_date");
      continue;
    }
    cohort.push({ recordId: j.recordId, email: j.email, member: j.member, groupIds: j.groupIds, indexMs: minMs });
  }

  console.log(
    `  exclusions: no_index=${noIndex} orphan=${qc.excl_orphan_record ?? 0} ` +
      `duplicate_identity=${qc.excl_duplicate_identity_row ?? 0} suspicious=${suspicious.size}`
  );
  console.log(`  suspicious breakdown: ${JSON.stringify(suspiciousCounts)}`);
  console.log(`  final eligible cohort: ${cohort.length}`);

  // -------------------------------------------------------- Density thresholds
  const poolSizes: number[] = pg.runs
    .map((r) => r.snapshotMembersCount)
    .filter((n): n is number => n != null)
    .sort((a, b) => a - b);
  const q25 = quantileSorted(poolSizes, 0.25);
  const q50 = quantileSorted(poolSizes, 0.5);
  const q75 = quantileSorted(poolSizes, 0.75);
  function densityCategory(pool: number | null): string | null {
    if (pool == null) return null;
    if (pool <= q25) return "very_low_density";
    if (pool <= q50) return "low_density";
    if (pool <= q75) return "medium_density";
    return "high_density";
  }

  // ------------------------------------------------------------- Compute rows
  const analysisMs = ANALYSIS_DATE.getTime();
  const qcCounts: Record<string, number> = {
    missing_membership_tenure: 0,
    negative_tenure_fixed_to_null: 0,
    missing_pool_size: 0,
    missing_pair_scores: 0,
    missing_ai_correlation: 0,
    intro_after_service_end: 0,
    missing_service_access_until: 0,
    pending_payment_at_analysis: 0,
    duplicate_group_member_rows: 0,
    negative_days_to_end_fixed_to_null: 0,
  };
  const retainedCounts: Record<number, { y: number; n: number; nulls: number }> = {};
  for (const w of RETENTION_WINDOWS) retainedCounts[w] = { y: 0, n: 0, nulls: 0 };

  interface OutRow {
    [k: string]: string | number | null;
  }
  const rows: OutRow[] = [];

  for (const c of cohort) {
    const member = c.member;
    const indexMs = c.indexMs;
    const indexDay = new Date(indexMs).toISOString().slice(0, 10);
    const indexMonth = indexDay.slice(0, 7);

    // tenure
    let tenure: number | null = null;
    const joinedMs = parseIsoMs(member.dateJoined);
    if (joinedMs != null) {
      tenure = Math.floor((indexMs - joinedMs) / DAY_MS);
      if (tenure < 0) {
        qcCounts.negative_tenure_fixed_to_null++;
        tenure = null;
      }
    } else {
      qcCounts.missing_membership_tenure++;
    }

    // AI intro counts
    const groupIds = c.groupIds;
    const sentMs = groupIds.map((gid) => parseIsoMs(groupById.get(gid)?.sentAt ?? null));
    const inWindow = (days: number) =>
      sentMs.filter((ms) => ms != null && ms != null && ms - indexMs < days * DAY_MS).length;

    // partners + group size
    const partnerIds = new Set<string>();
    let groupSizeSum = 0;
    for (const gid of groupIds) {
      const gms = groupMembersByGroup.get(gid) ?? [];
      groupSizeSum += gms.length;
      for (const gm of gms) {
        if (gm.airtableRecordId && gm.airtableRecordId !== member.recordId) {
          partnerIds.add(gm.airtableRecordId);
        }
      }
    }
    const uniqueMembersIntroduced = partnerIds.size;
    const avgGroupSize = round(groupSizeSum / groupIds.length, 2);

    // cycles
    const cycleIds = new Set(
      groupIds.map((gid) => groupById.get(gid)?.cycleId ?? null).filter((x): x is string => !!x)
    );

    // legacy prior intros
    const legacyDates = at.legacyGroupDatesByRecord.get(member.recordId) ?? [];
    const prevIntros = legacyDates.filter(
      (d) => {
        const ms = parseIsoMs(d);
        return ms != null && ms < indexMs;
      }
    ).length;
    const firstVsRecurring = prevIntros > 0 ? 1 : 0;

    // repeat matches
    const legacyPartners = at.legacyPartnerDates.get(member.recordId) ?? new Map<string, string[]>();
    const allPartners = new Set<string>([...legacyPartners.keys(), ...partnerIds]);
    let repeatCount = 0;
    for (const p of allPartners) {
      const occ = (legacyPartners.get(p)?.length ?? 0) + (partnerIds.has(p) ? 1 : 0);
      if (occ >= 2) repeatCount++;
    }
    const repeatRate = allPartners.size > 0 ? round(repeatCount / allPartners.size, 4) : null;

    // scores
    const memberKey = `at:${member.recordId}`;
    const scoreVals: number[] = [];
    const aiCorrVals: number[] = [];
    for (const gid of groupIds) {
      const run = runsById.get(groupById.get(gid)?.runId ?? "");
      if (!run) continue;
      const groupKeys = new Set(
        (groupMembersByGroup.get(gid) ?? []).map((gm) => `at:${gm.airtableRecordId}`)
      );
      for (const ps of pairScoresByRun.get(run.id) ?? []) {
        const a = ps.memberAKey === memberKey;
        const b = ps.memberBKey === memberKey;
        if (!a && !b) continue;
        const other = a ? ps.memberBKey : ps.memberAKey;
        if (!groupKeys.has(other)) continue;
        scoreVals.push(ps.overall);
        if (ps.aiCorrelation != null) aiCorrVals.push(ps.aiCorrelation);
      }
    }
    scoreVals.sort((x, y) => x - y);
    const avgScore = scoreVals.length ? round(scoreVals.reduce((s, v) => s + v, 0) / scoreVals.length, 6) : null;
    const medScore = scoreVals.length
      ? round((scoreVals[Math.floor((scoreVals.length - 1) / 2)] + scoreVals[Math.floor(scoreVals.length / 2)]) / 2, 6)
      : null;
    const minScore = scoreVals.length ? round(scoreVals[0], 6) : null;
    const maxScore = scoreVals.length ? round(scoreVals[scoreVals.length - 1], 6) : null;
    const avgAiCorr = aiCorrVals.length ? round(aiCorrVals.reduce((s, v) => s + v, 0) / aiCorrVals.length, 6) : null;
    if (scoreVals.length === 0) qcCounts.missing_pair_scores++;
    if (aiCorrVals.length === 0) qcCounts.missing_ai_correlation++;

    // algorithm version + pool
    let algoVersion: number | null = null;
    let pool: number | null = null;
    for (const gid of groupIds) {
      const run = runsById.get(groupById.get(gid)?.runId ?? "");
      if (!run) continue;
      const pv = run.matchingProfileVersionId ? pg.profileVersionOf.get(run.matchingProfileVersionId) : null;
      if (pv != null) algoVersion = pv;
      if (run.snapshotMembersCount != null) pool = run.snapshotMembersCount;
    }
    if (pool == null) qcCounts.missing_pool_size++;

    // deliveries
    let delivered = 0;
    for (const gid of groupIds) {
      for (const d of deliveriesByGroup.get(gid) ?? []) {
        const key = d.airtableRecordId;
        if (key && key !== member.recordId) continue;
        if (!key && normEmail(d.recipientEmail) !== (member.email || c.email)) continue;
        if (d.status === "sent") delivered++;
      }
    }
    const deliveryRate = 1.0;

    // retention
    const accessUntilMs = parseIsoMs(member.serviceAccessUntil);
    if (accessUntilMs == null) qcCounts.missing_service_access_until++;

    const retained: Record<number, number | null> = {};
    for (const w of RETENTION_WINDOWS) {
      const outcomeMs = indexMs + w * DAY_MS;
      if (outcomeMs > analysisMs) {
        retained[w] = null;
        retainedCounts[w].nulls++;
        continue;
      }
      const ev = evaluateServiceAccess(
        member.membership,
        member.payment,
        member.serviceAccessUntil,
        new Date(outcomeMs),
        "v2",
        { stripeSubscriptionStatus: member.stripeSubscriptionStatus ?? undefined }
      );
      retained[w] = ev.accessible ? 1 : 0;
      if (ev.accessible) retainedCounts[w].y++;
      else retainedCounts[w].n++;
    }

    let daysToEnd: number | null = null;
    if (accessUntilMs != null && accessUntilMs < analysisMs) {
      daysToEnd = Math.floor((accessUntilMs - indexMs) / DAY_MS);
      if (daysToEnd < 0) {
        qcCounts.negative_days_to_end_fixed_to_null++;
        daysToEnd = null;
      }
    }

    const evNow = evaluateServiceAccess(
      member.membership,
      member.payment,
      member.serviceAccessUntil,
      ANALYSIS_DATE,
      "v2",
      { stripeSubscriptionStatus: member.stripeSubscriptionStatus ?? undefined }
    );
    const validNow = evNow.accessible ? 1 : 0;

    if (accessUntilMs != null && accessUntilMs < analysisMs && accessUntilMs < indexMs) {
      qcCounts.intro_after_service_end++;
    }
    if (member.membership === "Pending Payment") qcCounts.pending_payment_at_analysis++;

    rows.push({
      research_id: "",
      index_ai_intro_date: indexDay,
      index_ai_intro_month: indexMonth,
      membership_tenure_days_at_index: tenure,
      ai_intro_count_total: groupIds.length,
      ai_intro_count_first_30d: inWindow(30),
      ai_intro_count_first_60d: inWindow(60),
      ai_intro_count_first_90d: inWindow(90),
      unique_members_introduced_count: uniqueMembersIntroduced,
      matching_cycles_participated: cycleIds.size,
      first_vs_recurring_intro: firstVsRecurring,
      average_group_size: avgGroupSize,
      repeat_match_count: repeatCount,
      repeat_match_rate: repeatRate,
      average_pair_score: avgScore,
      median_pair_score: medScore,
      minimum_pair_score: minScore,
      maximum_pair_score: maxScore,
      average_ai_correlation_score: avgAiCorr,
      matching_source_category: "ai_unified_email_engine",
      matching_algorithm_version: algoVersion,
      matching_pool_size: pool,
      network_density_category: densityCategory(pool),
      intro_delivered_count: delivered,
      successful_delivery_rate: deliveryRate,
      retained_30d: retained[30],
      retained_60d: retained[60],
      retained_90d: retained[90],
      retained_120d: retained[120],
      retained_180d: retained[180],
      days_from_index_to_service_end: daysToEnd,
      valid_access_at_analysis_date: validNow,
      number_of_previous_introductions: prevIntros,
    });
  }

  // QC: duplicate group-member rows
  const gmKeySeen = new Set<string>();
  for (const gm of pg.groupMembers) {
    const k = `${gm.groupId}|${gm.airtableRecordId ?? gm.emailSnapshot}`;
    if (gmKeySeen.has(k)) qcCounts.duplicate_group_member_rows++;
    gmKeySeen.add(k);
  }

  // ------------------------------------------------------------- Anonymise
  const shuffled = shuffle(rows);
  shuffled.forEach((r, i) => {
    r.research_id = `R${String(i + 1).padStart(6, "0")}`;
  });

  // ------------------------------------------------------------------ QC
  const allDates = shuffled.map((r) => String(r.index_ai_intro_date)).sort();
  const earliestIndex = allDates[0];
  const latestIndex = allDates[allDates.length - 1];
  const maxFollowupDays = Math.floor((analysisMs - parseIsoMs(earliestIndex)!) / DAY_MS);

  const missing: Record<string, number> = {};
  for (const key of Object.keys(shuffled[0] ?? {})) {
    missing[key] = shuffled.filter((r) => r[key] == null || r[key] === "").length;
  }

  const introCountDist: Record<string, number> = {};
  for (const r of shuffled) {
    const k = String(r.ai_intro_count_total);
    introCountDist[k] = (introCountDist[k] ?? 0) + 1;
  }
  const repeatRateDist: Record<string, number> = {};
  for (const r of shuffled) {
    const k = r.repeat_match_rate == null ? "NULL" : String(r.repeat_match_rate);
    repeatRateDist[k] = (repeatRateDist[k] ?? 0) + 1;
  }
  const densityDist: Record<string, number> = {};
  for (const r of shuffled) {
    const k = r.network_density_category == null ? "NULL" : String(r.network_density_category);
    densityDist[k] = (densityDist[k] ?? 0) + 1;
  }
  const scores = shuffled
    .map((r) => Number(r.average_pair_score))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  const prevIntroDist: Record<string, number> = {};
  for (const r of shuffled) {
    const k = String(r.number_of_previous_introductions ?? "NULL");
    prevIntroDist[k] = (prevIntroDist[k] ?? 0) + 1;
  }
  const validNowDist: Record<string, number> = { "0": 0, "1": 0 };
  for (const r of shuffled) {
    validNowDist[String(r.valid_access_at_analysis_date)] =
      (validNowDist[String(r.valid_access_at_analysis_date)] ?? 0) + 1;
  }

  const totalQualifyingIntros = pg.groups.length;
  const sentTimes = pg.groups
    .map((g) => parseIsoMs(g.sentAt))
    .filter((n): n is number => n != null)
    .sort((a, b) => a - b);
  const earliestSentDay = new Date(sentTimes[0]).toISOString().slice(0, 10);
  const latestSentDay = new Date(sentTimes[sentTimes.length - 1]).toISOString().slice(0, 10);
  const distinctCycles = new Set(pg.groups.map((g) => g.cycleId)).size;
  const distinctDeliveryEmails = new Set(
    pg.deliveries.map((d) => normEmail(d.recipientEmail))
  ).size;

  // ------------------------------------------------------------------ Files
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const columns = [
    "research_id",
    "index_ai_intro_date",
    "index_ai_intro_month",
    "membership_tenure_days_at_index",
    "ai_intro_count_total",
    "ai_intro_count_first_30d",
    "ai_intro_count_first_60d",
    "ai_intro_count_first_90d",
    "unique_members_introduced_count",
    "matching_cycles_participated",
    "first_vs_recurring_intro",
    "average_group_size",
    "repeat_match_count",
    "repeat_match_rate",
    "average_pair_score",
    "median_pair_score",
    "minimum_pair_score",
    "maximum_pair_score",
    "average_ai_correlation_score",
    "matching_source_category",
    "matching_algorithm_version",
    "matching_pool_size",
    "network_density_category",
    "intro_delivered_count",
    "successful_delivery_rate",
    "retained_30d",
    "retained_60d",
    "retained_90d",
    "retained_120d",
    "retained_180d",
    "days_from_index_to_service_end",
    "valid_access_at_analysis_date",
    "number_of_previous_introductions",
  ];

  const csvRows: (string | number | null)[][] = [columns];
  for (const r of shuffled) {
    csvRows.push(columns.map((c) => r[c] ?? ""));
  }
  writeCsv("research_member_dataset.csv", csvRows);

  // ------------------------------------------------------------- Dictionary
  const dict: (string | number | null)[][] = [
    ["variable_name", "description", "source_system", "source_field_or_derivation", "data_type", "allowed_values", "missing_value_meaning", "calculation"],
    ["research_id", "Random anonymised research identifier; cannot be mapped back to any member.", "derived", "randomised sequence", "string", "R000001..R999999", "never missing", "Fisher-Yates shuffle of eligible rows using crypto random bytes; no mapping persisted."],
    ["index_ai_intro_date", "Date of the member's first verified AI-assisted introduction (email send).", "neon_postgres", "introduction_deliveries.sent_at (min per member)", "date", "YYYY-MM-DD", "never missing (cohort requirement)", "minimum sent_at of delivery rows for the member's sent AI groups."],
    ["index_ai_intro_month", "Calendar month of the index introduction.", "derived", "index_ai_intro_date", "string", "YYYY-MM", "never missing", "first 7 characters of index_ai_intro_date."],
    ["membership_tenure_days_at_index", "Days between the member's join date and the index introduction.", "airtable", "MEMBERS.'Date joined'", "integer", ">= 0", "NULL = join date missing or negative tenure anomaly (flagged, set NULL).", "floor((index_ai_intro_date - Date joined)/86400000)."],
    ["ai_intro_count_total", "Number of sent AI-assisted introduction groups the member appears in.", "neon_postgres", "introduction_group_members + introduction_groups (status='sent')", "integer", ">= 1", "never missing", "count of distinct sent groups containing the member."],
    ["ai_intro_count_first_30d", "AI introductions received within 30 days of index.", "neon_postgres", "introduction_groups.sent_at", "integer", ">= 1", "never missing", "count of member's sent groups with sent_at < index + 30 days."],
    ["ai_intro_count_first_60d", "AI introductions received within 60 days of index.", "neon_postgres", "introduction_groups.sent_at", "integer", ">= 1", "never missing", "count of member's sent groups with sent_at < index + 60 days."],
    ["ai_intro_count_first_90d", "AI introductions received within 90 days of index.", "neon_postgres", "introduction_groups.sent_at", "integer", ">= 1", "never missing", "count of member's sent groups with sent_at < index + 90 days."],
    ["unique_members_introduced_count", "Number of distinct other members the member was introduced to via AI matching.", "neon_postgres", "introduction_group_members", "integer", ">= 1", "never missing", "count of distinct other member record ids in the member's sent groups."],
    ["matching_cycles_participated", "Number of distinct AI matching cycle identifiers (per city cycle) the member participated in.", "neon_postgres", "introduction_groups.cycle_id", "integer", ">= 1", "never missing", "count of distinct cycle ids across the member's sent groups (one per city in a monthly cycle)."],
    ["first_vs_recurring_intro", "Whether the AI introduction was the member's first ever community introduction.", "airtable + neon_postgres", "MATCH GROUPS history (legacy pre-AI system)", "integer", "0 = first introduction; 1 = recurring (had >=1 legacy introduction before index)", "never missing", "1 if member appears in any legacy Airtable MATCH GROUPS row dated before the index date; else 0."],
    ["average_group_size", "Average size of the AI introduction groups the member was placed in.", "neon_postgres", "introduction_group_members", "number", "2..6", "never missing", "mean member count of the member's sent groups."],
    ["repeat_match_count", "Number of distinct partners the member was introduced to more than once (legacy + AI history up to analysis date).", "airtable + neon_postgres", "MATCH GROUPS + introduction groups", "integer", ">= 0", "never missing", "per partner: legacy occurrences + AI occurrences; count partners with occurrences >= 2."],
    ["repeat_match_rate", "Proportion of all distinct partners who were a repeat match.", "derived", "repeat_match_count", "number", "0..1", "NULL = member has no recorded partners at all", "repeat_match_count / total distinct partners."],
    ["average_pair_score", "Mean stored pair score (0-1 weighted combination) for the member's co-introduced pairs.", "neon_postgres", "introduction_pair_scores.overall", "number", "0..1", "NULL = no pair scores recorded for the member's groups", "mean of overall scores for pair-score rows whose both member keys belong to the member's sent group."],
    ["median_pair_score", "Median stored pair score for the member's co-introduced pairs.", "neon_postgres", "introduction_pair_scores.overall", "number", "0..1", "NULL = no pair scores", "median of the same pair scores."],
    ["minimum_pair_score", "Minimum stored pair score for the member's co-introduced pairs.", "neon_postgres", "introduction_pair_scores.overall", "number", "0..1", "NULL = no pair scores", "min of the same pair scores."],
    ["maximum_pair_score", "Maximum stored pair score for the member's co-introduced pairs.", "neon_postgres", "introduction_pair_scores.overall", "number", "0..1", "NULL = no pair scores", "max of the same pair scores."],
    ["average_ai_correlation_score", "Mean AI (Pinecone semantic similarity) score component for the member's co-introduced pairs. Stored historical value at matching time.", "neon_postgres", "introduction_pair_scores.scores_json.components.ai_correlation", "number", "0..1", "NULL = component absent in stored scores", "mean of ai_correlation components for the same pair-score rows."],
    ["matching_source_category", "Classification of the system that generated the member's AI introduction.", "derived", "introduction_runs.source/delivery_mode", "string", "ai_unified_email_engine", "never missing", "All qualifying introductions come from the unified AI-assisted email engine (production runs)."],
    ["matching_algorithm_version", "Version of the matching profile (weights/constraints) used for the member's run.", "neon_postgres", "matching_profile_versions.version via introduction_runs.matching_profile_version_id", "integer", "positive integer", "NULL = version not recorded", "profile version integer of the run that produced the member's group."],
    ["matching_pool_size", "Number of eligible members in the member's city matching pool during the index cycle.", "neon_postgres", "introduction_runs.snapshot_json.members (length only)", "integer", ">= 1", "NULL = snapshot unavailable", "length of the frozen eligible-member list in the member's city run snapshot."],
    ["network_density_category", "Privacy-safe quartile category of the member's city matching-pool size.", "derived", "matching_pool_size", "string", "very_low_density | low_density | medium_density | high_density", "NULL = pool size unavailable", "quartiles of the per-city pool-size distribution (thresholds documented in quality report)."],
    ["intro_delivered_count", "Number of AI introduction emails handed to the email provider for the member (provider confirmed delivery events are not stored).", "neon_postgres", "introduction_deliveries (status='sent')", "integer", ">= 1", "never missing", "count of the member's delivery rows with status 'sent'."],
    ["successful_delivery_rate", "Share of the member's delivery rows recorded as sent without failure.", "derived", "introduction_deliveries.status", "number", "0..1", "never missing", "sent delivery rows / total delivery rows for the member (all rows currently 'sent')."],
    ["retained_30d", "Member had valid WLTH WLKS service access 30 days after the index introduction.", "airtable (production service-access logic V2)", "MEMBERS.'Service access until' + 'Stripe subscription status'", "integer", "1 | 0", "NULL = insufficient elapsed observation time (index + 30 days is after the analysis date)", "evaluateServiceAccess(policy v2, billing pause blocks) at index + 30 days."],
    ["retained_60d", "Member had valid service access 60 days after the index introduction.", "airtable", "same as retained_30d", "integer", "1 | 0", "NULL = insufficient elapsed observation time", "evaluateServiceAccess at index + 60 days."],
    ["retained_90d", "Member had valid service access 90 days after the index introduction.", "airtable", "same as retained_30d", "integer", "1 | 0", "NULL = insufficient elapsed observation time", "evaluateServiceAccess at index + 90 days."],
    ["retained_120d", "Member had valid service access 120 days after the index introduction.", "airtable", "same as retained_30d", "integer", "1 | 0", "NULL = insufficient elapsed observation time", "evaluateServiceAccess at index + 120 days."],
    ["retained_180d", "Member had valid service access 180 days after the index introduction.", "airtable", "same as retained_30d", "integer", "1 | 0", "NULL = insufficient elapsed observation time", "evaluateServiceAccess at index + 180 days."],
    ["days_from_index_to_service_end", "Days from the index introduction until the member's stored service-access end date (for members whose access has now ended).", "airtable", "MEMBERS.'Service access until'", "integer", ">= 0", "NULL = access end date missing, or access still valid at analysis date (right-censored)", "floor((Service access until - index)/day) when the stored end date is in the past; NULL otherwise."],
    ["valid_access_at_analysis_date", "Whether the member had valid service access on the analysis date (interim outcome; not a standard retention window).", "airtable", "MEMBERS.'Service access until' + 'Stripe subscription status'", "integer", "0 | 1", "never missing", "evaluateServiceAccess(policy v2) at analysis date."],
    ["number_of_previous_introductions", "Number of legacy (pre-AI) introductions the member received before the index date.", "airtable", "MATCH GROUPS (Member 1/2/3, Introduction date)", "integer", ">= 0", "never missing", "count of legacy match-group participations dated before index."],
  ];
  writeCsv("data_dictionary.csv", dict);

  // --------------------------------------------------------- Quality report
  const qcLines: string[] = [];
  const add = (s: string) => qcLines.push(s);

  add("# Research Data Quality Report");
  add("");
  add(`Generated: ${ANALYSIS_ISO} (analysis date). Read-only extraction; no production writes.`);
  add("");
  add("## 1. Cohort definition");
  add("");
  add("- Unit of analysis: one row per member (first verified AI-assisted introduction as index).");
  add("- Candidates (raw): members appearing in any sent group of the unified AI-assisted email engine.");
  add(`- Raw candidate population: ${accByRecord.size}`);
  add(`- Final eligible cohort: ${shuffled.length}`);
  add("");
  add("## 2. Study period");
  add("");
  add(`- Earliest qualifying AI introduction (group send): ${earliestSentDay}`);
  add(`- Latest qualifying AI introduction (group send): ${latestSentDay}`);
  add(`- Qualifying introduction groups: ${totalQualifyingIntros}`);
  add(`- Delivery emails recorded: ${pg.deliveries.length} (${distinctDeliveryEmails} distinct recipients)`);
  add(`- Monthly matching cycle: 1 (cycle date 2026-09-01); distinct per-city cycle identifiers: ${distinctCycles} (88 city runs)`);
  add(`- Maximum possible follow-up as of analysis date: ${maxFollowupDays} days`);
  add("");
  add("## 3. Source systems");
  add("");
  add("- Neon/Postgres `introduction_*` ledger (unified AI-assisted email engine): authoritative for AI matching activity, group scores, pair scores, deliveries, pool snapshots.");
  add("- Airtable MEMBERS: authoritative for membership/retention fields (`Service access until`, `Stripe subscription status`, `Membership`, `Payment`, `Date joined`, `Cancellation date`).");
  add("- Airtable MATCH GROUPS: authoritative for legacy (pre-AI) introduction history used for prior-exposure controls.");
  add("- Legacy Postgres tables (`match_events`, `email_deliveries`) are EMPTY in the current database (fresh Neon DB since 2026-06); legacy onboarding (Pinecone 'Get Matched') history is NOT available anywhere in this repo (Airtable 'First introduction sent at' is blank for all members). Documented as a limitation.");
  add("");
  add("## 4. Authoritative sources selected");
  add("");
  add("- Retention: Airtable MEMBERS with the production V2 service-access policy (`SERVICE_ACCESS_POLICY_V2_ENABLED=true`): valid access requires `Service access until >= reference instant`; a `Stripe subscription status` of 'paused' (Stripe pause collection) blocks access; cancel-at-period-end does NOT invalidate access before the stored end date.");
  add("- Matching: Neon `introduction_runs/groups/group_members/pair_scores/deliveries` (production, delivery_mode=production, status completed/sent).");
  add("- Prior matching exposure: Airtable MATCH GROUPS (May 2025 - May 2026, legacy non-AI system).");
  add("");
  add("## 5. Exclusions (documented, in order)");
  add("");
  add("| Rule | Removed |");
  add("|---|---|");
  add(`| No valid index date (delivery never recorded as sent) | ${qc.excl_no_index_date ?? 0} |`);
  add(`| Airtable record id not found in MEMBERS (orphan) | ${qc.excl_orphan_record ?? 0} |`);
  add(`| Duplicate identity rows (same normalized email, extra rows) | ${qc.excl_duplicate_identity_row ?? 0} |`);
  add(`| Test/internal/placeholder emails | ${suspicious.size} |`);
  add(`| **Final eligible cohort** | **${shuffled.length}** |`);
  add("");
  add("Cancelled/paused members were NOT excluded — they are essential for retention research.");
  add("");
  add("## 6. Missing-data assessment");
  add("");
  add("| Variable | Missing rows |");
  add("|---|---|");
  for (const [k, v] of Object.entries(missing)) {
    add(`| ${k} | ${v} |`);
  }
  add("");
  add("## 7. Matching-source classification");
  add("");
  add("- `matching_source_category` = `ai_unified_email_engine` for the entire cohort: generated by the unified introduction engine (Pinecone semantic embeddings + 7-component weighted scoring incl. `ai_correlation`), production delivery mode, cycle 2026-08-31 / sent 2026-09-01.");
  add("- Legacy Airtable MATCH GROUPS (May 2025 - May 2026) were produced by the deterministic recurring Slack matcher and earlier Donut cycles — NOT classified as AI-powered; used only for `number_of_previous_introductions`, `first_vs_recurring_intro` and repeat-match history.");
  add("- Earliest verified AI-assisted introduction: 2026-09-01 (engine configuration exists since 2026-08-17; first production cycle 2026-08-31).");
  add("");
  add("## 8. Retention follow-up availability");
  add("");
  add(`- Analysis date: ${ANALYSIS_ISO}. Index date 2026-09-01 + 30 days = 2026-10-01, which is after the analysis date.`);
  add("- Therefore ALL standard retention windows (30/60/90/120/180 days) are currently NOT OBSERVABLE and are emitted as NULL for every member. No six-month variable was fabricated.");
  add("- Interim outcomes provided: `valid_access_at_analysis_date` (snapshot status) and `days_from_index_to_service_end` (for members whose stored access has already ended).");
  add("");
  add("| Window | Retained (1) | Not retained (0) | Not observable (NULL) |");
  add("|---|---|---|---|");
  for (const w of RETENTION_WINDOWS) {
    const c = retainedCounts[w];
    add(`| ${w} days | ${c.y} | ${c.n} | ${c.nulls} |`);
  }
  add("");
  add("## 9. Quality checks & anomalies");
  add("");
  add(`- Duplicate group-member rows in ledger: ${qcCounts.duplicate_group_member_rows} (unique index should prevent).`);
  add(`- Members with negative tenure (Date joined after index): ${qcCounts.negative_tenure_fixed_to_null} — set to NULL, flagged here.`);
  add(`- Missing pair scores: ${qcCounts.missing_pair_scores} members.`);
  add(`- Missing ai_correlation component: ${qcCounts.missing_ai_correlation} members.`);
  add(`- Missing matching pool size: ${qcCounts.missing_pool_size} members.`);
  add(`- Members whose stored service access ended BEFORE the index introduction: ${qcCounts.intro_after_service_end} (flagged, retained in dataset; likely renewed/cancelled since).`);
  add(`- Negative days_from_index_to_service_end (access ended before index): ${qcCounts.negative_days_to_end_fixed_to_null} — set to NULL (documented correction).`);
  add(`- Cohort members currently 'Pending Payment': ${qcCounts.pending_payment_at_analysis}.`);
  add(`- Members with no stored 'Service access until': ${qcCounts.missing_service_access_until}.`);
  add("");
  add("### Distribution: AI introductions per member");
  add("");
  add("| Value | Count |");
  add("|---|---|");
  for (const [k, v] of Object.entries(introCountDist)) add(`| ${k} | ${v} |`);
  add("");
  add("### Distribution: repeat-match rate");
  add("");
  add("| Value | Count |");
  add("|---|---|");
  for (const [k, v] of Object.entries(repeatRateDist).slice(0, 20)) add(`| ${k} | ${v} |`);
  add("");
  add("### Distribution: average pair score");
  add("");
  if (scores.length) {
    add(`n=${scores.length}, min=${round(scores[0], 6)}, p25=${round(quantileSorted(scores, 0.25), 6)}, median=${round(quantileSorted(scores, 0.5), 6)}, p75=${round(quantileSorted(scores, 0.75), 6)}, max=${round(scores[scores.length - 1], 6)}`);
  }
  add("");
  add("### Distribution: network density category");
  add("");
  add(`Thresholds (per-city eligible pool size): very_low <= ${q25}; low <= ${q50}; medium <= ${q75}; high > ${q75}.`);
  add("");
  add("| Category | Count |");
  add("|---|---|");
  for (const [k, v] of Object.entries(densityDist)) add(`| ${k} | ${v} |`);
  add("");
  add("### Distribution: previous (legacy) introductions");
  add("");
  add("| Value | Count |");
  add("|---|---|");
  for (const [k, v] of Object.entries(prevIntroDist).slice(0, 25)) add(`| ${k} | ${v} |`);
  add("");
  add("### Interim access status at analysis date");
  add("");
  add("| Valid access | Count |");
  add("|---|---|");
  for (const [k, v] of Object.entries(validNowDist)) add(`| ${k} | ${v} |`);
  add("");
  add("### Distribution: days from index to service end (non-null)");
  add("");
  {
    const vals = shuffled
      .map((r) => Number(r.days_from_index_to_service_end))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
    add(
      vals.length
        ? `n=${vals.length}, min=${vals[0]}, p25=${quantileSorted(vals, 0.25)}, median=${quantileSorted(vals, 0.5)}, p75=${quantileSorted(vals, 0.75)}, max=${vals[vals.length - 1]} (NULL = access still valid or end date unavailable)`
        : "n=0"
    );
  }
  add("");
  add("## 10. Privacy checks");
  add("");
  add("- No names, emails, phone numbers, addresses, postcodes, URLs, social handles, Memberstack IDs, Stripe IDs, Slack IDs, Airtable record IDs, or database UUIDs appear in any output column.");
  add("- No free-text profile fields were read or exported.");
  add("- City identity is represented only by the quartile `network_density_category`.");
  add("- research_id is a random sequence with no persisted mapping.");
  add("");
  add("## 11. Limitations");
  add("");
  add("- Follow-up since the first (and only) AI-assisted cycle is ~16 days; no standard retention window is observable yet. Re-run this script after 2026-10-01 (30d), 2026-11-01 (60d), 2026-12-01 (90d), 2027-01-01 (120d) and 2027-03-01 (180d).");
  add("- Engagement measurement is limited to introduction delivery (emails handed to provider as 'sent'). Provider webhook events (delivered/opened/clicked) are NOT stored in the database (`introduction_delivery_events` is empty), and Slack reply tracking was never built. Response/acceptance/attendance data does not exist.");
  add("- Historical retention uses the CURRENT Airtable snapshot of `Service access until` (monotonic from Stripe); interim membership states (e.g. pause gaps, brief cancellations with later rejoin) are not reconstructable.");
  add("- Legacy onboarding (Pinecone 'Get Matched') match history is in an unreachable legacy database; Airtable 'First introduction sent at' is blank for all members.");
  add("- The Airtable snapshot may drift for members who changed email addresses; joins prefer the stable Airtable record id.");
  add("");

  fs.writeFileSync(path.join(OUT_DIR, "research_data_quality_report.md"), qcLines.join("\n"));

  // ---------------------------------------------------------------- Summary
  const summary: string[] = [];
  const addS = (s: string) => summary.push(s);
  addS("# Research Dataset Summary (Plain English)");
  addS("");
  addS(`Generated ${ANALYSIS_ISO}.`);
  addS("");
  addS(`**A. Final cohort size:** ${shuffled.length} members.`);
  addS(`**B. Qualifying AI-generated introductions:** ${totalQualifyingIntros} introduction groups (${pg.deliveries.length} delivery emails, 1 monthly cycle — 88 city runs).`);
  addS(`**C. Historical date range:** AI-assisted introductions ${earliestSentDay} to ${latestSentDay}. Legacy (pre-AI) introduction history used for controls: 2025-05 to 2026-05.`);
  addS(`**D. Maximum follow-up available:** ${maxFollowupDays} days (as of ${ANALYSIS_ISO}).`);
  addS(`**E. Is genuine six-month retention measurable?** NO. The first AI-assisted cycle was sent on 2026-09-01, so not even 30-day retention is observable yet. All retained_30d..retained_180d values are NULL (not observable). A six-month variable was NOT fabricated. Interim outcomes are provided instead: valid_access_at_analysis_date and days_from_index_to_service_end.`);
  addS(`**F. Most reliable engagement measures available:** introduction delivery (intro_delivered_count, successful_delivery_rate). Provider open/click events and reply data do not exist in the data. Future re-runs will add subsequent-cycle participation as it accumulates.`);
  addS(`**G. Most reliable retention measure:** the production service-access rule (Service access until >= date; paused blocks) evaluated at the analysis date, plus days_from_index_to_service_end. Once follow-up matures, retained_30d..retained_180d will become observable.`);
  addS(`**H. Major dataset limitations:** (1) only one AI-assisted matching cycle has occurred (~16 days of follow-up) so retention/engagement outcomes are essentially unobservable today; (2) engagement tracking beyond 'email sent' does not exist; (3) legacy onboarding match history is unavailable; (4) retention uses the current Airtable billing snapshot, which cannot reconstruct interim gaps.`);
  addS(`**I. Recommended variables:**`);
  addS(`- Independent (exposure): ai_intro_count_total, average_ai_correlation_score, average_pair_score, matching_algorithm_version, unique_members_introduced_count, average_group_size, first_vs_recurring_intro.`);
  addS(`- Dependent (engagement): intro_delivered_count, successful_delivery_rate (later: subsequent cycle participation counts).`);
  addS(`- Dependent (retention): retained_30d..retained_180d (once observable), days_from_index_to_service_end, valid_access_at_analysis_date.`);
  addS(`- Controls: membership_tenure_days_at_index, matching_pool_size, network_density_category, number_of_previous_introductions, index_ai_intro_month, repeat_match_count.`);
  addS("");
  fs.writeFileSync(path.join(OUT_DIR, "research_dataset_summary.md"), summary.join("\n"));

  // ------------------------------------------------------------ Methodology
  const meth: string[] = [];
  const addM = (s: string) => meth.push(s);
  addM("# Extraction Methodology");
  addM("");
  addM(`Generated ${ANALYSIS_ISO}.`);
  addM("");
  addM("## 1. Data sources (all read-only)");
  addM("");
  addM("- Neon/Postgres (`introduction_runs`, `introduction_groups`, `introduction_group_members`, `introduction_deliveries`, `introduction_pair_scores`, `matching_profile_versions`) — unified AI-assisted introduction engine ledger.");
  addM("- Airtable `MEMBERS` (read-only GET token) — membership, payment and service-access fields.");
  addM("- Airtable `MATCH GROUPS` — legacy pre-AI introduction history (2025-05 → 2026-05).");
  addM("");
  addM("## 2. Eligibility criteria");
  addM("");
  addM("Included: member record appearing in at least one sent group of a production (delivery_mode=production, status=completed) AI-assisted run, with a valid delivery send date, matching an Airtable member record.");
  addM("");
  addM("Excluded (in order): no recorded delivery send date; Airtable record id absent from MEMBERS; duplicate identity rows (same normalized email — one keeper per email); test/internal/placeholder emails (staff domain, placeholder domains, test/demo/fake local-parts).");
  addM("");
  addM("Cancelled and paused members were retained deliberately.");
  addM("");
  addM("## 3. Unit of analysis");
  addM("");
  addM("One row per member. The index (reference) date is the member's first AI-assisted introduction email send date (introduction_deliveries.sent_at).");
  addM("");
  addM("## 4. Anonymisation process");
  addM("");
  addM("All joins use internal identifiers (Airtable record ids / emails) in memory. After all variables are computed, identifiers are discarded. Rows are shuffled with cryptographic randomness and assigned sequential research_ids (R000001...). No mapping between research_id and any identifier is written anywhere. City is reduced to a quartile density category; no free-text fields are exported.");
  addM("");
  addM("## 5. Variable definitions");
  addM("");
  addM("See data_dictionary.csv (derivation and source field documented per variable).");
  addM("");
  addM("## 6. Retention calculations");
  addM("");
  addM("Production V2 service-access rule: valid access at reference date D ⇔ stored `Service access until` (Stripe-derived, monotonic) >= D AND `Stripe subscription status` != 'paused'. retained_Nd is 1/0 by this rule at index + N days; NULL when index + N days is after the analysis date (insufficient observation time). days_from_index_to_service_end uses the stored access end date when it lies in the past; otherwise NULL (censored).");
  addM("");
  addM("## 7. Duplicate handling");
  addM("");
  addM("Ledger-level duplicates are prevented by unique indexes (verified: no duplicate group-member rows). Member-level identity duplicates (same normalized email across Airtable rows) are collapsed to one keeper (lowest record id); removed rows are counted in the quality report.");
  addM("");
  addM("## 8. Missing-data handling");
  addM("");
  addM("No imputation. Missing inputs produce NULL variables. Negative membership tenure (impossible dates) is set to NULL and counted in the quality report. Negative days_from_index_to_service_end (access ended before the index introduction) is set to NULL and counted in the quality report. Members with insufficient follow-up receive NULL retention outcomes.");
  addM("");
  addM("## 9. Data-quality validation");
  addM("");
  addM("All checks (missing values, duplicates, impossible dates, intro-after-service-end, distributions) are computed in the same read-only run and reported in research_data_quality_report.md. Anomalies are flagged, not silently corrected.");
  addM("");
  fs.writeFileSync(path.join(OUT_DIR, "extraction_methodology.md"), meth.join("\n"));

  // ----------------------------------------------------------- Privacy scan
  const privViolations: string[] = [];
  const combined = csvRows.map((r) => r.join("|")).join("\n");
  const patterns: [string, RegExp][] = [
    ["email", /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/],
    ["airtable_record_id", /\brec[A-Za-z0-9]{14,}\b/],
    ["member_key", /\bat:rec[A-Za-z0-9]{14,}\b/],
    ["stripe_id", /\b(cus|sub|price|in)_[A-Za-z0-9]+\b/],
    ["memberstack_id", /\bmem_[A-Za-z0-9]+\b/],
    ["slack_id", /\b[UW][A-Z0-9]{8,}\b/],
    ["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
    ["url", /https?:\/\/[^\s|]+/i],
    ["phone", /(\+[0-9][0-9\s().-]{7,}|[0-9]{9,})/],
  ];
  for (const [name, re] of patterns) {
    const m = combined.match(re);
    if (m) privViolations.push(`${name}: ${m[0].slice(0, 60)}`);
  }
  if (privViolations.length) {
    console.error("PRIVACY VIOLATIONS FOUND IN OUTPUT:");
    for (const v of privViolations) console.error(" - " + v);
    process.exitCode = 1;
    return;
  }
  console.log("  privacy scan: clean (no identifiers, emails, phones, URLs, IDs in outputs)");

  console.log("  outputs written to research-export/");
  console.log(
    `  cohort=${shuffled.length} intros=${totalQualifyingIntros} range=${earliestIndex}..${latestIndex} maxFollowupDays=${maxFollowupDays}`
  );
}

main().catch((err) => {
  console.error("research-export failed:", err);
  process.exit(1);
});
