import { createRunLogger } from "./logger";
import type { AppDb } from "@/db";
import type { Op, OpResult } from "./types";

export async function runOp(
  op: Op,
  db: AppDb,
  options?: {
    variant?: string;
    parameters?: Record<string, unknown>;
    operatorClerkUserId?: string;
    runtimeMode?: string;
    idempotencyKey?: string;
  }
): Promise<OpResult & { runId?: number }> {
  const { ctx, finishRun, runId } = await createRunLogger(db, op.slug, {
    variant: options?.variant,
    parameters: options?.parameters,
    operatorClerkUserId: options?.operatorClerkUserId,
    runtimeMode: options?.runtimeMode,
    idempotencyKey: options?.idempotencyKey,
  });

  try {
    const result = await op.run(ctx);
    await finishRun(result);
    return { ...result, runId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const scrubbed = message
      .replace(/sk_live_[A-Za-z0-9]+/g, "[redacted]")
      .replace(/sk_test_[A-Za-z0-9]+/g, "[redacted]")
      .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted]")
      .replace(/pat[A-Za-z0-9._-]{10,}/g, "[redacted]");
    const failResult: OpResult = {
      success: false,
      summary: `Error: ${scrubbed}`,
    };
    await finishRun(failResult, scrubbed);
    return { ...failResult, runId };
  }
}
