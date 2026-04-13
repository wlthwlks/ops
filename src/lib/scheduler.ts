import cron from "node-cron";
import type { Op, OpResult } from "./types";

interface ScheduledTask {
  stop: () => void;
}

export function createScheduler(
  ops: readonly Op[],
  runOp: (op: Op) => Promise<OpResult>
) {
  const tasks: ScheduledTask[] = [];

  function start() {
    for (const op of ops) {
      if (!op.schedule) continue;

      const task = cron.schedule(op.schedule, async () => {
        console.log(`[scheduler] Running ${op.slug}`);
        try {
          const result = await runOp(op);
          console.log(`[scheduler] ${op.slug} finished: ${result.summary}`);
        } catch (error) {
          console.error(`[scheduler] ${op.slug} error:`, error);
        }
      });

      tasks.push(task);
    }

    console.log(`[scheduler] Started ${tasks.length} scheduled job(s)`);
  }

  function stop() {
    for (const task of tasks) {
      task.stop();
    }
    tasks.length = 0;
  }

  return { start, stop };
}
