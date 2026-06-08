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

export async function getOpsOverview(): Promise<OpStatus[]> {
  const ops = registry.getAll();

  return Promise.all(
    ops.map(async (op) => {
      const [lastRun] = await db
        .select()
        .from(opRuns)
        .where(eq(opRuns.opSlug, op.slug))
        .orderBy(desc(opRuns.startedAt))
        .limit(1);

      return {
        slug: op.slug,
        name: op.name,
        description: op.description,
        schedule: op.schedule,
        lastRun: lastRun ?? undefined,
        status: (lastRun?.status as "running" | "success" | "failed") ?? "idle",
      };
    })
  );
}

export async function getOpRuns(slug: string, limit = 20): Promise<OpRun[]> {
  return db
    .select()
    .from(opRuns)
    .where(eq(opRuns.opSlug, slug))
    .orderBy(desc(opRuns.startedAt))
    .limit(limit);
}
