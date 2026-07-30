import { describe, it, expect } from "vitest";
import { classifyChannelStatus } from "@/lib/ops/channel-membership";
import { buildCityChannelMap } from "@/lib/ops/member-health";

describe("classifyChannelStatus", () => {
  it("classifies Active / Paused / Closed", () => {
    expect(classifyChannelStatus("Active")).toBe("active");
    expect(classifyChannelStatus("Paused")).toBe("paused");
    expect(classifyChannelStatus("Closed")).toBe("closed");
    expect(classifyChannelStatus("Something else")).toBe("other");
  });
});

describe("buildCityChannelMap", () => {
  it("maps linked Cities via Cities field only (not City)", () => {
    const map = buildCityChannelMap(
      [
        {
          id: "ch1",
          fields: {
            Name: "🔒 Montréal",
            Cities: ["city1"],
            "Slack Channel ID": "C123",
            "Channel status/donut": "Active",
          },
        },
      ],
      [{ id: "city1", fields: { City: "Montréal" } }]
    );
    expect(map.get("montréal")?.channelId).toBe("C123");
    expect(map.get("montréal")?.channelName).toBe("🔒 Montréal");
  });

  it("skips closed channels", () => {
    const map = buildCityChannelMap(
      [
        {
          id: "ch1",
          fields: {
            Name: "Old",
            Cities: ["city1"],
            "Slack Channel ID": "C999",
            "Channel status/donut": "Closed",
          },
        },
      ],
      [{ id: "city1", fields: { City: "London" } }]
    );
    expect(map.size).toBe(0);
  });
});
