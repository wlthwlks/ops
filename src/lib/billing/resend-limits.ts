/**
 * Resend plan limits and flag rules for the ops dashboard billing tab.
 *
 * Resend's API does not expose the account plan, billing amount, or quotas —
 * only email metrics and domains. Plan selection and limits therefore come
 * from configuration (RESEND_PLAN / RESEND_PLAN_LIMITS_JSON) with defaults
 * from https://resend.com/pricing. Health thresholds (bounce/spam rates that
 * pause sending) come from Resend's account quotas documentation.
 */

export type ResendPlanLimits = {
  /** Display name. */
  label: string;
  /** Flat plan price in USD per month. */
  pricePerMonthUsd: number;
  /** Daily email quota, or null for paid plans (no daily quota). */
  dailyQuota: number | null;
  /** Monthly email quota (included), or null for custom/enterprise plans. */
  monthlyQuota: number | null;
  /** Verified domains allowed. */
  domainsLimit: number;
  /** Overage email price per 1,000 emails, or null when overages don't apply. */
  overagePerThousandUsd: number | null;
};

export const RESEND_DEFAULT_LIMITS: Record<string, ResendPlanLimits> = {
  free: {
    label: "Free",
    pricePerMonthUsd: 0,
    dailyQuota: 100,
    monthlyQuota: 3_000,
    domainsLimit: 3,
    overagePerThousandUsd: null,
  },
  pro: {
    label: "Pro",
    pricePerMonthUsd: 20,
    dailyQuota: null,
    monthlyQuota: 50_000,
    domainsLimit: 10,
    overagePerThousandUsd: 0.5,
  },
  scale: {
    label: "Scale",
    pricePerMonthUsd: 100,
    dailyQuota: null,
    monthlyQuota: 500_000,
    domainsLimit: 1_000,
    overagePerThousandUsd: 0.4,
  },
};

let _limitsCache: Record<string, ResendPlanLimits> | null | undefined;

function parseLimitsOverride(): Record<string, ResendPlanLimits> | null {
  const raw = process.env.RESEND_PLAN_LIMITS_JSON;
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ResendPlanLimits>>;
    const merged: Record<string, ResendPlanLimits> = {};
    for (const [plan, overrides] of Object.entries(parsed)) {
      merged[plan] = { ...(RESEND_DEFAULT_LIMITS[plan] ?? RESEND_DEFAULT_LIMITS.pro), ...overrides };
    }
    return merged;
  } catch {
    return null;
  }
}

export function getResendPlanLimits(): Record<string, ResendPlanLimits> {
  if (_limitsCache === undefined) {
    _limitsCache = parseLimitsOverride();
  }
  return { ...RESEND_DEFAULT_LIMITS, ...(_limitsCache ?? {}) };
}

export function resetResendLimitsCache(): void {
  _limitsCache = undefined;
}

export function getResendPlan(): string {
  const plan = (process.env.RESEND_PLAN ?? "pro").trim().toLowerCase();
  return getResendPlanLimits()[plan] ? plan : "pro";
}

export function getResendLimitsForPlan(): ResendPlanLimits {
  return getResendPlanLimits()[getResendPlan()] ?? RESEND_DEFAULT_LIMITS.pro;
}

// —— Flags ——

export type ResendFlag = {
  level: "info" | "warning" | "error";
  title: string;
  message: string;
};

/** Resend pauses sending above these health rates. */
export const RESEND_BOUNCE_RATE_LIMIT_PCT = 4;
export const RESEND_COMPLAINT_RATE_LIMIT_PCT = 0.08;
/** Warn when approaching a quota. */
export const RESEND_QUOTA_WARNING_PCT = 0.8;

export type ResendUsageSnapshot = {
  plan: string;
  limits: ResendPlanLimits;
  sentToday: number;
  sentThisMonth: number;
  bounceRatePct: number | null;
  complaintRatePct: number | null;
  delivered: number;
  bounced: number;
  complained: number;
  domains: { total: number; verified: number };
  estimatedMonthlyCostUsd: number | null;
};

export function buildResendFlags(snapshot: ResendUsageSnapshot): ResendFlag[] {
  const flags: ResendFlag[] = [];
  const { limits } = snapshot;

  // Daily quota (free plan)
  if (limits.dailyQuota) {
    const pct = snapshot.sentToday / limits.dailyQuota;
    if (pct >= 1) {
      flags.push({
        level: "error",
        title: "Daily quota reached",
        message: `${snapshot.sentToday.toLocaleString("en-US")} emails sent today — the ${limits.dailyQuota.toLocaleString("en-US")}/day quota on the ${limits.label} plan is exhausted. Sending will be blocked until tomorrow.`,
      });
    } else if (pct >= RESEND_QUOTA_WARNING_PCT) {
      flags.push({
        level: "warning",
        title: "Daily quota almost reached",
        message: `${snapshot.sentToday.toLocaleString("en-US")} of ${limits.dailyQuota.toLocaleString("en-US")} emails sent today (${(pct * 100).toFixed(0)}%). Consider upgrading to avoid hitting the limit.`,
      });
    }
  }

  // Monthly quota
  if (limits.monthlyQuota) {
    const pct = snapshot.sentThisMonth / limits.monthlyQuota;
    if (pct >= 1) {
      flags.push({
        level: "error",
        title: "Monthly quota reached",
        message: `${snapshot.sentThisMonth.toLocaleString("en-US")} emails this month — the included ${limits.monthlyQuota.toLocaleString("en-US")}/month quota is exhausted.${limits.overagePerThousandUsd !== null ? " Overage pricing now applies." : " Sending is paused until the next billing cycle."}`,
      });
    } else if (pct >= RESEND_QUOTA_WARNING_PCT) {
      flags.push({
        level: "warning",
        title: "Monthly quota almost reached",
        message: `${(pct * 100).toFixed(0)}% of the ${limits.monthlyQuota.toLocaleString("en-US")}/month quota used (${snapshot.sentThisMonth.toLocaleString("en-US")} emails).`,
      });
    }
  }

  // Health thresholds (account-wide, pauses sending when breached)
  if (snapshot.bounceRatePct !== null && snapshot.bounceRatePct >= RESEND_BOUNCE_RATE_LIMIT_PCT) {
    flags.push({
      level: "error",
      title: `Bounce rate ${snapshot.bounceRatePct.toFixed(2)}% — above ${RESEND_BOUNCE_RATE_LIMIT_PCT}%`,
      message: `Resend pauses sending when the bounce rate exceeds ${RESEND_BOUNCE_RATE_LIMIT_PCT}%. ${snapshot.bounced.toLocaleString("en-US")} bounces / ${snapshot.sentThisMonth.toLocaleString("en-US")} sent. Clean the recipient list and remove inactive addresses.`,
    });
  } else if (snapshot.bounceRatePct !== null && snapshot.bounceRatePct >= RESEND_BOUNCE_RATE_LIMIT_PCT / 2) {
    flags.push({
      level: "warning",
      title: `Bounce rate ${snapshot.bounceRatePct.toFixed(2)}% — half of the ${RESEND_BOUNCE_RATE_LIMIT_PCT}% pause threshold`,
      message: "Keep an eye on bounces; the account is paused at 4%.",
    });
  }

  if (
    snapshot.complaintRatePct !== null &&
    snapshot.complaintRatePct >= RESEND_COMPLAINT_RATE_LIMIT_PCT
  ) {
    flags.push({
      level: "error",
      title: `Spam complaint rate ${snapshot.complaintRatePct.toFixed(3)}% — above ${RESEND_COMPLAINT_RATE_LIMIT_PCT}%`,
      message: `Resend pauses sending when the complaint rate exceeds ${RESEND_COMPLAINT_RATE_LIMIT_PCT}%. Review email content and recipient consent.`,
    });
  }

  // Domains
  if (snapshot.domains.total >= limits.domainsLimit) {
    flags.push({
      level: "warning",
      title: "Domain limit reached",
      message: `${snapshot.domains.total} of ${limits.domainsLimit} verified domains used on the ${limits.label} plan. Add more via the $20/month domains add-on or upgrade.`,
    });
  }

  return flags;
}

/** Estimate the monthly Resend cost (plan price + quota overage at the plan rate). */
export function estimateResendMonthlyCost(snapshot: ResendUsageSnapshot): number | null {
  const { limits } = snapshot;
  if (limits.pricePerMonthUsd === 0 && limits.overagePerThousandUsd === null) return 0;
  let cost = limits.pricePerMonthUsd;
  if (limits.monthlyQuota && limits.overagePerThousandUsd !== null) {
    const over = Math.max(0, snapshot.sentThisMonth - limits.monthlyQuota);
    cost += (over / 1_000) * limits.overagePerThousandUsd;
  }
  return Math.round(cost * 100) / 100;
}
