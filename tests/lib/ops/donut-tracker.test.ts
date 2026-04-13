import { describe, it, expect, vi } from "vitest";
import { donutTracker } from "@/lib/ops/donut-tracker";

vi.mock("@/lib/integrations/slack", () => ({
  createSlackClient: () => ({
    getChannelHistory: vi.fn().mockResolvedValue([
      { ts: "1", text: "Paired: Alice and Bob", user: "U_BOT" },
      { ts: "2", text: "How was your chat?", user: "U_BOT" },
      { ts: "3", text: "random message", user: "U_HUMAN" },
    ]),
  }),
}));

vi.mock("@/lib/integrations/strapi", () => ({
  createStrapiClient: () => ({ create: vi.fn().mockResolvedValue({ data: { id: 1 } }) }),
}));

vi.mock("@/lib/integrations/airtable", () => ({
  createAirtableClient: () => ({ createRecords: vi.fn().mockResolvedValue([]) }),
}));

describe("donut-tracker op", () => {
  it("has correct metadata", () => {
    expect(donutTracker.slug).toBe("donut-tracker");
    expect(donutTracker.schedule).toBeDefined();
  });

  it("runs and extracts pairings", async () => {
    const logs: string[] = [];
    const ctx = { log: (msg: string) => logs.push(msg), db: {} as any };
    const result = await donutTracker.run(ctx);
    expect(result.success).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });
});
