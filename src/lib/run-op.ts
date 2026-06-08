import { createRunLogger } from "./logger";
import type { AppDb } from "@/db";
import type { Op, OpResult } from "./types";

export async function runOp(op: Op, db: AppDb): Promise<OpResult> {
  const { ctx, finishRun } = await createRunLogger(db, op.slug);

  try {
    const result = await op.run(ctx);
    await finishRun(result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const failResult: OpResult = {
      success: false,
      summary: `Error: ${message}`,
    };
    await finishRun(failResult);
    return failResult;
  }
}
