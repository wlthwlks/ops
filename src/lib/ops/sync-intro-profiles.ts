import type { Op, OpContext } from "../types";
import {
  createAirtableClient,
  type AirtableClient,
  type AirtableRecord,
} from "../integrations/airtable";
import { createPineconeClient, type PineconeClient } from "../integrations/pinecone";
import { embedTexts } from "../integrations/openai-embeddings";
import { CITIES, type CityGroup } from "../constants";
import type { AppDb } from "@/db";
import { introductionMemberProfiles } from "@/db/schema";
import { inArray, sql } from "drizzle-orm";
import { MEMBER_FIELDS } from "./airtable-fields";
import {
  SEMANTIC_KINDS,
  buildSemanticTexts,
  computeProfileHash,
  hasNoSemanticContent,
  recordIdFromVectorId,
  semanticFieldsFromRecord,
  vectorIdFor,
  type SemanticKind,
} from "@/lib/introduction/semantic-profile";

export const DEFAULT_SEMANTIC_NAMESPACE = "intro_v2";

export interface IntroSyncDeps {
  airtable: AirtableClient;
  pinecone: PineconeClient;
  db: AppDb;
  log: (message: string) => void;
}

export interface IntroSyncOptions {
  /** City label from the CITIES list; default "All Cities". */
  cityLabel?: string;
  dryRun?: boolean;
  namespace?: string;
  now?: Date;
}

export interface IntroSyncResult {
  success: boolean;
  summary: string;
  fetched: number;
  embedded: number;
  vectorsUpserted: number;
  skipped: number;
  unchanged: number;
  deletedVectors: number;
  errors: string[];
  dryRun: boolean;
  namespace: string;
}

function buildCityFilter(cityGroup: CityGroup): string {
  const conditions = [cityGroup.label, ...cityGroup.alternatives].map(
    (name) => `FIND(LOWER("${name}"), LOWER({City}))`
  );
  return `AND({Membership} = "Active", {Cancellation date} = "", OR(${conditions.join(", ")}))`;
}

function buildAllCitiesFilter(): string {
  return `AND({Membership} = "Active", {Cancellation date} = "")`;
}

const SYNC_FIELDS = [
  "email",
  "Name",
  "First Name",
  "Last Name",
  "City",
  MEMBER_FIELDS.professionalHeadline,
  MEMBER_FIELDS.profileBio,
  MEMBER_FIELDS.businessDescription,
  MEMBER_FIELDS.ninetyDayGoal,
  MEMBER_FIELDS.helpWanted,
  MEMBER_FIELDS.helpWantedContext,
  MEMBER_FIELDS.expertise,
  MEMBER_FIELDS.expertiseContext,
  MEMBER_FIELDS.connectionType,
];

interface MemberEmbedInput {
  record: AirtableRecord;
  email: string;
  city: string;
  hash: string;
  noContent: boolean;
  nonEmptyKinds: SemanticKind[];
  texts: Record<SemanticKind, string>;
}

function prepareMember(record: AirtableRecord): MemberEmbedInput | null {
  const email = String(record.fields["email"] ?? "").trim().toLowerCase();
  if (!email) return null;
  const fields = semanticFieldsFromRecord(record);
  const texts = buildSemanticTexts(fields);
  const kinds = {
    profile: texts.profileText,
    help: texts.helpText,
    expertise: texts.expertiseText,
    goal: texts.goalText,
  } as Record<SemanticKind, string>;
  const nonEmptyKinds = SEMANTIC_KINDS.filter((kind) => kinds[kind]);
  return {
    record,
    email,
    city: String(record.fields["City"] ?? ""),
    hash: computeProfileHash(fields),
    noContent: hasNoSemanticContent(texts),
    nonEmptyKinds,
    texts: kinds,
  };
}

/**
 * Incremental semantic-profile sync for the unified introduction engine.
 * Embeds the semantic fields (never location/industry/stage) into the
 * dedicated Pinecone namespace and only re-embeds members whose semantic
 * profile hash changed. Stale vectors are deleted on all-cities runs.
 */
export async function runIntroProfileSync(
  deps: IntroSyncDeps,
  options: IntroSyncOptions = {}
): Promise<IntroSyncResult> {
  const namespace =
    options.namespace ?? process.env.INTRO_SEMANTIC_NAMESPACE ?? DEFAULT_SEMANTIC_NAMESPACE;
  const cityLabel = options.cityLabel ?? "All Cities";
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const errors: string[] = [];

  const isAllCities = cityLabel === "All Cities";
  const cityGroups: CityGroup[] = isAllCities
    ? CITIES
    : CITIES.filter((c) => c.label === cityLabel);
  if (!isAllCities && cityGroups.length === 0) {
    return {
      success: false,
      summary: `City "${cityLabel}" not found in CITIES list`,
      fetched: 0,
      embedded: 0,
      vectorsUpserted: 0,
      skipped: 0,
      unchanged: 0,
      deletedVectors: 0,
      errors: [`Unknown city "${cityLabel}"`],
      dryRun,
      namespace,
    };
  }

  // ─── Fetch members ───
  deps.log(`Fetching ${isAllCities ? "all active" : cityLabel} members from Airtable...`);
  let records: AirtableRecord[] = [];
  if (isAllCities) {
    records = await deps.airtable.listRecords("MEMBERS", {
      filterByFormula: buildAllCitiesFilter(),
      fields: SYNC_FIELDS,
    });
  } else {
    for (const cityGroup of cityGroups) {
      const batch = await deps.airtable.listRecords("MEMBERS", {
        filterByFormula: buildCityFilter(cityGroup),
        fields: SYNC_FIELDS,
      });
      records.push(...batch);
    }
  }
  deps.log(`Found ${records.length} member(s)`);

  // ─── Compute hashes & classify ───
  const prepared: MemberEmbedInput[] = [];
  let noEmail = 0;
  for (const record of records) {
    const member = prepareMember(record);
    if (!member) {
      noEmail += 1;
      continue;
    }
    prepared.push(member);
  }

  const preparedById = new Map(prepared.map((m) => [m.record.id, m]));
  const storedRows = prepared.length
    ? await deps.db
        .select()
        .from(introductionMemberProfiles)
        .where(inArray(introductionMemberProfiles.airtableRecordId, [...preparedById.keys()]))
    : [];
  const storedHashById = new Map(storedRows.map((r) => [r.airtableRecordId, r.profileHash]));

  const toEmbed: MemberEmbedInput[] = [];
  let unchanged = 0;
  let noContent = 0;
  for (const member of prepared) {
    if (member.noContent) {
      noContent += 1;
      continue;
    }
    if (storedHashById.get(member.record.id) === member.hash) {
      unchanged += 1;
      continue;
    }
    toEmbed.push(member);
  }

  deps.log(
    `Classification: ${toEmbed.length} to embed, ${unchanged} unchanged, ${noContent} without semantic content, ${noEmail} without email`
  );

  // ─── Dry run: report only ───
  if (dryRun) {
    const summary = [
      `${records.length} fetched`,
      `${toEmbed.length} would embed`,
      `${unchanged} unchanged`,
      `${noContent} skipped (no semantic content)`,
    ].join(", ");
    deps.log(`Dry run complete: ${summary}`);
    return {
      success: true,
      summary: `${cityLabel} (dry run): ${summary}`,
      fetched: records.length,
      embedded: 0,
      vectorsUpserted: 0,
      skipped: noContent,
      unchanged,
      deletedVectors: 0,
      errors,
      dryRun,
      namespace,
    };
  }

  // ─── Embed & upsert ───
  let vectorsUpserted = 0;
  let embedded = 0;

  if (toEmbed.length > 0) {
    const jobs: Array<{ member: MemberEmbedInput; kind: SemanticKind; text: string }> = [];
    for (const member of [...toEmbed].sort((a, b) => a.record.id.localeCompare(b.record.id))) {
      for (const kind of SEMANTIC_KINDS) {
        if (member.nonEmptyKinds.includes(kind)) {
          jobs.push({ member, kind, text: member.texts[kind] });
        }
      }
    }

    deps.log(`Generating ${jobs.length} embedding(s) for ${toEmbed.length} member(s)...`);
    try {
      const embeddings = await embedTexts(jobs.map((j) => j.text));
      const vectors = jobs.map((job, i) => ({
        id: vectorIdFor(job.member.record.id, job.kind),
        values: embeddings[i],
        metadata: {
          email: job.member.email,
          profileHash: job.member.hash,
          city: job.member.city,
          kind: job.kind,
          airtableRecordId: job.member.record.id,
        },
      }));
      vectorsUpserted = await deps.pinecone.upsertVectors(vectors, namespace);
      embedded = toEmbed.length;
      deps.log(`Upserted ${vectorsUpserted} vector(s) into namespace "${namespace}"`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Embedding failed: ${message}`);
      for (const member of toEmbed) {
        await deps.db
          .insert(introductionMemberProfiles)
          .values({
            airtableRecordId: member.record.id,
            email: member.email,
            profileHash: member.hash,
            status: "error",
            lastError: message.slice(0, 500),
            lastSyncedAt: null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: introductionMemberProfiles.airtableRecordId,
            set: {
              email: member.email,
              profileHash: member.hash,
              status: "error",
              lastError: message.slice(0, 500),
              updatedAt: now,
            },
          });
      }
      return {
        success: false,
        summary: `${cityLabel}: embedding failed — ${message}`,
        fetched: records.length,
        embedded: 0,
        vectorsUpserted: 0,
        skipped: noContent,
        unchanged,
        deletedVectors: 0,
        errors,
        dryRun,
        namespace,
      };
    }
  }

  // ─── Persist profile ledger (only members with semantic content) ───
  const embeddedIds = new Set(toEmbed.map((m) => m.record.id));
  const ledgerRows = prepared.filter((m) => !m.noContent);
  if (ledgerRows.length > 0) {
    await deps.db
      .insert(introductionMemberProfiles)
      .values(
        ledgerRows.map((m) => ({
          airtableRecordId: m.record.id,
          email: m.email,
          profileHash: m.hash,
          status: "synced",
          lastError: null,
          lastSyncedAt: embeddedIds.has(m.record.id) ? now : null,
          updatedAt: now,
        }))
      )
      .onConflictDoUpdate({
        target: introductionMemberProfiles.airtableRecordId,
        set: {
          email: sql`excluded.email`,
          profileHash: sql`excluded.profile_hash`,
          status: sql`excluded.status`,
          lastError: sql`excluded.last_error`,
          lastSyncedAt: sql`excluded.last_synced_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
    deps.log(`Persisted profile ledger for ${ledgerRows.length} member(s)`);
  }

  // ─── Reconcile stale vectors (all-cities runs only) ───
  let deletedVectors = 0;
  if (isAllCities) {
    deps.log(`Reconciling namespace "${namespace}"...`);
    const activeIds = new Set(records.map((r) => r.id));
    const vectorIds = await deps.pinecone.listAllIds(namespace);
    const stale: string[] = [];
    for (const vectorId of vectorIds) {
      const base = recordIdFromVectorId(vectorId);
      if (!base || !activeIds.has(base)) stale.push(vectorId);
    }
    if (stale.length > 0) {
      deps.log(`Deleting ${stale.length} stale vector(s)`);
      await deps.pinecone.deleteByIds(stale, namespace);
      deletedVectors = stale.length;
    } else {
      deps.log(`No stale vectors (namespace has ${vectorIds.length} vector(s))`);
    }
  }

  const summary = [
    `${embedded} embedded (${vectorsUpserted} vectors)`,
    `${unchanged} unchanged`,
    `${noContent} skipped (no semantic content)`,
    deletedVectors ? `${deletedVectors} stale vectors deleted` : null,
  ]
    .filter(Boolean)
    .join(", ");

  deps.log(`Sync complete: ${summary}`);
  return {
    success: true,
    summary: `${cityLabel}: ${summary}`,
    fetched: records.length,
    embedded,
    vectorsUpserted,
    skipped: noContent,
    unchanged,
    deletedVectors,
    errors,
    dryRun,
    namespace,
  };
}

export const syncIntroProfiles: Op = {
  slug: "sync-intro-profiles",
  name: "Sync Semantic Intro Profiles",
  description:
    "Embed members' semantic profile fields (headline, bio, 90-day goal, help wanted, expertise) into the dedicated Pinecone namespace for the unified introduction engine.",

  run: async (ctx: OpContext) => {
    const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
    const airtableBase = process.env.AIRTABLE_BASE_ID;
    const pineconeKey = process.env.PINECONE_API_KEY;
    const pineconeIndex = process.env.PINECONE_INDEX_NAME;

    if (!airtableToken || !airtableBase) {
      return { success: false, summary: "Missing Airtable credentials" };
    }
    if (!pineconeKey || !pineconeIndex) {
      return { success: false, summary: "Missing Pinecone credentials" };
    }
    if (!process.env.OPENAI_API_KEY) {
      return { success: false, summary: "Missing OPENAI_API_KEY" };
    }

    const deps: IntroSyncDeps = {
      airtable: createAirtableClient({ apiKey: airtableToken, baseId: airtableBase }),
      pinecone: createPineconeClient({ apiKey: pineconeKey, indexName: pineconeIndex }),
      db: ctx.db,
      log: (message) => void ctx.log(message),
    };

    const result = await runIntroProfileSync(deps, { cityLabel: "All Cities" });
    return {
      success: result.success,
      summary: result.summary,
      recordsProcessed: result.embedded + result.unchanged,
    };
  },
};
