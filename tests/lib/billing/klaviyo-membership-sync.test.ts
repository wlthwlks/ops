import { describe, it, expect, vi } from "vitest";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import type { KlaviyoClient } from "@/lib/integrations/klaviyo";
import type { ActiveMembershipSubscription } from "@/lib/billing/historical-stripe-member-repair";
import {
  computeKlaviyoCensus,
  fetchMemberEnrichment,
  fetchCityCountries,
  buildKlaviyoProfiles,
  syncKlaviyoMembershipLists,
  mergePhoneNumber,
} from "@/lib/billing/klaviyo-membership-sync";
import { MEMBERS_TABLE, CITIES_TABLE, COUNTRIES_TABLE } from "@/lib/ops/airtable-fields";

const periodEnd = Math.floor(new Date("2026-09-01T00:00:00.000Z").getTime() / 1000);

function stripeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    status: "active",
    cancel_at_period_end: false,
    current_period_end: periodEnd,
    customer: { id: "cus_1", object: "customer", email: "pay@example.com", name: "Pay User" },
    items: { data: [{ price: { id: "price_mem" } }] },
    ...overrides,
  } as never;
}

function membership(overrides: Partial<ActiveMembershipSubscription> = {}): ActiveMembershipSubscription {
  return {
    subscriptionId: "sub_1",
    subscriptionStatus: "active",
    cancelAtPeriodEnd: false,
    stripeCustomerId: "cus_1",
    customer: {
      id: "cus_1",
      object: "customer",
      email: "pay@example.com",
      name: "Pay User",
    } as never,
    priceIds: ["price_mem"],
    currentPeriodEndUnix: periodEnd,
    ...overrides,
  };
}

function mockStripe(byStatus: Record<string, unknown[]>) {
  return {
    subscriptions: {
      list: vi.fn(async ({ status }: { status: string }) => ({
        data: byStatus[status] ?? [],
        has_more: false,
      })),
    },
  };
}

function mockAirtable(records: AirtableRecord[]) {
  const listRecords = vi.fn(async (table: string, o?: { filterByFormula?: string; fields?: string[] }) => {
    const f = o?.filterByFormula || "";
    if (table === CITIES_TABLE) {
      return records.filter((r) => r.fields.City || r.fields.Country);
    }
    if (table === COUNTRIES_TABLE) {
      return records.filter((r) => r.fields.Name);
    }
    const emails = [...f.matchAll(/LOWER\(\{email\}\) = "([^"]+)"/g)].map((m) => m[1].toLowerCase());
    if (emails.length > 0) {
      return records.filter((r) =>
        emails.includes(String(r.fields.email ?? "").trim().toLowerCase())
      );
    }
    return records;
  });
  return {
    listRecords,
    getRecord: vi.fn(),
    updateRecordsBatched: vi.fn(),
    createRecords: vi.fn(),
  } as unknown as AirtableClient & {
    listRecords: ReturnType<typeof vi.fn>;
  };
}

function mockKlaviyo() {
  return {
    importProfiles: vi.fn(async (profiles: unknown[]) => ({
      requested: profiles.length,
      jobs: 1,
      jobIds: ["job1"],
    })),
    waitForImportJobs: vi.fn(async () => undefined),
    listProfileIdsByEmails: vi.fn(async (emails: string[]) => {
      const map = new Map<string, string>();
      emails.forEach((email, i) => map.set(email, `prof_${i}`));
      return map;
    }),
    addProfilesToList: vi.fn(async (_listId: string, ids: string[]) => ({
      requested: ids.length,
      calls: 1,
    })),
    removeProfilesFromList: vi.fn(async (_listId: string, ids: string[]) => ({
      requested: ids.length,
      calls: 1,
    })),
  } as unknown as KlaviyoClient & {
    importProfiles: ReturnType<typeof vi.fn>;
    waitForImportJobs: ReturnType<typeof vi.fn>;
    listProfileIdsByEmails: ReturnType<typeof vi.fn>;
    addProfilesToList: ReturnType<typeof vi.fn>;
    removeProfilesFromList: ReturnType<typeof vi.fn>;
  };
}

describe("computeKlaviyoCensus", () => {
  it("splits active/trialing into active and canceled-without-active into churned", async () => {
    const stripe = mockStripe({
      active: [stripeSub({ id: "sub_a", customer: { id: "cus_a", email: "a@x.com" } })],
      trialing: [stripeSub({ id: "sub_t", status: "trialing", customer: { id: "cus_t", email: "t@x.com" } })],
      canceled: [
        stripeSub({ id: "sub_c1", status: "canceled", customer: { id: "cus_c1", email: "c1@x.com" } }),
        stripeSub({ id: "sub_c2", status: "canceled", customer: { id: "cus_a", email: "a@x.com" } }),
      ],
    });
    const census = await computeKlaviyoCensus({
      stripe,
      membershipPriceIds: new Set(["price_mem"]),
    });
    expect(census.active.map((m) => m.stripeCustomerId).sort()).toEqual(["cus_a", "cus_t"]);
    expect(census.churned.map((m) => m.stripeCustomerId)).toEqual(["cus_c1"]);
  });

  it("keeps a mid-cycle canceller (cancel_at_period_end) in active", async () => {
    const stripe = mockStripe({
      active: [
        stripeSub({
          id: "sub_mid",
          cancel_at_period_end: true,
          customer: { id: "cus_mid", email: "mid@x.com" },
        }),
      ],
    });
    const census = await computeKlaviyoCensus({
      stripe,
      membershipPriceIds: new Set(["price_mem"]),
    });
    expect(census.active).toHaveLength(1);
    expect(census.active[0].cancelAtPeriodEnd).toBe(true);
    expect(census.churned).toHaveLength(0);
  });

  it("caps each Stripe listing when limit is set", async () => {
    const stripe = mockStripe({
      active: [
        stripeSub({ id: "sub_a1", customer: { id: "cus_a1", email: "a1@x.com" } }),
        stripeSub({ id: "sub_a2", customer: { id: "cus_a2", email: "a2@x.com" } }),
      ],
    });
    const census = await computeKlaviyoCensus({
      stripe,
      membershipPriceIds: new Set(["price_mem"]),
      limit: 1,
    });
    expect(census.active).toHaveLength(1);
  });
});

describe("parseKlaviyoSyncArgs (via dynamic import of script logic)", () => {
  it("defaults to dry-run with no limit", async () => {
    const { parseKlaviyoSyncArgs } = await import("../../../scripts/sync-klaviyo-members");
    expect(parseKlaviyoSyncArgs([])).toEqual({ apply: false, limit: undefined });
  });

  it("parses --apply and --limit", async () => {
    const { parseKlaviyoSyncArgs } = await import("../../../scripts/sync-klaviyo-members");
    expect(parseKlaviyoSyncArgs(["--apply"]).apply).toBe(true);
    expect(parseKlaviyoSyncArgs(["--limit=25"]).limit).toBe(25);
    expect(parseKlaviyoSyncArgs(["--apply", "--limit=25"])).toEqual({ apply: true, limit: 25 });
  });

  it("rejects unknown flags and bad limits", async () => {
    const { parseKlaviyoSyncArgs } = await import("../../../scripts/sync-klaviyo-members");
    expect(() => parseKlaviyoSyncArgs(["--bogus"])).toThrow("Unknown flag");
    expect(() => parseKlaviyoSyncArgs(["--limit=0"])).toThrow("Invalid --limit");
  });
});

describe("mergePhoneNumber", () => {
  it("merges prefix + national number", () => {
    expect(mergePhoneNumber("+1", "3105551234")).toBe("+13105551234");
  });
  it("keeps international numbers as-is", () => {
    expect(mergePhoneNumber("+44", "+442071234567")).toBe("+442071234567");
  });
  it("returns raw number without prefix", () => {
    expect(mergePhoneNumber("", "3105551234")).toBe("3105551234");
  });
  it("returns empty for missing number", () => {
    expect(mergePhoneNumber("+1", "")).toBe("");
  });
});

describe("fetchMemberEnrichment", () => {
  it("reads members once without a filter formula and indexes only wanted emails", async () => {
    const airtable = mockAirtable([
      {
        id: "rec1",
        fields: {
          email: "Dina@X.com",
          "First Name": "Dina",
          "Last Name": "K",
          "Phone prefix": "+1",
          "phone number": "3105551234",
          "post code": "90401",
          City: "Santa Monica",
          "City relation": ["recCityLA"],
          "Paid Plans (price ids)": "price_mem",
          "Service access until": "2026-09-01T00:00:00.000Z",
          "Cancellation effective at": "",
        },
      },
      {
        id: "rec2",
        fields: { email: "other@x.com", "First Name": "Other", "Last Name": "User" },
      },
    ]);
    const map = await fetchMemberEnrichment(airtable, ["dina@x.com", "ghost@x.com"]);
    expect(map.size).toBe(1);
    expect(map.get("other@x.com")).toBeUndefined();
    const e = map.get("dina@x.com");
    expect(e?.phone).toBe("+13105551234");
    expect(e?.city).toBe("Santa Monica");
    expect(airtable.listRecords).toHaveBeenCalledTimes(1);
    const [table, opts] = airtable.listRecords.mock.calls[0];
    expect(table).toBe(MEMBERS_TABLE);
    expect(opts.filterByFormula).toBeUndefined();
    expect(opts.fields).toContain("email");
    expect(opts.fields).toContain("phone number");
  });
});

describe("fetchCityCountries", () => {
  it("maps city record ids to city name + resolved country name (Country is a linked field)", async () => {
    const airtable = mockAirtable([
      { id: "recCountryUS", fields: { Name: "United States" } },
      { id: "recCountryUK", fields: { Name: "United Kingdom" } },
      { id: "recCityLA", fields: { City: "Los Angeles", Country: ["recCountryUS"] } },
      { id: "recCityLON", fields: { City: "London", Country: ["recCountryUK"] } },
    ]);
    const map = await fetchCityCountries(airtable);
    expect(map.get("recCityLA")).toEqual({ city: "Los Angeles", country: "United States" });
    expect(map.get("recCityLON")).toEqual({ city: "London", country: "United Kingdom" });
    expect(airtable.listRecords).toHaveBeenCalledWith(COUNTRIES_TABLE, { fields: ["Name"] });
    expect(airtable.listRecords).toHaveBeenCalledWith(CITIES_TABLE, {
      fields: ["City", "Country"],
    });
  });

  it("leaves country empty when the linked country record is missing", async () => {
    const airtable = mockAirtable([
      { id: "recCountryUS", fields: { Name: "United States" } },
      { id: "recCityLA", fields: { City: "Los Angeles", Country: ["recDeletedCountry"] } },
    ]);
    const map = await fetchCityCountries(airtable);
    expect(map.get("recCityLA")).toEqual({ city: "Los Angeles", country: "" });
  });

  it("never returns Airtable record ids as city or country values", async () => {
    const airtable = mockAirtable([
      { id: "recCountryUS", fields: { Name: "recXyzDeadBeef012" } },
      { id: "recCityLA", fields: { City: "recAbc1234567890", Country: ["recCountryUS"] } },
    ]);
    const map = await fetchCityCountries(airtable);
    expect(map.get("recCityLA")).toEqual({ city: "", country: "" });
  });
});

describe("buildKlaviyoProfiles", () => {
  const enrichment = new Map([
    [
      "dina@x.com",
      {
        firstName: "Dina",
        lastName: "K",
        phone: "+13105551234",
        zip: "90401",
        city: "Santa Monica",
        cityLinkId: "recCityLA",
        planPriceIds: "price_mem",
        serviceAccessUntil: "2026-09-01T00:00:00.000Z",
        cancellationEffectiveAt: "",
      },
    ],
  ]);
  const citiesById = new Map([
    ["recCityLA", { city: "Los Angeles", country: "United States" }],
  ]);

  it("builds active profiles with enrichment + properties", () => {
    const result = buildKlaviyoProfiles({
      active: [membership({ customer: { id: "cus_1", email: "Dina@x.com" } as never })],
      churned: [],
      enrichmentByEmail: enrichment,
      citiesById,
    });
    expect(result.activeEmails).toEqual(["dina@x.com"]);
    const profile = result.profiles[0];
    expect(profile.email).toBe("dina@x.com");
    expect(profile.firstName).toBe("Dina");
    expect(profile.lastName).toBe("K");
    expect(profile.phoneNumber).toBe("+13105551234");
    expect(profile.city).toBe("Los Angeles");
    expect(profile.country).toBe("United States");
    expect(profile.zip).toBe("90401");
    expect(profile.properties).toEqual({
      membership_status: "active",
      service_access_until: "2026-09-01T00:00:00.000Z",
      plan: "price_mem",
    });
  });

  it("builds churned profiles with membership_status churned and cancellation date", () => {
    const result = buildKlaviyoProfiles({
      active: [],
      churned: [
        membership({
          subscriptionStatus: "canceled",
          endedAtUnix: 1751328000,
          customer: { id: "cus_2", email: "gone@x.com" } as never,
        }),
      ],
      enrichmentByEmail: new Map(),
      citiesById: new Map(),
    });
    expect(result.churnedEmails).toEqual(["gone@x.com"]);
    const profile = result.profiles[0];
    expect(profile.properties?.membership_status).toBe("churned");
    expect(profile.properties?.cancellation_effective_at).toBe("2025-07-01T00:00:00.000Z");
    expect(profile.properties?.service_access_until).toBe("2026-09-01T00:00:00.000Z");
  });

  it("skips memberships without a valid email", () => {
    const result = buildKlaviyoProfiles({
      active: [membership({ customer: { id: "cus_3" } as never })],
      churned: [],
      enrichmentByEmail: new Map(),
      citiesById: new Map(),
    });
    expect(result.activeEmails).toEqual([]);
    expect(result.profiles).toEqual([]);
    expect(result.skippedNoEmail).toBe(1);
  });

  it("blanks Airtable record ids in location columns", () => {
    const dirtyEnrichment = new Map([
      [
        "rec@x.com",
        {
          firstName: "Rex",
          lastName: "Id",
          phone: "",
          zip: "90401",
          city: "recCity1111111111",
          cityLinkId: "recCityLON",
          planPriceIds: "price_mem",
          serviceAccessUntil: "",
          cancellationEffectiveAt: "",
        },
      ],
    ]);
    const dirtyCities = new Map([
      ["recCityLON", { city: "London", country: "reccnnjiVkL28NBgV" }],
    ]);
    const result = buildKlaviyoProfiles({
      active: [
        membership({ customer: { id: "cus_1", email: "rec@x.com" } as never }),
      ],
      churned: [],
      enrichmentByEmail: dirtyEnrichment,
      citiesById: dirtyCities,
    });
    const profile = result.profiles[0];
    expect(profile.city).toBe("London");
    expect(profile.country).toBe("");
  });

  it("falls back to member City text and never leaks record ids", () => {
    const noLinkEnrichment = new Map([
      [
        "legacy@x.com",
        {
          firstName: "Legacy",
          lastName: "User",
          phone: "",
          zip: "",
          city: "recCityLegacy12345",
          cityLinkId: "recMissingCity",
          planPriceIds: "",
          serviceAccessUntil: "",
          cancellationEffectiveAt: "",
        },
      ],
    ]);
    const result = buildKlaviyoProfiles({
      active: [
        membership({ customer: { id: "cus_1", email: "legacy@x.com" } as never }),
      ],
      churned: [],
      enrichmentByEmail: noLinkEnrichment,
      citiesById: new Map(),
    });
    const profile = result.profiles[0];
    expect(profile.city).toBe("");
    expect(profile.country).toBe("");
  });
});

describe("syncKlaviyoMembershipLists", () => {
  it("imports profiles, waits, resolves ids and reconciles both lists in full", async () => {
    const klaviyo = mockKlaviyo();
    const result = await syncKlaviyoMembershipLists({
      klaviyo,
      activeListId: "list_active",
      churnedListId: "list_churned",
      profiles: [
        { email: "a@x.com", properties: { membership_status: "active" } },
        { email: "c@x.com", properties: { membership_status: "churned" } },
      ],
      activeEmails: ["a@x.com"],
      churnedEmails: ["c@x.com"],
      skippedNoEmail: 0,
    });

    expect(klaviyo.importProfiles).toHaveBeenCalledTimes(1);
    expect(klaviyo.waitForImportJobs).toHaveBeenCalledWith(["job1"]);
    expect(klaviyo.listProfileIdsByEmails).toHaveBeenCalledWith(["a@x.com", "c@x.com"]);
    expect(klaviyo.addProfilesToList).toHaveBeenCalledWith("list_active", ["prof_0"]);
    expect(klaviyo.removeProfilesFromList).toHaveBeenCalledWith("list_active", ["prof_1"]);
    expect(klaviyo.addProfilesToList).toHaveBeenCalledWith("list_churned", ["prof_1"]);
    expect(klaviyo.removeProfilesFromList).toHaveBeenCalledWith("list_churned", ["prof_0"]);

    expect(result).toEqual({
      profilesImported: 2,
      importJobs: 1,
      activeSubscribed: 1,
      activeSubscribeCalls: 1,
      activeUnsubscribed: 1,
      activeUnsubscribeCalls: 1,
      churnedSubscribed: 1,
      churnedSubscribeCalls: 1,
      churnedUnsubscribed: 1,
      churnedUnsubscribeCalls: 1,
      skippedNoEmail: 0,
      unresolvedProfiles: 0,
    });
  });

  it("counts unresolved profiles when email lookup misses", async () => {
    const klaviyo = mockKlaviyo();
    klaviyo.listProfileIdsByEmails.mockResolvedValueOnce(new Map([["a@x.com", "prof_0"]]));
    const result = await syncKlaviyoMembershipLists({
      klaviyo,
      activeListId: "list_active",
      churnedListId: "list_churned",
      profiles: [
        { email: "a@x.com", properties: { membership_status: "active" } },
        { email: "c@x.com", properties: { membership_status: "churned" } },
      ],
      activeEmails: ["a@x.com"],
      churnedEmails: ["c@x.com"],
      skippedNoEmail: 0,
    });
    expect(klaviyo.addProfilesToList).toHaveBeenCalledWith("list_churned", []);
    expect(klaviyo.removeProfilesFromList).toHaveBeenCalledWith("list_active", []);
    expect(result.unresolvedProfiles).toBe(1);
    expect(result.churnedSubscribed).toBe(0);
  });
});
