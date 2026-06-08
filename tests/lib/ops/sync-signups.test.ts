import { describe, it, expect, vi } from "vitest";
import { syncSignups } from "@/lib/ops/sync-signups";

vi.mock("@/lib/integrations/airtable", () => ({
  createAirtableClient: () => ({
    listRecords: vi.fn().mockResolvedValue([
      { id: "rec1", fields: { Name: "Alice", Email: "alice@test.com", Status: "New" } },
      { id: "rec2", fields: { Name: "Bob", Email: "bob@test.com", Status: "New" } },
    ]),
    updateRecords: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock("@/lib/integrations/slack", () => ({
  createSlackClient: () => ({
    postMessage: vi.fn().mockResolvedValue({ ts: "123" }),
  }),
}));

vi.mock("@/lib/integrations/strapi", () => ({
  createStrapiClient: () => ({
    create: vi.fn().mockResolvedValue({ data: { id: 1 } }),
  }),
}));

describe("sync-signups op", () => {
  it("has correct metadata", () => {
    expect(syncSignups.slug).toBe("sync-signups");
    expect(syncSignups.name).toBeTruthy();
    expect(syncSignups.schedule).toBeDefined();
  });

  it("runs and returns result", async () => {
    const logs: string[] = [];
    const ctx = { log: async (msg: string) => { logs.push(msg); }, db: {} as any };
    const result = await syncSignups.run(ctx);
    expect(result.success).toBe(true);
    expect(result.recordsProcessed).toBe(2);
    expect(logs.length).toBeGreaterThan(0);
  });
});
