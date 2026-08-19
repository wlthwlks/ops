import type { AppDb } from "@/db";

export interface OpContext {
  log: (message: string) => Promise<void>;
  db: AppDb;
  /** Validated parameters for this run (server-side only). */
  /** Validated parameters for this run (server-side only). */
  params?: Record<string, unknown>;
  variant?: string;
  setProgress?: (current: number, total?: number) => Promise<void>;
  getCheckpoint?: () => Record<string, unknown> | null;
  setCheckpoint?: (checkpoint: Record<string, unknown>) => Promise<void>;
}

export interface OpResult {
  success: boolean;
  summary: string;
  recordsProcessed?: number;
}

export type OpRiskLevel =
  | "safe_read"
  | "dry_run"
  | "write"
  | "high_risk"
  | "destructive"
  | "cli_only"
  | "deprecated";

export type OpCategory =
  | "health_checks"
  | "airtable_maintenance"
  | "billing_stripe"
  | "slack"
  | "city_relationships"
  | "introduction_history"
  | "pinecone_matching"
  | "legacy_disabled";

export interface OpVariant {
  id: string;
  label: string;
  description?: string;
  riskLevel: OpRiskLevel;
  requiresLiveMode?: boolean;
  /** Requires typing a confirmation phrase */
  confirmationPhrase?: string;
}

export interface Op {
  slug: string;
  name: string;
  description: string;
  schedule?: string;
  run: (ctx: OpContext) => Promise<OpResult>;
  /** Extended metadata for operations centre */
  category?: OpCategory;
  summary?: string;
  detailedDescription?: string;
  whenToRun?: string;
  whenNotToRun?: string;
  prerequisites?: string[];
  dataSources?: string[];
  sideEffects?: string[];
  riskLevel?: OpRiskLevel;
  supportsReadOnly?: boolean;
  requiresLiveMode?: boolean;
  requiresAdmin?: boolean;
  estimatedDuration?: string;
  commandEquivalent?: string;
  availableVariants?: OpVariant[];
  resumable?: boolean;
  deprecated?: boolean;
  productionEnabled?: boolean;
  /** When true, no dashboard Run button (CLI only). */
  cliOnly?: boolean;
}
