import { opRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { OpContext, OpResult } from "./types";

export function createRunLogger(db: any, opSlug: string) {
  const inserted = db
    .insert(opRuns)
    .values({ opSlug, status: "running" })
    .returning()
    .get();

  const runId: number = inserted.id;

  const ctx: OpContext = {
    db,
    log: (message: string) => {
      const current = db
        .select({ log: opRuns.log })
        .from(opRuns)
        .where(eq(opRuns.id, runId))
        .get();

      const timestamp = new Date().toISOString();
      const newLog = current?.log
        ? `${current.log}\n[${timestamp}] ${message}`
        : `[${timestamp}] ${message}`;

      db.update(opRuns)
        .set({ log: newLog })
        .where(eq(opRuns.id, runId))
        .run();
    },
  };

  const finishRun = (result: OpResult) => {
    db.update(opRuns)
      .set({
        status: result.success ? "success" : "failed",
        summary: result.summary,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(opRuns.id, runId))
      .run();
  };

  return { ctx, runId, finishRun };
}
