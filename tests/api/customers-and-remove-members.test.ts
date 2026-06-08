import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/integrations/airtable");

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

    const res = await getCustomers(req("http://localhost/api/get-daily-new-customers-for-cities?city=London&startDate=2026-01-01&endDate=2026-01-01"));
    const body = await res.json();
    const item = body.data[0];

    expect(typeof item.city).toBe("string");
    expect(typeof item.filename).toBe("string");
    expect(typeof item.count).toBe("number");
    expect(Array.isArray(item.emails)).toBe(true);
    expect(typeof item.csv).toBe("string");
    expect(Array.isArray(item.customers)).toBe(true);
    expect(Array.isArray(item.breakdown)).toBe(true);
  });

  it("each customer record has name, surname, email, city, phone fields", async () => {
    vi.mocked(createAirtableClient).mockReturnValue({
      listRecords: vi.fn().mockResolvedValue([SAMPLE_RECORD]),
    } as any);

    const res = await getCustomers(req("http://localhost/api/get-daily-new-customers-for-cities?city=London&startDate=2026-01-01&endDate=2026-01-01"));
    const body = await res.json();
    const customer = body.data[0].customers[0];

    expect(customer).toHaveProperty("name");
    expect(customer).toHaveProperty("surname");
    expect(customer).toHaveProperty("email");
    expect(customer).toHaveProperty("city");
    expect(customer).toHaveProperty("phone");
    expect(customer.email).toBe("alice@test.com");
  });

  it("csv field is a comma-joined list of emails", async () => {
    vi.mocked(createAirtableClient).mockReturnValue({
      listRecords: vi.fn().mockResolvedValue([
        SAMPLE_RECORD,
        { id: "r2", fields: { "First Name": "Bob", "Last Name": "Jones", email: "bob@test.com", City: "London", "phone number": "" } },
      ]),
    } as any);

    const res = await getCustomers(req("http://localhost/api/get-daily-new-customers-for-cities?city=London&startDate=2026-01-01&endDate=2026-01-01"));
    const body = await res.json();
    const csvEmails = body.data[0].csv.split(",");
    expect(csvEmails).toContain("alice@test.com");
    expect(csvEmails).toContain("bob@test.com");
  });
});

describe("GET /api/remove-members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
  });

  it("returns 400 when startDate or endDate missing", async () => {
    vi.mocked(createAirtableClient).mockReturnValue({
      listRecords: vi.fn().mockResolvedValue([]),
    } as any);
    const res = await getRemoved(req("http://localhost/api/remove-members?startDate=2026-01-01"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("response JSON has top-level fields: success, total, startDate, endDate, data", async () => {
    vi.mocked(createAirtableClient).mockReturnValue({
      listRecords: vi.fn().mockResolvedValue([
        {
          id: "r1",
          fields: {
            "First Name": "Alice", "Last Name": "Smith",
            email: "alice@test.com", City: "London",
            "phone number": "07700000000",
            "Cancellation date": "2026-05-01",
          },
        },
      ]),
    } as any);

    const res = await getRemoved(req("http://localhost/api/remove-members?startDate=2026-01-01&endDate=2026-01-31"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.startDate).toBe("string");
    expect(typeof body.endDate).toBe("string");
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("each cancelled member record has id, name, surname, email, city, phone, cancelledDate", async () => {
    vi.mocked(createAirtableClient).mockReturnValue({
      listRecords: vi.fn().mockResolvedValue([
        {
          id: "r1",
          fields: {
            "First Name": "Alice", "Last Name": "Smith",
            email: "alice@test.com", City: "London",
            "phone number": "07700000000",
            "Cancellation date": "2026-05-01",
          },
        },
      ]),
    } as any);

    const res = await getRemoved(req("http://localhost/api/remove-members?startDate=2026-01-01&endDate=2026-01-31"));
    const body = await res.json();
    const member = body.data[0];

    expect(member).toHaveProperty("id");
    expect(member).toHaveProperty("name");
    expect(member).toHaveProperty("surname");
    expect(member).toHaveProperty("email");
    expect(member).toHaveProperty("city");
    expect(member).toHaveProperty("phone");
    expect(member).toHaveProperty("cancelledDate");
    expect(member.email).toBe("alice@test.com");
    expect(member.cancelledDate).toBe("2026-05-01");
  });

  it("members without email are filtered out of response", async () => {
    vi.mocked(createAirtableClient).mockReturnValue({
      listRecords: vi.fn().mockResolvedValue([
        { id: "r1", fields: { "First Name": "No", "Last Name": "Email", email: "", City: "London", "phone number": "", "Cancellation date": "2026-05-01" } },
        { id: "r2", fields: { "First Name": "Has", "Last Name": "Email", email: "has@test.com", City: "London", "phone number": "", "Cancellation date": "2026-05-01" } },
      ]),
    } as any);

    const res = await getRemoved(req("http://localhost/api/remove-members?startDate=2026-01-01&endDate=2026-01-31"));
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.data[0].email).toBe("has@test.com");
  });
});
