import { createRegistry } from "./registry";
import type { Op } from "./types";
import { syncSignups } from "./ops/sync-signups";
import { donutTracker } from "./ops/donut-tracker";
import { memberExport } from "./ops/member-export";

const ops: Op[] = [syncSignups, donutTracker, memberExport];

export const registry = createRegistry(ops);
