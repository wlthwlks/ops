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
    Name: "Alice Smith",
    email: "alice@test.com",
    "Date joined": "2026-01-01",
    City: "London",
    "City relation": [],
    "post code": "E1 6AN",
    "Stripe Customer ID": "cus_123",
    Membership: "Active",
    Payment: "Paid",
    "Service access until": "2026-02-01",
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

  it("response JSON has required top-level fields: success, startDate, endDate, total, members", async () => {
    vi.mocked(createAirtableClient).mockReturnValue({
      listRecords: vi.fn().mockResolvedValue([SAMPLE_RECORD]),
    } as unknown as ReturnType<typeof createAirtableClient>);

    const res = await getCustomers(
      req(
        "http://localhost/api/get-daily-new-customers-for-cities?startDate=2026-01-01&endDate=2026-01-01"
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.startDate).toBe("string");
    expect(typeof body.endDate).toBe("string");
    expect(typeof body.total).toBe("number");
    expect(Array.isArray(body.members)).toBe(true);
  });

  it("each member has the contract fields: id, name, email, dateJoined, country, city, postCode, stripeCustomerId", async () => {
    vi.mocked(createAirtableClient).mockReturnValue({
      listRecords: vi.fn().mockResolvedValue([SAMPLE_RECORD]),
    } as unknown as ReturnType<typeof createAirtableClient>);

    const res = await getCustomers(
      req(
        "http://localhost/api/get-daily-new-customers-for-cities?startDate=2026-01-01&endDate=2026-01-01"
      )
    );
    const body = await res.json();
    expect(body.members[0]).toMatchObject({
      id: "r1",
      name: "Alice Smith",
      email: "alice@test.com",
      dateJoined: "2026-01-01",
      country: expect.any(String),
      city: "London",
      postCode: "E1 6AN",
      stripeCustomerId: "cus_123",
    });
  });

  it("only includes members with current service access", async () => {
    vi.mocked(createAirtableClient).mockReturnValue({
      listRecords: vi.fn().mockResolvedValue([
        SAMPLE_RECORD,
        {
          ...SAMPLE_RECORD,
          id: "r2",
          fields: {
            ...SAMPLE_RECORD.fields,
            Name: "Bob Jones",
            email: "bob@test.com",
            Membership: "Cancelled",
            Payment: "Unpaid",
            "Service access until": "",
          },
        },
      ]),
    } as unknown as ReturnType<typeof createAirtableClient>);

    const res = await getCustomers(
      req(
        "http://localhost/api/get-daily-new-customers-for-cities?startDate=2026-01-01&endDate=2026-01-01"
      )
    );
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.members.map((m: { email: string }) => m.email)).toEqual([
      "alice@test.com",
    ]);
  });

  it("members are ordered by date joined, newest first", async () => {
    vi.mocked(createAirtableClient).mockReturnValue({
      listRecords: vi.fn().mockResolvedValue([
        SAMPLE_RECORD,
        {
          ...SAMPLE_RECORD,
          id: "r2",
          fields: {
            ...SAMPLE_RECORD.fields,
            Name: "Bob Jones",
            email: "bob@test.com",
            "Date joined": "2026-01-02",
          },
        },
      ]),
    } as unknown as ReturnType<typeof createAirtableClient>);

    const res = await getCustomers(
      req(
        "http://localhost/api/get-daily-new-customers-for-cities?startDate=2026-01-01&endDate=2026-01-02"
      )
    );
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.members.map((m: { email: string }) => m.email)).toEqual([
      "bob@test.com",
      "alice@test.com",
    ]);
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
