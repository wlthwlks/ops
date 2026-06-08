import type { AppDb } from "@/db";

export interface OpContext {
  log: (message: string) => Promise<void>;
  db: AppDb;
}

export interface OpResult {
  success: boolean;
  summary: string;
  recordsProcessed?: number;
}

export interface Op {
  slug: string;
  name: string;
  description: string;
  schedule?: string;
  run: (ctx: OpContext) => Promise<OpResult>;
}
