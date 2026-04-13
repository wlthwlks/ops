import { createRegistry } from "./registry";
import type { Op } from "./types";

const ops: Op[] = [];

export const registry = createRegistry(ops);
