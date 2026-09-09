import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchResendEmailsPage,
  listRecentResendEmails,
} from "@/lib/integrations/resend-emails";

afterEach(() => {
  vi.unstubAllGlobals();
});

function listResponse(items: unknown[], hasMore = false) {
  return {
    object: "list",
    has_more: hasMore,
    data: items,
  };
}

function emailRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "f05f390a-98f4-4775-a4c7-733a3a7161e8",
    to: ["hello@marigoldgrove.co"],
    from: "WLTH WLKS <noreply@wlthwlks.com>",
    created_at: "2026-09-01 20:40:14.359+00",
    subject: "Introductions for Boulder",
    last_event: "bounced",
    ...overrides,
  };
}

describe("fetchResendEmailsPage", () => {
  it("parses rows and exposes the after cursor", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => listResponse([emailRow()], true),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchResendEmailsPage({ apiKey: "re_test" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails?limit=100",
      expect.objectContaining({
        headers: { Authorization: "Bearer re_test" },
      })
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe("f05f390a-98f4-4775-a4c7-733a3a7161e8");
    expect(page.items[0]?.lastEvent).toBe("bounced");
    expect(page.items[0]?.to).toEqual(["hello@marigoldgrove.co"]);
    expect(page.nextAfter).toBe("f05f390a-98f4-4775-a4c7-733a3a7161e8");
    expect(page.hasMore).toBe(true);
  });

  it("throws on non-ok responses", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchResendEmailsPage({ apiKey: "re_bad" })
    ).rejects.toThrow(/401/);
  });
});

describe("listRecentResendEmails", () => {
  it("paginates with the after cursor and stops on has_more=false", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => listResponse([emailRow({ id: "id_b" })], true),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => listResponse([emailRow({ id: "id_a", last_event: "delivered" })], false),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listRecentResendEmails({ apiKey: "re_test", maxPages: 5 });
    expect(result.pagesFetched).toBe(2);
    expect(result.emails.map((e) => e.id)).toEqual(["id_b", "id_a"]);
    const secondUrl = String(fetchMock.mock.calls[1][0]);
    expect(secondUrl).toContain("after=id_b");
  });

  it("stops after maxPages even when has_more stays true", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => listResponse([emailRow({ id: "id_x" })], true),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listRecentResendEmails({ apiKey: "re_test", maxPages: 3 });
    expect(result.pagesFetched).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
