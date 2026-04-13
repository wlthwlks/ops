import { describe, it, expect, vi } from "vitest";
import { memberExport } from "@/lib/ops/member-export";

vi.mock("@/lib/integrations/airtable", () => ({
  createAirtableClient: () => ({
    listRecords: vi.fn().mockResolvedValue([
      { id: "rec1", fields: { Name: "Alice", Email: "alice@test.com", Role: "Member" } },
      { id: "rec2", fields: { Name: "Bob", Email: "bob@test.com", Role: "Lead" } },
    ]),
  }),
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

describe("member-export op", () => {
  it("has correct metadata", () => {
    expect(memberExport.slug).toBe("member-export");
    expect(memberExport.schedule).toBeUndefined();
  });

  it("exports members to CSV", async () => {
    const logs: string[] = [];
    const ctx = { log: (msg: string) => logs.push(msg), db: {} as any };
    const result = await memberExport.run(ctx);
    expect(result.success).toBe(true);
    expect(result.recordsProcessed).toBe(2);
    expect(result.summary).toContain("2");
  });
});
