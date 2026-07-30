import { describe, it, expect } from "vitest";

/** Bounded concurrency helper (mirrors scripts/backfill-service-access-until.ts). */
async function mapPoolTracked<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<{ results: R[]; maxInFlight: number }> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        results[i] = await fn(items[i], i);
      } finally {
        inFlight--;
      }
    }
  }

  const n = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return { results, maxInFlight };
}

describe("full backfill concurrency", () => {
  it("uses bounded concurrency (max 4)", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const { maxInFlight, results } = await mapPoolTracked(items, 4, async (n) => {
      await new Promise((r) => setTimeout(r, 5));
      return n * 2;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(results).toHaveLength(20);
    expect(results[0]).toBe(0);
    expect(results[19]).toBe(38);
  });

  it("single item uses concurrency 1", async () => {
    const { maxInFlight } = await mapPoolTracked([1], 4, async (n) => n);
    expect(maxInFlight).toBe(1);
  });
});
