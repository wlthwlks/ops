import type { Op } from "./types";

export interface OpRegistry {
  getAll: () => readonly Op[];
  getBySlug: (slug: string) => Op | undefined;
  getScheduled: () => readonly Op[];
}

export function createRegistry(ops: readonly Op[]): OpRegistry {
  const bySlug = new Map(ops.map((op) => [op.slug, op]));

  return {
    getAll: () => ops,
    getBySlug: (slug) => bySlug.get(slug),
    getScheduled: () => ops.filter((op) => op.schedule !== undefined),
  };
}
