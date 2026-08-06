import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/integrations/airtable");
vi.mock("@/lib/ops/auth", () => ({
  requireOpsViewer: vi.fn().mockResolvedValue({
    userId: "user_test",
    role: "viewer",
    mode: "read_only",
  }),
  requireOpsAdmin: vi.fn(),
  requireLiveAdmin: vi.fn(),
}));

const { createAirtableClient } = await import("@/lib/integrations/airtable");
const { GET: getCustomers } = await import("@/app/api/get-daily-new-customers-for-cities/route");
const { GET: getRemoved } = await import("@/app/api/remove-members/route");

function req(url: string): NextRequest {
  return new NextRequest(url);
}

const BASE_ENV = { AIRTABLE_GET_DATA_TOKEN: "at-token", AIRTABLE_BASE_ID: "base-id" };

const SAMPLE_RECORD = {
  id: "r1",
  fields: {
    "First Name": "Alice",
    "Last Name": "Smith",
    email: "alice@test.com",
    City: "London",
    "phone number": "07700000000",
  },
};

describe("GET /api/get-daily-new-customers-for-cities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
  });

  it("returns 500 when Airtable credentials are missing", async () => {
    delete process.env.AIRTABLE_GET_DATA_TOKEN;
    const res = await getCustomers(req("http://localhost/api/get-daily-new-customers-for-cities"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("response JSON has required top-level fields: success, startDate, endDate, data", async () => {
    vi.mocked(createAirtableClient).mockReturnValue({
      listRecords: vi.fn().mockResolvedValue([SAMPLE_RECORD]),
    } as any);

    const res = await getCustomers(req("http://localhost/api/get-daily-new-customers-for-cities?city=London&startDate=2026-01-01&endDate=2026-01-01"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.startDate).toBe("string");
    expect(typeof body.endDate).toBe("string");
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("each item in data has the contract fields: city, filename, count, emails, csv, customers, breakdown", async () => {
    vi.mocked(createAirtableClient).mockReturnValue({
      listRecords: vi.fn().mockResolvedValue([SAMPLE_RECORD]),
    } as any);

    const res = await getCustomers(
      req(
        "http://localhost/api/get-daily-new-customers-for-cities?city=London&startDate=2026-01-01&endDate=2026-01-01"
      )
    );
    const body = await res.json();
    const item = body.data[0];
    expect(item).toMatchObject({
      city: expect.any(String),
      filename: expect.any(String),
      count: expect.any(Number),
    });
    expect(Array.isArray(item.emails)).toBe(true);
    expect(typeof item.csv).toBe("string");
    expect(Array.isArray(item.customers)).toBe(true);
    expect(Array.isArray(item.breakdown)).toBe(true);
  });

  it("each customer record has name, surname, email, city, phone fields", async () => {
    vi.mocked(createAirtableClient).mockReturnValue({
      listRecords: vi.fn().mockResolvedValue([SAMPLE_RECORD]),
    } as any);

    const res = await getCustomers(
      req(
        "http://localhost/api/get-daily-new-customers-for-cities?city=London&startDate=2026-01-01&endDate=2026-01-01"
      )
    );
    const body = await res.json();
    const customer = body.data[0].customers[0];
    expect(customer).toMatchObject({
      name: expect.any(String),
      surname: expect.any(String),
      email: expect.any(String),
      city: expect.any(String),
      phone: expect.any(String),
    });
  });

  it("csv field is a comma-joined list of emails", async () => {
    vi.mocked(createAirtableClient).mockReturnValue({
      listRecords: vi.fn().mockResolvedValue([
        SAMPLE_RECORD,
        {
          id: "r2",
          fields: {
            "First Name": "Bob",
            "Last Name": "Jones",
            email: "bob@test.com",
            City: "London",
            "phone number": "07700000001",
          },
        },
      ]),
    } as any);

    const res = await getCustomers(
      req(
        "http://localhost/api/get-daily-new-customers-for-cities?city=London&startDate=2026-01-01&endDate=2026-01-01"
      )
    );
    const body = await res.json();
    const csvEmails = body.data[0].csv.split(",");
    expect(csvEmails).toContain("alice@test.com");
    expect(csvEmails).toContain("bob@test.com");
  });
});

describe("GET /api/remove-members (deprecated)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 410 Gone with redirect to Slack Access removal queue", async () => {
    const res = await getRemoved();
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("DEPRECATED");
    expect(body.redirect).toBe("/members/slack-access?tab=removal");
  });
});
