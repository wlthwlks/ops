import { opRuns } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import type { OpContext, OpResult } from "./types";
import type { AppDb } from "@/db";

function scrubSecrets(message: string): string {
  return message
    .replace(/sk_live_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/sk_test_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/whsec_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/pat[A-Za-z0-9._-]{10,}/g, "[redacted]")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted]");
}

export async function createRunLogger(
  db: AppDb,
  opSlug: string,
  meta?: {
    variant?: string;
    parameters?: Record<string, unknown>;
    operatorClerkUserId?: string;
    runtimeMode?: string;
    idempotencyKey?: string;
  }
) {
  const baseValues: Record<string, unknown> = {
    opSlug,
    status: "running",
  };
  if (meta?.variant) baseValues.variant = meta.variant;
  if (meta?.parameters) baseValues.parametersJson = JSON.stringify(meta.parameters);
  if (meta?.operatorClerkUserId) baseValues.operatorClerkUserId = meta.operatorClerkUserId;
  if (meta?.runtimeMode) baseValues.runtimeMode = meta.runtimeMode;
  if (meta?.idempotencyKey) baseValues.idempotencyKey = meta.idempotencyKey;

  const [inserted] = await db
    .insert(opRuns)
    .values(baseValues as typeof opRuns.$inferInsert)
    .returning({ id: opRuns.id });

  const runId: number = inserted.id;

  const log = async (message: string): Promise<void> => {
    const line = `[${new Date().toISOString()}] ${scrubSecrets(message)}`;
    await db
      .update(opRuns)
      .set({
        log: sql`CASE WHEN ${opRuns.log} = '' THEN ${line} ELSE ${opRuns.log} || E'\n' || ${line} END`,
      })
      .where(eq(opRuns.id, runId));
  };

  const setProgress = async (current: number, total?: number): Promise<void> => {
    try {
      await db
        .update(opRuns)
        .set({
          progressCurrent: current,
          ...(total != null ? { progressTotal: total } : {}),
        })
        .where(eq(opRuns.id, runId));
    } catch {
      /* columns may not exist pre-migration */
    }
  };

  let checkpoint: Record<string, unknown> | null = null;
  const getCheckpoint = () => checkpoint;
  const setCheckpoint = async (next: Record<string, unknown>): Promise<void> => {
    checkpoint = next;
    try {
      await db
        .update(opRuns)
        .set({ checkpointJson: JSON.stringify(next) })
        .where(eq(opRuns.id, runId));
    } catch {
      /* ignore */
    }
  };

  const ctx: OpContext = {
    db,
    log,
    params: meta?.parameters,
    variant: meta?.variant,
    setProgress,
    getCheckpoint,
    setCheckpoint,
  };

  const finishRun = async (result: OpResult, error?: string): Promise<void> => {
    await db
      .update(opRuns)
      .set({
        status: result.success ? "success" : "failed",
        summary: scrubSecrets(result.summary),
        finishedAt: new Date(),
        ...(error ? { error: scrubSecrets(error) } : {}),
      })
      .where(eq(opRuns.id, runId));
  };

  return { ctx, runId, finishRun };
}
