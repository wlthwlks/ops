/**
 * Shared service-access eligibility helper.
 *
 * LEGACY (default, SERVICE_ACCESS_POLICY_V2_ENABLED off/missing):
 *   Membership is "Active" AND Payment is "Paid", OR
 *   "Service access until" exists and is on or after the reference instant.
 *
 * V2 (SERVICE_ACCESS_POLICY_V2_ENABLED=true):
 *   Valid "Service access until" >= reference instant only.
 *   Active+Paid alone does NOT grant indefinite access.
 *
 * Full DateTime comparison (not calendar-date only).
 */

export type ServiceAccessPolicy = "legacy" | "v2";

export type ServiceAccessReason =
  | "paid_through_current"
  | "paid_through_expired"
  | "missing_paid_through"
  | "invalid_paid_through"
  | "legacy_active_paid_fallback";

export type ServiceAccessEvaluation = {
  accessible: boolean;
  policy: ServiceAccessPolicy;
  reason: ServiceAccessReason;
};

/** Parse env flag; default OFF when missing/empty. */
export function isServiceAccessPolicyV2Enabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = (env.SERVICE_ACCESS_POLICY_V2_ENABLED || "").trim().toLowerCase();
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw);
}

export function getActiveServiceAccessPolicy(
  env: NodeJS.ProcessEnv = process.env
): ServiceAccessPolicy {
  return isServiceAccessPolicyV2Enabled(env) ? "v2" : "legacy";
}

function parseServiceAccessUntil(
  serviceAccessUntil: string | null | undefined
): { ok: true; date: Date } | { ok: false; kind: "missing" | "invalid" } {
  if (serviceAccessUntil == null) return { ok: false, kind: "missing" };
  const raw = String(serviceAccessUntil).trim();
  if (!raw) return { ok: false, kind: "missing" };
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return { ok: false, kind: "invalid" };
  return { ok: true, date };
}

/**
 * Evaluate entitlement under an explicit policy.
 * referenceDate is compared as a full instant (UTC-aware via Date).
 */
export function evaluateServiceAccess(
  membership: string,
  payment: string,
  serviceAccessUntil: string | null | undefined,
  referenceDate: Date,
  policy: ServiceAccessPolicy = getActiveServiceAccessPolicy()
): ServiceAccessEvaluation {
  const parsed = parseServiceAccessUntil(serviceAccessUntil);

  if (policy === "v2") {
    if (!parsed.ok) {
      return {
        accessible: false,
        policy: "v2",
        reason:
          parsed.kind === "invalid" ? "invalid_paid_through" : "missing_paid_through",
      };
    }
    if (parsed.date.getTime() >= referenceDate.getTime()) {
      return { accessible: true, policy: "v2", reason: "paid_through_current" };
    }
    return { accessible: false, policy: "v2", reason: "paid_through_expired" };
  }

  // LEGACY
  if (membership === "Active" && payment === "Paid") {
    return {
      accessible: true,
      policy: "legacy",
      reason: "legacy_active_paid_fallback",
    };
  }
  if (!parsed.ok) {
    return {
      accessible: false,
      policy: "legacy",
      reason:
        parsed.kind === "invalid" ? "invalid_paid_through" : "missing_paid_through",
    };
  }
  if (parsed.date.getTime() >= referenceDate.getTime()) {
    return { accessible: true, policy: "legacy", reason: "paid_through_current" };
  }
  return { accessible: false, policy: "legacy", reason: "paid_through_expired" };
}

/**
 * Simple shared consumer API. Uses active env policy unless overridden.
 */
export function hasServiceAccess(
  membership: string,
  payment: string,
  serviceAccessUntil: string | null,
  referenceDate: Date,
  policy?: ServiceAccessPolicy
): boolean {
  return evaluateServiceAccess(
    membership,
    payment,
    serviceAccessUntil,
    referenceDate,
    policy ?? getActiveServiceAccessPolicy()
  ).accessible;
}

export type ServiceAccessResult =
  | { accessible: true; policy: ServiceAccessPolicy; reason: ServiceAccessReason }
  | {
      accessible: false;
      policy: ServiceAccessPolicy;
      reason: ServiceAccessReason;
      message: string;
    };

export function checkServiceAccess(
  membership: string,
  payment: string,
  serviceAccessUntil: string | null,
  referenceDate: Date,
  policy?: ServiceAccessPolicy
): ServiceAccessResult {
  const ev = evaluateServiceAccess(
    membership,
    payment,
    serviceAccessUntil,
    referenceDate,
    policy ?? getActiveServiceAccessPolicy()
  );
  if (ev.accessible) {
    return { accessible: true, policy: ev.policy, reason: ev.reason };
  }
  const message =
    ev.reason === "paid_through_expired"
      ? "Service access until has expired"
      : ev.reason === "invalid_paid_through"
        ? "Service access until is invalid"
        : ev.reason === "missing_paid_through"
          ? "Not paid or inactive, and no service access extension"
          : "No verified service access";
  return {
    accessible: false,
    policy: ev.policy,
    reason: ev.reason,
    message,
  };
}

/** Airtable-only KPIs without Stripe. */
export function summarizeAirtableEntitlementSnapshot(
  rows: Array<{
    membership: string;
    payment: string;
    serviceAccessUntil: string | null;
  }>,
  referenceDate: Date
): {
  total: number;
  legacyAccess: number;
  v2Access: number;
  legacyActivePaidBypass: number;
  activePaidExpiredAccess: number;
  activePaidBlankAccess: number;
  cancelledWithFutureAccess: number;
  futureAccessTotal: number;
} {
  let legacyAccess = 0;
  let v2Access = 0;
  let legacyActivePaidBypass = 0;
  let activePaidExpiredAccess = 0;
  let activePaidBlankAccess = 0;
  let cancelledWithFutureAccess = 0;
  let futureAccessTotal = 0;

  for (const r of rows) {
    const leg = evaluateServiceAccess(
      r.membership,
      r.payment,
      r.serviceAccessUntil,
      referenceDate,
      "legacy"
    );
    const v2 = evaluateServiceAccess(
      r.membership,
      r.payment,
      r.serviceAccessUntil,
      referenceDate,
      "v2"
    );
    if (leg.accessible) legacyAccess++;
    if (v2.accessible) v2Access++;

    const activePaid = r.membership === "Active" && r.payment === "Paid";
    const parsed = parseServiceAccessUntil(r.serviceAccessUntil);
    if (activePaid && leg.reason === "legacy_active_paid_fallback") {
      legacyActivePaidBypass++;
    }
    if (activePaid && parsed.ok && parsed.date.getTime() < referenceDate.getTime()) {
      activePaidExpiredAccess++;
    }
    if (activePaid && !parsed.ok) {
      activePaidBlankAccess++;
    }
    if (
      parsed.ok &&
      parsed.date.getTime() >= referenceDate.getTime()
    ) {
      futureAccessTotal++;
      if (r.membership !== "Active" || r.payment !== "Paid") {
        cancelledWithFutureAccess++;
      }
    }
  }

  return {
    total: rows.length,
    legacyAccess,
    v2Access,
    legacyActivePaidBypass,
    activePaidExpiredAccess,
    activePaidBlankAccess,
    cancelledWithFutureAccess,
    futureAccessTotal,
  };
}
