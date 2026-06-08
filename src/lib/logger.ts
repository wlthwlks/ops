import { opRuns } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import type { OpContext, OpResult } from "./types";
import type { AppDb } from "@/db";

export async function createRunLogger(db: AppDb, opSlug: string) {
  const [inserted] = await db
    .insert(opRuns)
    .values({ opSlug, status: "running" })
    .returning({ id: opRuns.id });

  const runId: number = inserted.id;

  const log = async (message: string): Promise<void> => {
    const line = `[${new Date().toISOString()}] ${message}`;
    await db
      .update(opRuns)
      .set({
        log: sql`CASE WHEN ${opRuns.log} = '' THEN ${line} ELSE ${opRuns.log} || E'\n' || ${line} END`,
      })
      .where(eq(opRuns.id, runId));
  };

  const ctx: OpContext = { db, log };

  const finishRun = async (result: OpResult): Promise<void> => {
    await db
      .update(opRuns)
      .set({
        status: result.success ? "success" : "failed",
        summary: result.summary,
        finishedAt: new Date(),
      })
      .where(eq(opRuns.id, runId));
  };

  return { ctx, runId, finishRun };
}
