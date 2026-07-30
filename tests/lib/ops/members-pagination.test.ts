import { describe, it, expect } from "vitest";

/** Mirrors API pagination slicing used by /api/ops-dashboard/members */
function paginate<T>(items: T[], page: number, pageSize: number) {
  const total = items.length;
  const maxPage = Math.max(1, Math.ceil(total / pageSize) || 1);
  const safePage = Math.min(Math.max(1, page), maxPage);
  const start = (safePage - 1) * pageSize;
  return {
    total,
    page: safePage,
    pageSize,
    items: items.slice(start, start + pageSize),
  };
}

describe("members pagination math", () => {
  const rows = Array.from({ length: 386 }, (_, i) => ({ id: `rec${i}`, n: i }));

  it("defaults to at most 100 rows per page", () => {
    const r = paginate(rows, 1, 100);
    expect(r.items).toHaveLength(100);
    expect(r.items[0].id).toBe("rec0");
    expect(r.items[99].id).toBe("rec99");
  });

  it("page 2 starts at correct record", () => {
    const r = paginate(rows, 2, 100);
    expect(r.items[0].id).toBe("rec100");
    expect(r.items).toHaveLength(100);
  });

  it("last page has remainder", () => {
    const r = paginate(rows, 4, 100);
    expect(r.items).toHaveLength(86);
    expect(r.items[0].id).toBe("rec300");
    expect(r.items.at(-1)?.id).toBe("rec385");
  });

  it("does not duplicate or skip across pages", () => {
    const seen = new Set<string>();
    for (let p = 1; p <= 4; p++) {
      for (const item of paginate(rows, p, 100).items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
    }
    expect(seen.size).toBe(386);
  });

  it("clamps page when filter reduces total", () => {
    const filtered = rows.slice(0, 50);
    const r = paginate(filtered, 5, 100);
    expect(r.page).toBe(1);
    expect(r.items).toHaveLength(50);
  });

  it("filtered total is accurate", () => {
    const filtered = rows.filter((r) => r.n % 2 === 0);
    const r = paginate(filtered, 1, 100);
    expect(r.total).toBe(193);
    expect(r.items).toHaveLength(100);
  });
});
