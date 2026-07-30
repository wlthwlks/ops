import { describe, it, expect } from "vitest";
import {
  fieldStr,
  linkedRecordIds,
  sameIdSet,
  parseRepairArgs,
  pickCanonicalDuplicate,
  resolveMemberCityChannel,
  conditionMessage,
} from "@/lib/ops/city-relation-repair";
import type { AirtableRecord } from "@/lib/integrations/airtable";

describe("parseRepairArgs", () => {
  it("defaults to audit / dry-run (no writes)", () => {
    const a = parseRepairArgs([]);
    expect(a.anyApply).toBe(false);
  });

  it("requires confirm for apply semantics at CLI layer", () => {
    const a = parseRepairArgs(["--apply-all"]);
    expect(a.applyMemberLinks).toBe(true);
    expect(a.confirmApply).toBe(false);
  });

  it("parses confirm + apply", () => {
    const a = parseRepairArgs(["--apply-member-links", "--confirm-apply"]);
    expect(a.applyMemberLinks).toBe(true);
    expect(a.confirmApply).toBe(true);
    expect(a.anyApply).toBe(true);
  });
});

describe("linkedRecordIds / fieldStr", () => {
  it("reads linked id arrays", () => {
    expect(linkedRecordIds({ Cities: ["rec1", "rec2"] }, "Cities")).toEqual([
      "rec1",
      "rec2",
    ]);
  });

  it("reads object-shaped linked records as bare ids", () => {
    expect(
      linkedRecordIds({ Cities: [{ id: "rec1" }, { id: "rec2" }] }, "Cities")
    ).toEqual(["rec1", "rec2"]);
  });

  it("sameIdSet ignores order", () => {
    expect(sameIdSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameIdSet(["a"], ["a", "b"])).toBe(false);
  });
});

describe("toLinkedRecordWriteValue", () => {
  it("writes bare record id strings only", async () => {
    const { toLinkedRecordWriteValue } = await import(
      "@/lib/ops/city-relation-repair"
    );
    expect(toLinkedRecordWriteValue(["recAbc", "recAbc", "nope"])).toEqual(["recAbc"]);
    // Must never produce objects (Airtable rejects as "[object Object]")
    const out = toLinkedRecordWriteValue(["recX"]);
    expect(typeof out[0]).toBe("string");
    expect(out[0]).toBe("recX");
  });
});

describe("pickCanonicalDuplicate", () => {
  it("prefers Brazil country", () => {
    const fields = {
      cityName: "City",
      cityCountry: "Country",
      cityChannels: "Slack channels",
    } as never;
    const a: AirtableRecord = {
      id: "recA",
      fields: { City: "São Paulo", Country: "USA" },
    };
    const b: AirtableRecord = {
      id: "recB",
      fields: { City: "São Paulo", Country: "Brazil", "Slack channels": ["ch1"] },
    };
    expect(pickCanonicalDuplicate([a, b], fields).id).toBe("recB");
  });
});

describe("resolveMemberCityChannel", () => {
  const city: AirtableRecord = {
    id: "recCity1",
    fields: { City: "Denver", "Slack channels": ["recCh1"] },
  };
  const channelActive: AirtableRecord = {
    id: "recCh1",
    fields: {
      Name: "Denver",
      "Channel status/donut": "Active",
      "Slack Channel ID": "C123",
    },
  };
  const channelPaused: AirtableRecord = {
    id: "recCh2",
    fields: {
      Name: "Paused Town",
      "Channel status/donut": "Paused",
      "Slack Channel ID": "",
    },
  };

  it("prefers linked City relation", () => {
    const r = resolveMemberCityChannel({
      memberFields: { "City relation": ["recCity1"], City: "Wrong" },
      citiesById: new Map([["recCity1", city]]),
      channelsById: new Map([["recCh1", channelActive]]),
      memberCityLinkField: "City relation",
      memberCityLegacyField: "City",
      cityNameField: "City",
      cityChannelsField: "Slack channels",
      channelNameField: "Name",
      channelStatusField: "Channel status/donut",
      channelSlackIdField: "Slack Channel ID",
    });
    expect(r.cityName).toBe("Denver");
    expect(r.slackChannelId).toBe("C123");
    expect(r.condition).toBe("ACTIVE_CHANNEL_READY");
    expect(r.usedLegacyFallback).toBe(false);
  });

  it("falls back to legacy City text", () => {
    const r = resolveMemberCityChannel({
      memberFields: { City: "Denver" },
      citiesById: new Map([["recCity1", city]]),
      channelsById: new Map([["recCh1", channelActive]]),
      memberCityLinkField: "City relation",
      memberCityLegacyField: "City",
      cityNameField: "City",
      cityChannelsField: "Slack channels",
      channelNameField: "Name",
      channelStatusField: "Channel status/donut",
      channelSlackIdField: "Slack Channel ID",
    });
    expect(r.cityRecordId).toBe("recCity1");
    expect(r.usedLegacyFallback).toBe(true);
  });

  it("does not treat paused channel as active missing ID", () => {
    const pausedCity: AirtableRecord = {
      id: "recCity2",
      fields: { City: "X", "Slack channels": ["recCh2"] },
    };
    const r = resolveMemberCityChannel({
      memberFields: { "City relation": ["recCity2"] },
      citiesById: new Map([["recCity2", pausedCity]]),
      channelsById: new Map([["recCh2", channelPaused]]),
      memberCityLinkField: "City relation",
      memberCityLegacyField: "City",
      cityNameField: "City",
      cityChannelsField: "Slack channels",
      channelNameField: "Name",
      channelStatusField: "Channel status/donut",
      channelSlackIdField: "Slack Channel ID",
    });
    expect(r.condition).toBe("CITY_CHANNEL_PAUSED");
    expect(conditionMessage(r.condition)).toMatch(/Paused/i);
  });

  it("flags active channel missing slack id", () => {
    const bad: AirtableRecord = {
      id: "recCh3",
      fields: {
        Name: "Bad",
        "Channel status/donut": "Active",
        "Slack Channel ID": "",
      },
    };
    const c: AirtableRecord = {
      id: "recCity3",
      fields: { City: "Y", "Slack channels": ["recCh3"] },
    };
    const r = resolveMemberCityChannel({
      memberFields: { "City relation": ["recCity3"] },
      citiesById: new Map([["recCity3", c]]),
      channelsById: new Map([["recCh3", bad]]),
      memberCityLinkField: "City relation",
      memberCityLegacyField: "City",
      cityNameField: "City",
      cityChannelsField: "Slack channels",
      channelNameField: "Name",
      channelStatusField: "Channel status/donut",
      channelSlackIdField: "Slack Channel ID",
    });
    expect(r.condition).toBe("ACTIVE_CHANNEL_MISSING_SLACK_ID");
  });
});

describe("fieldStr", () => {
  it("handles arrays", () => {
    expect(fieldStr({ City: ["recAbc"] }, "City")).toBe("recAbc");
  });
});
