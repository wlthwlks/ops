import { db } from "@/db";
import { opRuns } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { registry } from "./registry-instance";
import type { OpRun } from "@/db/schema";
import type { OpCategory, OpRiskLevel } from "./types";

export interface OpStatus {
  slug: string;
  name: string;
  description: string;
  schedule?: string;
  lastRun?: OpRun;
  status: "idle" | "running" | "success" | "failed";
  category?: OpCategory;
  riskLevel?: OpRiskLevel;
  cliOnly?: boolean;
  deprecated?: boolean;
  productionEnabled?: boolean;
  requiresLiveMode?: boolean;
  supportsReadOnly?: boolean;
  summary?: string;
  commandEquivalent?: string;
  detailedDescription?: string;
  whenToRun?: string;
  whenNotToRun?: string;
  sideEffects?: string[];
  prerequisites?: string[];
}

export async function getOpsOverview(): Promise<OpStatus[]> {
  const ops = registry.getAll();

  return Promise.all(
    ops.map(async (op) => {
      let lastRun: OpRun | undefined;
      try {
        const rows = await getOpRuns(op.slug, 1);
        lastRun = rows[0];
      } catch {
        lastRun = undefined;
      }

      return {
        slug: op.slug,
        name: op.name,
        description: op.description,
        schedule: op.schedule,
        lastRun,
        status: (lastRun?.status as "running" | "success" | "failed") ?? "idle",
        category: op.category,
        riskLevel: op.riskLevel,
        cliOnly: op.cliOnly,
        deprecated: op.deprecated,
        productionEnabled: op.productionEnabled,
        requiresLiveMode: op.requiresLiveMode,
        supportsReadOnly: op.supportsReadOnly,
        summary: op.summary,
        commandEquivalent: op.commandEquivalent,
        detailedDescription: op.detailedDescription,
        whenToRun: op.whenToRun,
        whenNotToRun: op.whenNotToRun,
        sideEffects: op.sideEffects,
        prerequisites: op.prerequisites,
      };
    })
  );
}

export async function getOpRuns(slug: string, limit = 20): Promise<OpRun[]> {
  try {
    return await db
      .select()
      .from(opRuns)
      .where(eq(opRuns.opSlug, slug))
      .orderBy(desc(opRuns.startedAt))
      .limit(limit);
  } catch (err) {
    // Pre-migration DBs may lack extended op_runs columns — fall back to base fields
    const msg = err instanceof Error ? err.message : String(err);
    if (!/column .* does not exist/i.test(msg)) throw err;
    const { sql } = await import("drizzle-orm");
    const rows = await db.execute(sql`
      SELECT id, op_slug, started_at, finished_at, status, log, summary
      FROM op_runs
      WHERE op_slug = ${slug}
      ORDER BY started_at DESC
      LIMIT ${limit}
    `);
    const list = (rows as { rows?: unknown[] }).rows ?? (rows as unknown[]);
    return (list as Array<Record<string, unknown>>).map((r) => ({
      id: Number(r.id),
      opSlug: String(r.op_slug),
      startedAt: new Date(String(r.started_at)),
      finishedAt: r.finished_at ? new Date(String(r.finished_at)) : null,
      status: String(r.status),
      log: String(r.log ?? ""),
      summary: r.summary != null ? String(r.summary) : null,
      variant: null,
      parametersJson: null,
      progressCurrent: null,
      progressTotal: null,
      error: null,
      operatorClerkUserId: null,
      runtimeMode: null,
      checkpointJson: null,
      cancellationRequested: "0",
      idempotencyKey: null,
    })) as OpRun[];
  }
}
