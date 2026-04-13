import { db } from "@/db";
import { opRuns } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { registry } from "./registry-instance";
import type { OpRun } from "@/db/schema";

export interface OpStatus {
  slug: string;
  name: string;
  description: string;
  schedule?: string;
  lastRun?: OpRun;
  status: "idle" | "running" | "success" | "failed";
}

export function getOpsOverview(): OpStatus[] {
  const ops = registry.getAll();

  return ops.map((op) => {
    const lastRun = db
      .select()
      .from(opRuns)
      .where(eq(opRuns.opSlug, op.slug))
      .orderBy(desc(opRuns.startedAt))
      .limit(1)
      .get();

    return {
      slug: op.slug,
      name: op.name,
      description: op.description,
      schedule: op.schedule,
      lastRun: lastRun ?? undefined,
      status: (lastRun?.status as "running" | "success" | "failed") ?? "idle",
    };
  });
}

export function getOpRuns(slug: string, limit = 20): OpRun[] {
  return db
    .select()
    .from(opRuns)
    .where(eq(opRuns.opSlug, slug))
    .orderBy(desc(opRuns.startedAt))
    .limit(limit)
    .all();
}
