/**
 * Klaviyo membership-list sync — runs at the END of the daily
 * future-access-parity cron, after Airtable has been reconciled to Stripe.
 *
 * Segmentation (disjoint lists, Stripe is the source of truth):
 *   - Active list ("WW Active members reliable"): customers with a qualifying
 *     active/trialing subscription (including mid-cycle cancellers whose paid
 *     access has not ended yet).
 *   - Churned list: customers whose qualifying subscription has fully ended
 *     (status canceled) and who have NO qualifying active/trialing sub.
 *
 * Profiles are upserted with the columns the team relies on:
 *   Profile (first/last name), Email, Phone number, Location (city+country+zip)
 *   plus custom properties: membership_status, plan, service_access_until,
 *   cancellation_effective_at, and email_suppression_{newsletter,churned,active}
 *   ("true"/"false", always set — unchecking a MEMBERS checkbox self-heals on
 *   the next run). Suppression properties drive Klaviyo suppression segments
 *   attached to the newsletter / churned / active campaigns.
 *
 * List reconciliation is full: actives are subscribed to the active list and
 * unsubscribed from the churned list; churned get the inverse. "Date added" in
 * Klaviyo is set automatically by the bulk subscribe jobs.
 */
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import type { KlaviyoClient, KlaviyoProfileInput } from "@/lib/integrations/klaviyo";
import {
  listActiveMembershipSubscriptions,
  namesFromStripeCustomer,
  type ActiveMembershipSubscription,
} from "@/lib/billing/historical-stripe-member-repair";
import {
  CANCELLATION_EFFECTIVE_AT_FIELD,
  MEMBERS_TABLE,
  PAID_PLANS_FIELD,
  SERVICE_ACCESS_FIELD,
} from "@/lib/billing/service-access-sync";
import {
  PRIMARY_EMAIL_FIELD,
  extractStripeCustomerEmail,
} from "@/lib/billing/webhook-invoice-sync";
import { CITIES_TABLE, COUNTRIES_TABLE, MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type KlaviyoStripeClient = any;

export const KLAVIYO_MEMBERSHIP_STATUS_ACTIVE = "active";
export const KLAVIYO_MEMBERSHIP_STATUS_CHURNED = "churned";

const MEMBER_ENRICHMENT_FIELDS = [
  PRIMARY_EMAIL_FIELD,
  "First Name",
  "Last Name",
  "phone number",
  "Phone prefix",
  "post code",
  "City",
  "City relation",
  PAID_PLANS_FIELD,
  SERVICE_ACCESS_FIELD,
  CANCELLATION_EFFECTIVE_AT_FIELD,
  MEMBER_FIELDS.emailSuppressionNewsletter,
  MEMBER_FIELDS.emailSuppressionChurned,
  MEMBER_FIELDS.emailSuppressionActive,
] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmailForIndex(email: string): string {
  return (email || "").trim().toLowerCase();
}

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return v == null ? "" : String(v).trim();
}

/** Airtable omits unchecked checkboxes, so anything truthy counts as checked. */
function fieldBool(fields: Record<string, unknown>, key: string): boolean {
  return Boolean(fields[key]);
}

function firstLinkId(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === "string" && v.startsWith("rec")) return v;
    }
    return null;
  }
  if (typeof value === "string" && value.startsWith("rec")) return value;
  return null;
}

const AIRTABLE_RECORD_ID_RE = /^rec[a-zA-Z0-9]{10,}$/;

/** Blank any Airtable record id so it can never reach a Klaviyo column. */
function stripAirtableRecordId(value: string): string {
  const v = (value || "").trim();
  return AIRTABLE_RECORD_ID_RE.test(v) ? "" : v;
}

/** Best-effort E.164 merge of the validated signup phone parts. */
export function mergePhoneNumber(prefix: string, number: string): string {
  const rawNumber = (number || "").trim();
  if (!rawNumber) return "";
  if (rawNumber.startsWith("+")) return rawNumber;
  const rawPrefix = (prefix || "").trim();
  if (!rawPrefix) return rawNumber;
  const cleanPrefix = rawPrefix.startsWith("+") ? rawPrefix : `+${rawPrefix}`;
  return `${cleanPrefix}${rawNumber}`;
}

export type KlaviyoCensus = {
  active: ActiveMembershipSubscription[];
  churned: ActiveMembershipSubscription[];
};

/** Active census + fully-ended churn census from Stripe (disjoint). */
export async function computeKlaviyoCensus(input: {
  stripe: KlaviyoStripeClient;
  membershipPriceIds: Set<string>;
  /** Stop each Stripe listing after N qualifying customers (CLI sanity runs). */
  limit?: number;
}): Promise<KlaviyoCensus> {
  const { stripe, membershipPriceIds, limit } = input;

  const active = await listActiveMembershipSubscriptions(stripe, membershipPriceIds, {
    statuses: ["active", "trialing"],
    limit,
  });
  const activeCusIds = new Set(active.map((m) => m.stripeCustomerId));

  const canceled = await listActiveMembershipSubscriptions(stripe, membershipPriceIds, {
    statuses: ["canceled"],
    limit,
  });
  const churned = canceled.filter((m) => !activeCusIds.has(m.stripeCustomerId));

  return { active, churned };
}

export type MemberEnrichment = {
  firstName: string;
  lastName: string;
  phone: string;
  zip: string;
  city: string;
  cityLinkId: string;
  planPriceIds: string;
  serviceAccessUntil: string;
  cancellationEffectiveAt: string;
  suppressionNewsletter: boolean;
  suppressionChurned: boolean;
  suppressionActive: boolean;
};

function extractEnrichment(record: AirtableRecord): MemberEnrichment {
  const f = record.fields;
  return {
    firstName: fieldStr(f, "First Name"),
    lastName: fieldStr(f, "Last Name"),
    phone: mergePhoneNumber(fieldStr(f, "Phone prefix"), fieldStr(f, "phone number")),
    zip: fieldStr(f, "post code"),
    city: fieldStr(f, "City"),
    cityLinkId: firstLinkId(f["City relation"]) ?? "",
    planPriceIds: fieldStr(f, PAID_PLANS_FIELD),
    serviceAccessUntil: fieldStr(f, SERVICE_ACCESS_FIELD),
    cancellationEffectiveAt: fieldStr(f, CANCELLATION_EFFECTIVE_AT_FIELD),
    suppressionNewsletter: fieldBool(f, MEMBER_FIELDS.emailSuppressionNewsletter),
    suppressionChurned: fieldBool(f, MEMBER_FIELDS.emailSuppressionChurned),
    suppressionActive: fieldBool(f, MEMBER_FIELDS.emailSuppressionActive),
  };
}

/**
 * Fetch MEMBERS enrichment rows for the given emails via ONE paginated full
 * read of MEMBERS (field-projected, no filter formula). Formula scans with
 * dozens of OR'd email clauses are far slower than plain paginated reads;
 * rows are filtered to the wanted emails locally. Indexed by normalized email.
 */
export async function fetchMemberEnrichment(
  airtable: AirtableClient,
  emails: string[]
): Promise<Map<string, MemberEnrichment>> {
  const map = new Map<string, MemberEnrichment>();
  const wanted = new Set(emails.map(normalizeEmailForIndex).filter(Boolean));
  if (wanted.size === 0) return map;

  const records = await airtable.listRecords(MEMBERS_TABLE, {
    fields: [...MEMBER_ENRICHMENT_FIELDS],
  });
  for (const rec of records) {
    const email = normalizeEmailForIndex(fieldStr(rec.fields, PRIMARY_EMAIL_FIELD));
    if (!email || !wanted.has(email)) continue;
    map.set(email, extractEnrichment(rec));
  }
  return map;
}

/**
 * ALL CITIES record id → { city, country } map for city-relation resolution.
 * CITIES.Country is a linked field to COUNTRIES — the API returns record ids,
 * so the country is resolved to its COUNTRIES.Name label here. Anything that
 * still looks like a record id is blanked before it can reach Klaviyo.
 */
export async function fetchCityCountries(
  airtable: AirtableClient
): Promise<Map<string, { city: string; country: string }>> {
  const [countryRecs, cityRecs] = await Promise.all([
    airtable.listRecords(COUNTRIES_TABLE, { fields: ["Name"] }),
    airtable.listRecords(CITIES_TABLE, { fields: ["City", "Country"] }),
  ]);

  const countryNamesById = new Map<string, string>();
  for (const rec of countryRecs) {
    const name = stripAirtableRecordId(fieldStr(rec.fields, "Name"));
    if (name) countryNamesById.set(rec.id, name);
  }

  const map = new Map<string, { city: string; country: string }>();
  for (const rec of cityRecs) {
    const countryId = firstLinkId(rec.fields["Country"]) ?? "";
    map.set(rec.id, {
      city: stripAirtableRecordId(fieldStr(rec.fields, "City")),
      country: countryId ? (countryNamesById.get(countryId) ?? "") : "",
    });
  }
  return map;
}

export type KlaviyoBuildResult = {
  profiles: KlaviyoProfileInput[];
  activeEmails: string[];
  churnedEmails: string[];
  skippedNoEmail: number;
};

function resolveLocation(
  enrichment: MemberEnrichment | undefined,
  citiesById: Map<string, { city: string; country: string }>
): { city: string; country: string } {
  if (!enrichment) return { city: "", country: "" };
  const linked = enrichment.cityLinkId ? citiesById.get(enrichment.cityLinkId) : undefined;
  if (linked) {
    return {
      city: stripAirtableRecordId(linked.city) || stripAirtableRecordId(enrichment.city),
      country: stripAirtableRecordId(linked.country),
    };
  }
  return { city: stripAirtableRecordId(enrichment.city), country: "" };
}

function buildProfilesFor(
  memberships: ActiveMembershipSubscription[],
  status: typeof KLAVIYO_MEMBERSHIP_STATUS_ACTIVE | typeof KLAVIYO_MEMBERSHIP_STATUS_CHURNED,
  enrichmentByEmail: Map<string, MemberEnrichment>,
  citiesById: Map<string, { city: string; country: string }>
): { profiles: KlaviyoProfileInput[]; emails: string[]; skippedNoEmail: number } {
  const profiles: KlaviyoProfileInput[] = [];
  const emails: string[] = [];
  let skippedNoEmail = 0;

  for (const membership of memberships) {
    const rawEmail = extractStripeCustomerEmail(membership.customer);
    const email = normalizeEmailForIndex(rawEmail ?? "");
    if (!email || !EMAIL_RE.test(email)) {
      skippedNoEmail++;
      continue;
    }

    const enrichment = enrichmentByEmail.get(email);
    const { city, country } = resolveLocation(enrichment, citiesById);

    let firstName = enrichment?.firstName ?? "";
    let lastName = enrichment?.lastName ?? "";
    if (!firstName && !lastName) {
      const names = namesFromStripeCustomer(membership.customer, email);
      firstName = names.firstName;
      lastName = names.lastName;
    }

    const accessUntil =
      enrichment?.serviceAccessUntil ||
      (membership.currentPeriodEndUnix
        ? new Date(membership.currentPeriodEndUnix * 1000).toISOString()
        : "");

    const cancellationEffectiveAt =
      enrichment?.cancellationEffectiveAt ||
      (membership.endedAtUnix
        ? new Date(membership.endedAtUnix * 1000).toISOString()
        : membership.canceledAtUnix
          ? new Date(membership.canceledAtUnix * 1000).toISOString()
          : "");

    const properties: Record<string, string> = {
      membership_status: status,
      service_access_until: accessUntil,
      email_suppression_newsletter: enrichment?.suppressionNewsletter ? "true" : "false",
      email_suppression_churned: enrichment?.suppressionChurned ? "true" : "false",
      email_suppression_active: enrichment?.suppressionActive ? "true" : "false",
    };
    const plan = enrichment?.planPriceIds || membership.priceIds.join(",");
    if (plan) properties["plan"] = plan;
    if (cancellationEffectiveAt) {
      properties["cancellation_effective_at"] = cancellationEffectiveAt;
    }

    profiles.push({
      email,
      firstName,
      lastName,
      phoneNumber: enrichment?.phone,
      city,
      zip: enrichment?.zip,
      country,
      properties,
    });
    emails.push(email);
  }

  return { profiles, emails, skippedNoEmail };
}

export function buildKlaviyoProfiles(input: {
  active: ActiveMembershipSubscription[];
  churned: ActiveMembershipSubscription[];
  enrichmentByEmail: Map<string, MemberEnrichment>;
  citiesById: Map<string, { city: string; country: string }>;
}): KlaviyoBuildResult {
  const active = buildProfilesFor(
    input.active,
    KLAVIYO_MEMBERSHIP_STATUS_ACTIVE,
    input.enrichmentByEmail,
    input.citiesById
  );
  const churned = buildProfilesFor(
    input.churned,
    KLAVIYO_MEMBERSHIP_STATUS_CHURNED,
    input.enrichmentByEmail,
    input.citiesById
  );

  return {
    profiles: [...active.profiles, ...churned.profiles],
    activeEmails: active.emails,
    churnedEmails: churned.emails,
    skippedNoEmail: active.skippedNoEmail + churned.skippedNoEmail,
  };
}

export type KlaviyoMembershipSyncResult = {
  profilesImported: number;
  importJobs: number;
  activeSubscribed: number;
  activeSubscribeCalls: number;
  activeUnsubscribed: number;
  activeUnsubscribeCalls: number;
  churnedSubscribed: number;
  churnedSubscribeCalls: number;
  churnedUnsubscribed: number;
  churnedUnsubscribeCalls: number;
  skippedNoEmail: number;
  /** Emails present in the census but not found as Klaviyo profiles after import. */
  unresolvedProfiles: number;
};

/**
 * Full reconcile of the two Klaviyo lists:
 *   1. Bulk-upsert profiles (identity + columns + custom properties) and wait
 *      for the import jobs to complete.
 *   2. Resolve profile ids by email.
 *   3. Active list: add actives, remove churned.
 *   4. Churned list: add churned, remove actives.
 * List membership moves never touch email consent.
 */
export async function syncKlaviyoMembershipLists(input: {
  klaviyo: KlaviyoClient;
  activeListId: string;
  churnedListId: string;
  profiles: KlaviyoProfileInput[];
  activeEmails: string[];
  churnedEmails: string[];
  skippedNoEmail: number;
}): Promise<KlaviyoMembershipSyncResult> {
  const { klaviyo, activeListId, churnedListId } = input;

  const imported = await klaviyo.importProfiles(input.profiles);
  await klaviyo.waitForImportJobs(imported.jobIds);

  const idsByEmail = await klaviyo.listProfileIdsByEmails([
    ...input.activeEmails,
    ...input.churnedEmails,
  ]);

  const activeIds = input.activeEmails
    .map((email) => idsByEmail.get(email))
    .filter((id): id is string => Boolean(id));
  const churnedIds = input.churnedEmails
    .map((email) => idsByEmail.get(email))
    .filter((id): id is string => Boolean(id));

  const activeAdd = await klaviyo.addProfilesToList(activeListId, activeIds);
  const activeRemove = await klaviyo.removeProfilesFromList(activeListId, churnedIds);
  const churnedAdd = await klaviyo.addProfilesToList(churnedListId, churnedIds);
  const churnedRemove = await klaviyo.removeProfilesFromList(churnedListId, activeIds);

  return {
    profilesImported: imported.requested,
    importJobs: imported.jobs,
    activeSubscribed: activeAdd.requested,
    activeSubscribeCalls: activeAdd.calls,
    activeUnsubscribed: activeRemove.requested,
    activeUnsubscribeCalls: activeRemove.calls,
    churnedSubscribed: churnedAdd.requested,
    churnedSubscribeCalls: churnedAdd.calls,
    churnedUnsubscribed: churnedRemove.requested,
    churnedUnsubscribeCalls: churnedRemove.calls,
    skippedNoEmail: input.skippedNoEmail,
    unresolvedProfiles:
      input.activeEmails.length + input.churnedEmails.length - activeIds.length - churnedIds.length,
  };
}

/** End-to-end helper used by the parity cron route. */
export async function runKlaviyoMembershipSync(input: {
  stripe: KlaviyoStripeClient;
  airtable: AirtableClient;
  klaviyo: KlaviyoClient;
  membershipPriceIds: Set<string>;
  activeListId: string;
  churnedListId: string;
}): Promise<KlaviyoMembershipSyncResult> {
  const { stripe, airtable, klaviyo, membershipPriceIds, activeListId, churnedListId } =
    input;

  const census = await computeKlaviyoCensus({ stripe, membershipPriceIds });

  const allEmails = [
    ...census.active.map((m) => normalizeEmailForIndex(extractStripeCustomerEmail(m.customer) ?? "")),
    ...census.churned.map((m) => normalizeEmailForIndex(extractStripeCustomerEmail(m.customer) ?? "")),
  ];

  const enrichmentByEmail = await fetchMemberEnrichment(airtable, allEmails);
  const citiesById = await fetchCityCountries(airtable);

  const built = buildKlaviyoProfiles({
    active: census.active,
    churned: census.churned,
    enrichmentByEmail,
    citiesById,
  });

  return syncKlaviyoMembershipLists({
    klaviyo,
    activeListId,
    churnedListId,
    profiles: built.profiles,
    activeEmails: built.activeEmails,
    churnedEmails: built.churnedEmails,
    skippedNoEmail: built.skippedNoEmail,
  });
}
