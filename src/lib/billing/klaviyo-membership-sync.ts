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
 *   cancellation_effective_at.
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
  escapeAirtableFormulaString,
} from "@/lib/billing/service-access-sync";
import {
  PRIMARY_EMAIL_FIELD,
  extractStripeCustomerEmail,
} from "@/lib/billing/webhook-invoice-sync";
import { CITIES_TABLE } from "@/lib/ops/airtable-fields";

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
] as const;

const EMAIL_CHUNK_SIZE = 40;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmailForIndex(email: string): string {
  return (email || "").trim().toLowerCase();
}

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return v == null ? "" : String(v).trim();
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
}): Promise<KlaviyoCensus> {
  const { stripe, membershipPriceIds } = input;

  const active = await listActiveMembershipSubscriptions(stripe, membershipPriceIds, {
    statuses: ["active", "trialing"],
  });
  const activeCusIds = new Set(active.map((m) => m.stripeCustomerId));

  const canceled = await listActiveMembershipSubscriptions(stripe, membershipPriceIds, {
    statuses: ["canceled"],
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
  };
}

/**
 * Fetch MEMBERS enrichment rows for the given emails via chunked OR formulas
 * (keeps the filter formula under the URL length limit for large lists).
 * Indexed by normalized email.
 */
export async function fetchMemberEnrichment(
  airtable: AirtableClient,
  emails: string[]
): Promise<Map<string, MemberEnrichment>> {
  const map = new Map<string, MemberEnrichment>();
  const unique = [...new Set(emails.map(normalizeEmailForIndex).filter(Boolean))];
  if (unique.length === 0) return map;

  for (let i = 0; i < unique.length; i += EMAIL_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + EMAIL_CHUNK_SIZE);
    const clauses = chunk.map(
      (email) =>
        `LOWER({${PRIMARY_EMAIL_FIELD}}) = "${escapeAirtableFormulaString(email)}"`
    );
    const records = await airtable.listRecords(MEMBERS_TABLE, {
      filterByFormula: `OR(${clauses.join(",")})`,
      fields: [...MEMBER_ENRICHMENT_FIELDS],
    });
    for (const rec of records) {
      const email = normalizeEmailForIndex(fieldStr(rec.fields, PRIMARY_EMAIL_FIELD));
      if (!email) continue;
      map.set(email, extractEnrichment(rec));
    }
  }
  return map;
}

/** ALL CITIES record id → { city, country } map for city-relation resolution. */
export async function fetchCityCountries(
  airtable: AirtableClient
): Promise<Map<string, { city: string; country: string }>> {
  const records = await airtable.listRecords(CITIES_TABLE, {
    fields: ["City", "Country"],
  });
  const map = new Map<string, { city: string; country: string }>();
  for (const rec of records) {
    map.set(rec.id, {
      city: fieldStr(rec.fields, "City"),
      country: fieldStr(rec.fields, "Country"),
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
      city: linked.city || enrichment.city,
      country: linked.country,
    };
  }
  return { city: enrichment.city, country: "" };
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
  activeSubscribeJobs: number;
  activeUnsubscribed: number;
  activeUnsubscribeJobs: number;
  churnedSubscribed: number;
  churnedSubscribeJobs: number;
  churnedUnsubscribed: number;
  churnedUnsubscribeJobs: number;
  skippedNoEmail: number;
};

/**
 * Full reconcile of the two Klaviyo lists:
 *   1. Upsert profiles (identity + columns + custom properties).
 *   2. Active list: subscribe actives, unsubscribe churned.
 *   3. Churned list: subscribe churned, unsubscribe actives.
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

  const imported = await klaviyo.profileImport(input.profiles);
  const activeSub = await klaviyo.bulkSubscribe(activeListId, input.activeEmails);
  const activeUnsub = await klaviyo.bulkUnsubscribe(activeListId, input.churnedEmails);
  const churnedSub = await klaviyo.bulkSubscribe(churnedListId, input.churnedEmails);
  const churnedUnsub = await klaviyo.bulkUnsubscribe(churnedListId, input.activeEmails);

  return {
    profilesImported: imported.requested,
    importJobs: imported.jobs,
    activeSubscribed: activeSub.requested,
    activeSubscribeJobs: activeSub.jobs,
    activeUnsubscribed: activeUnsub.requested,
    activeUnsubscribeJobs: activeUnsub.jobs,
    churnedSubscribed: churnedSub.requested,
    churnedSubscribeJobs: churnedSub.jobs,
    churnedUnsubscribed: churnedUnsub.requested,
    churnedUnsubscribeJobs: churnedUnsub.jobs,
    skippedNoEmail: input.skippedNoEmail,
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
