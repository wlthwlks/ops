import { describe, it, expect, afterEach } from "vitest";
import {
  buildResendFlags,
  estimateResendMonthlyCost,
  getResendLimitsForPlan,
  getResendPlan,
  getResendPlanLimits,
  resetResendLimitsCache,
  type ResendUsageSnapshot,
} from "@/lib/billing/resend-limits";

function snapshot(partial: Partial<ResendUsageSnapshot>): ResendUsageSnapshot {
  const limits = getResendLimitsForPlan();
  return {
    plan: getResendPlan(),
    limits,
    sentToday: 0,
    sentThisMonth: 0,
    bounceRatePct: 0,
    complaintRatePct: 0,
    delivered: 0,
    bounced: 0,
    complained: 0,
    domains: { total: 1, verified: 1 },
    estimatedMonthlyCostUsd: null,
    ...partial,
  };
}

afterEach(() => {
  delete process.env.RESEND_PLAN;
  delete process.env.RESEND_PLAN_LIMITS_JSON;
  resetResendLimitsCache();
});

describe("buildResendFlags — daily quota (free plan)", () => {
  it("warns at 80% and errors at 100% of the daily quota", () => {
    const limits = { ...getResendLimitsForPlan(), dailyQuota: 100 };
    const warn = buildResendFlags(snapshot({ limits, sentToday: 80 }));
    expect(warn.some((f) => f.title === "Daily quota almost reached" && f.level === "warning")).toBe(true);

    const err = buildResendFlags(snapshot({ limits, sentToday: 100 }));
    expect(err.some((f) => f.title === "Daily quota reached" && f.level === "error")).toBe(true);
  });
});

describe("buildResendFlags — monthly quota", () => {
  it("warns at 80% of the monthly quota", () => {
    const limits = { ...getResendLimitsForPlan(), monthlyQuota: 3_000 };
    const flags = buildResendFlags(snapshot({ limits, sentThisMonth: 2_400 }));
    expect(flags.some((f) => f.title === "Monthly quota almost reached")).toBe(true);
  });

  it("errors when the quota is exhausted and mentions overage pricing on paid plans", () => {
    const limits = { ...getResendLimitsForPlan(), monthlyQuota: 3_000, overagePerThousandUsd: 0.5 };
    const flags = buildResendFlags(snapshot({ limits, sentThisMonth: 3_000 }));
    const flag = flags.find((f) => f.title === "Monthly quota reached");
    expect(flag?.level).toBe("error");
    expect(flag?.message).toContain("Overage");
  });
});

describe("buildResendFlags — health thresholds", () => {
  it("errors when bounce rate is at or above 4%", () => {
    const flags = buildResendFlags(snapshot({ bounceRatePct: 4.2, bounced: 126, sentThisMonth: 3000 }));
    expect(flags.some((f) => f.level === "error" && f.title.includes("Bounce rate"))).toBe(true);
  });

  it("warns when bounce rate is half the pause threshold", () => {
    const flags = buildResendFlags(snapshot({ bounceRatePct: 2.1 }));
    expect(flags.some((f) => f.level === "warning" && f.title.includes("Bounce rate"))).toBe(true);
  });

  it("errors when the complaint rate is above 0.08%", () => {
    const flags = buildResendFlags(snapshot({ complaintRatePct: 0.1 }));
    expect(flags.some((f) => f.level === "error" && f.title.includes("Spam complaint"))).toBe(true);
  });
});

describe("buildResendFlags — domains", () => {
  it("warns when the domain limit is reached", () => {
    const limits = { ...getResendLimitsForPlan(), domainsLimit: 3 };
    const flags = buildResendFlags(snapshot({ limits, domains: { total: 3, verified: 3 } }));
    expect(flags.some((f) => f.title === "Domain limit reached")).toBe(true);
  });
});

describe("estimateResendMonthlyCost", () => {
  it("is zero on the free plan within quota", () => {
    const limits = getResendPlanLimits().free;
    const cost = estimateResendMonthlyCost(snapshot({ plan: "free", limits, sentThisMonth: 1000 }));
    expect(cost).toBe(0);
  });

  it("adds overage on paid plans beyond the monthly quota", () => {
    const limits = getResendPlanLimits().pro;
    const cost = estimateResendMonthlyCost(snapshot({ plan: "pro", limits, sentThisMonth: 51_000 }));
    expect(cost).toBe(20.5);
  });
});

describe("plan resolution", () => {
  it("defaults to pro", () => {
    expect(getResendPlan()).toBe("pro");
  });

  it("honors RESEND_PLAN and RESEND_PLAN_LIMITS_JSON", () => {
    process.env.RESEND_PLAN = "free";
    process.env.RESEND_PLAN_LIMITS_JSON = JSON.stringify({ free: { monthlyQuota: 5_000 } });
    expect(getResendPlan()).toBe("free");
    expect(getResendLimitsForPlan().monthlyQuota).toBe(5_000);
  });
});
