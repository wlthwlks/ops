/**
 * Server-only Resend read API client for the ops dashboard billing tab.
 * Resend exposes no billing/spend endpoints — this client pulls the
 * account-level email metrics and domain list so the tab can track send
 * volume against plan quotas and health thresholds.
 *
 * Key precedence matches the Delivery States tab convention:
 * RESEND_READ_API_KEY (emails:read) falls back to RESEND_API_KEY.
 */

export const RESEND_API_BASE = "https://api.resend.com";

export class ResendApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ResendApiError";
    this.status = status;
  }
}

export function getResendReadApiKey(): string {
  const key = (process.env.RESEND_READ_API_KEY || process.env.RESEND_API_KEY || "").trim();
  if (!key) {
    throw new Error("RESEND_API_KEY is not set");
  }
  return key;
}

export type ResendMetricName =
  | "sent"
  | "delivered"
  | "bounced"
  | "complained"
  | "suppressed"
  | "failed"
  | "opened"
  | "unique_opened"
  | "clicked"
  | "unique_clicked"
  | "delivery_rate"
  | "open_rate"
  | "click_rate"
  | "bounce_rate"
  | "complaint_rate"
  | "unsubscribe_rate";

export type ResendMetricsRow = {
  period?: string;
  domain_id?: string;
  domain_name?: string;
  [metric: string]: string | number | undefined;
};

export type ResendMetrics = {
  totals: Record<string, number>;
  data: ResendMetricsRow[];
};

export type ResendDomain = {
  id: string;
  name: string;
  status: string;
  region?: string;
};

async function resendFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${RESEND_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${getResendReadApiKey()}`,
      "User-Agent": "wlth-wlks-ops/1.0",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string; name?: string };
      detail = body.message ? `: ${body.message}` : "";
    } catch {
      // Non-JSON error body
    }
    throw new ResendApiError(`Resend API ${res.status} ${path}${detail}`, res.status);
  }
  return (await res.json()) as T;
}

export async function getResendEmailMetrics(args: {
  startDate: string;
  endDate: string;
  metrics: ResendMetricName[];
  dimensions?: ("period" | "domain" | "email" | "broadcast")[];
  granularity?: "hourly" | "daily" | "weekly" | "monthly";
  timezone?: string;
}): Promise<ResendMetrics> {
  const params = new URLSearchParams({
    start_date: args.startDate,
    end_date: args.endDate,
    metrics: args.metrics.join(","),
  });
  if (args.dimensions?.length) params.set("dimensions", args.dimensions.join(","));
  if (args.granularity) params.set("granularity", args.granularity);
  if (args.timezone) params.set("timezone", args.timezone);
  const data = await resendFetch<{ totals?: Record<string, number>; data?: ResendMetricsRow[] }>(
    `/emails/metrics?${params.toString()}`
  );
  return { totals: data.totals ?? {}, data: data.data ?? [] };
}

export async function listResendDomains(): Promise<ResendDomain[]> {
  const data = await resendFetch<{ data?: ResendDomain[] }>("/domains?limit=100");
  return data.data ?? [];
}
