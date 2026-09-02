/**
 * Server-only Vercel REST API client (https://api.vercel.com).
 * Powers the ops dashboard Vercel billing tab: team/plan info and the
 * FOCUS billing charges feed (GET /v1/billing/charges, JSONL).
 * Lazy like stripe.ts — no token required at module evaluation time.
 */

export const VERCEL_API_BASE = "https://api.vercel.com";

export class VercelApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "VercelApiError";
    this.status = status;
  }
}

export function getVercelToken(): string {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    throw new Error("VERCEL_TOKEN is not set");
  }
  return token;
}

async function vercelFetch<T>(
  path: string,
  query?: Record<string, string | number | undefined>
): Promise<T> {
  const url = new URL(`${VERCEL_API_BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getVercelToken()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body.error?.message ? `: ${body.error.message}` : "";
    } catch {
      // Non-JSON error body — keep the status only
    }
    throw new VercelApiError(`Vercel API ${res.status} ${path}${detail}`, res.status);
  }
  return (await res.json()) as T;
}

// —— Types (only what the billing tab needs) ——

export type VercelInvoiceItem = {
  batch?: number;
  price: number;
  threshold?: number;
  hidden?: boolean;
  matrix?: {
    defaultUnitPrice?: string;
    dimensionPrices?: Record<string, string>;
  };
};

export type VercelBilling = {
  plan?: "hobby" | "pro" | "enterprise";
  planIteration?: string;
  status?: string;
  currency?: string;
  email?: string;
  name?: string;
  orbSubscriptionId?: string;
  period?: { start: number; end: number };
  invoiceItems?: Record<string, VercelInvoiceItem>;
};

export type VercelTeam = {
  id: string;
  slug: string;
  name: string | null;
  billing?: VercelBilling | null;
};

export type VercelCharge = {
  ChargePeriodStart: string;
  ChargePeriodEnd: string;
  ChargeCategory: string;
  BilledCost: number;
  EffectiveCost: number;
  ServiceName: string;
  ServiceCategory: string;
  ServiceProviderName?: string;
  ConsumedQuantity: number | null;
  ConsumedUnit: string | null;
  PricingCategory?: string;
  PricingQuantity?: number | null;
  PricingUnit?: string;
  RegionName?: string;
  Tags?: Record<string, unknown>;
};

// —— API calls ——

export async function listVercelTeams(): Promise<VercelTeam[]> {
  const data = await vercelFetch<{ teams?: VercelTeam[] }>("/v2/teams", { limit: 100 });
  return data.teams ?? [];
}

export async function getVercelTeam(teamId: string): Promise<VercelTeam> {
  return vercelFetch<VercelTeam>(`/v2/teams/${teamId}`);
}

/** FOCUS billing charges as JSONL (one charge object per line). */
export async function getVercelCharges(args: {
  teamId: string;
  from: string;
  to: string;
}): Promise<VercelCharge[]> {
  const res = await fetch(
    `${VERCEL_API_BASE}/v1/billing/charges?teamId=${encodeURIComponent(args.teamId)}` +
      `&from=${encodeURIComponent(args.from)}&to=${encodeURIComponent(args.to)}`,
    {
      headers: { Authorization: `Bearer ${getVercelToken()}` },
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    }
  );
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body.error?.message ? `: ${body.error.message}` : "";
    } catch {
      // Non-JSON error body
    }
    throw new VercelApiError(`Vercel API ${res.status} /v1/billing/charges${detail}`, res.status);
  }
  const text = await res.text();
  const charges: VercelCharge[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    charges.push(JSON.parse(trimmed) as VercelCharge);
  }
  return charges;
}

// —— Context resolution ——

export type VercelBillingContext = {
  team: VercelTeam;
  /** Timestamp (ms) of the current billing period start, or null if unknown. */
  periodStartMs: number | null;
};

export async function resolveVercelBillingContext(): Promise<VercelBillingContext> {
  const explicitTeamId = process.env.VERCEL_TEAM_ID?.trim();

  let team: VercelTeam | undefined;
  if (explicitTeamId) {
    team = await getVercelTeam(explicitTeamId);
  } else {
    const teams = await listVercelTeams();
    team = teams[0];
  }

  if (!team) {
    throw new Error(
      "Could not resolve the Vercel team: no teams returned and VERCEL_TEAM_ID is not set"
    );
  }

  return {
    team,
    periodStartMs: team.billing?.period?.start ?? null,
  };
}
