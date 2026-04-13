import { createRunLogger } from "./logger";
import type { Op, OpResult } from "./types";

export async function runOp(op: Op, db: any): Promise<OpResult> {
  const { ctx, finishRun } = createRunLogger(db, op.slug);

  try {
    const result = await op.run(ctx);
    finishRun(result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const failResult: OpResult = {
      success: false,
      summary: `Error: ${message}`,
    };
    finishRun(failResult);
    return failResult;
  }
}
