import { describe, it, expect } from "vitest";
import {
  findChannelName,
  validateCityRelationConfig,
  type CityRelationRepairConfig,
} from "@/lib/ops/city-relation-config";
import { buildCityToChannelMap, normalizeCityKey } from "@/lib/ops/city-normalize";
import { parseRepairArgs } from "@/lib/ops/city-relation-repair";

const baseConfig = (): CityRelationRepairConfig => ({
  version: 1,
  tables: { members: "Members", cities: "ALL CITIES", slackChannels: "Slack channels" },
  fields: {
    memberCityLegacy: "City",
    memberCityLink: "City relation",
    cityName: "City",
    cityCountry: "Country",
    cityChannels: "Slack channels",
    channelName: "Name",
    channelCities: "Cities",
    channelStatus: "Channel status/donut",
    channelSlackId: "Slack Channel ID",
  },
  cityRenames: [],
  countryOverrides: [],
  aliases: {},
  citiesToCreate: [],
  channelCityLinks: {
    "🔒wlth-wlks-san-diego-metro": ["San Diego", "Encinitas"],
    "🔒wlth-wlks-san-francisco-bay-area": ["San Francisco", "Oakland"],
    "🔒wlth-wlks-new-york-metro": ["New York", "Brooklyn"],
    "🔒wlth-wlks-brisbane-and-gold-coast": ["Brisbane", "Gold Coast"],
    "🔒wlth-wlks-los-angeles-so-cal-metro": ["Los Angeles"],
    "🔒wlth-wlks-mexico-city": ["Mexico City"],
    "🔒wlth-wlks-sao-paulo": ["São Paulo"],
  },
  virtualFallbackCities: [],
  recordOverrides: {},
  duplicateCityNames: [],
  invalidMemberCityValues: ["", "na"],
});

describe("findChannelName", () => {
  const live = new Set([
    "🔒wlth-wlks-san-diego-metro",
    "🔒wlth-wlks-san-francisco-bay-area",
    "🔒wlth-wlks-new-york-metro",
    "🔒wlth-wlks-brisbane-and-gold-coast",
    "🔒wlth-wlks-los-angeles-so-cal-metro",
    "🔒wlth-wlks-mexico-city",
    "🔒wlth-wlks-sao-paulo",
  ]);

  it("matches exact Unicode Airtable channel names", () => {
    expect(findChannelName("🔒wlth-wlks-san-diego-metro", live)).toBe(
      "🔒wlth-wlks-san-diego-metro"
    );
    expect(findChannelName("🔒wlth-wlks-sao-paulo", live)).toBe("🔒wlth-wlks-sao-paulo");
  });

  it("does not treat bare city labels as channel names", () => {
    expect(findChannelName("San Diego", live)).toBeNull();
    expect(findChannelName("San Francisco", live)).toBeNull();
    expect(findChannelName("New York", live)).toBeNull();
    expect(findChannelName("Los Angeles", live)).toBeNull();
    expect(findChannelName("Mexico City", live)).toBeNull();
    expect(findChannelName("São Paulo", live)).toBeNull();
    expect(findChannelName("Brisbane and Gold Coast", live)).toBeNull();
  });
});

describe("buildCityToChannelMap + validateCityRelationConfig", () => {
  it("maps cities to channel name VALUES (not city keys as channels)", () => {
    const map = buildCityToChannelMap(baseConfig().channelCityLinks);
    expect(map.get(normalizeCityKey("San Diego"))).toBe("🔒wlth-wlks-san-diego-metro");
    expect(map.get(normalizeCityKey("Encinitas"))).toBe("🔒wlth-wlks-san-diego-metro");
    // City labels must never appear as the channel side of the map values incorrectly
    expect([...map.values()].includes("San Diego")).toBe(false);
  });

  it("passes when live Airtable has exact Unicode channel names", () => {
    const liveNames = new Set([
      "🔒wlth-wlks-san-diego-metro",
      "🔒wlth-wlks-san-francisco-bay-area",
      "🔒wlth-wlks-new-york-metro",
      "🔒wlth-wlks-brisbane-and-gold-coast",
      "🔒wlth-wlks-los-angeles-so-cal-metro",
      "🔒wlth-wlks-mexico-city",
      "🔒wlth-wlks-sao-paulo",
    ]);
    const statuses = new Map(
      [...liveNames].map((n) => [n, "Active"] as const)
    );
    const slackIds = new Map(
      [...liveNames].map((n) => [n, `C${n.length}ABC`] as const)
    );

    const result = validateCityRelationConfig(baseConfig(), {
      channelNames: liveNames,
      channelSlackIds: slackIds,
      channelStatuses: statuses,
    });
    expect(result.ok).toBe(true);
  });

  it("fails missing mapped channel values with city and channel in error", () => {
    const result = validateCityRelationConfig(baseConfig(), {
      channelNames: new Set(["🔒wlth-wlks-other-only"]),
      channelSlackIds: new Map(),
      channelStatuses: new Map(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const sanDiegoErr = result.errors.find((e) => e.includes("San Diego"));
    expect(sanDiegoErr).toBeTruthy();
    expect(sanDiegoErr).toContain("🔒wlth-wlks-san-diego-metro");
    // Must not claim the city label itself is the missing channel name alone
    expect(result.errors.some((e) => e === 'Mapped Slack channel not found in Airtable: "San Diego"')).toBe(
      false
    );
  });

  it("never validates city keys as if they were Slack channel names when structure is correct", () => {
    // Intentionally wrong old shape: city as key, channel slug mixed into cities array
    const broken: CityRelationRepairConfig = {
      ...baseConfig(),
      channelCityLinks: {
        "San Diego": ["🔒wlth-wlks-san-diego-metro", "Encinitas"],
      },
    };
    const liveNames = new Set(["🔒wlth-wlks-san-diego-metro"]);
    const result = validateCityRelationConfig(broken, {
      channelNames: liveNames,
      channelSlackIds: new Map([["🔒wlth-wlks-san-diego-metro", "C1"]]),
      channelStatuses: new Map([["🔒wlth-wlks-san-diego-metro", "Active"]]),
    });
    // Key "San Diego" is treated as a channel name → should fail (city is not a channel)
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("San Diego"))).toBe(true);
  });
});

describe("apply abort semantics (parse flags)", () => {
  it("apply flags require confirm-apply at CLI", () => {
    const a = parseRepairArgs(["--apply-all"]);
    expect(a.anyApply).toBe(true);
    expect(a.confirmApply).toBe(false);
  });
});
