/**
 * Classify membership/billing state for Update Details and billing APIs.
 * Stripe subscription fields are preferred when present; Airtable is fallback.
 */

export type MembershipUiState =
  | "active"
  | "cancellation_scheduled"
  | "payment_problem"
  | "expired"
  | "incomplete_onboarding"
  | "unknown";

export type MembershipStateInput = {
  /** Airtable Membership */
  membership?: string | null;
  /** Airtable Payment */
  payment?: string | null;
  serviceAccessUntil?: string | null;
  cancelAtPeriodEnd?: boolean | null;
  /** Live Stripe subscription status when known */
  stripeSubscriptionStatus?: string | null;
  hasPaymentMethod?: boolean | null;
  /** ISO or date string */
  currentPeriodEnd?: string | null;
  now?: Date;
};

function parseAccessUntil(raw: string | null | undefined): Date | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s.length <= 10 ? `${s}T23:59:59.999Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function hasRemainingServiceAccess(
  serviceAccessUntil: string | null | undefined,
  now: Date = new Date()
): boolean {
  const until = parseAccessUntil(serviceAccessUntil);
  if (!until) return false;
  return until.getTime() >= now.getTime();
}

/**
 * Distinguish voluntary end-of-period cancel from payment problems and true expiry.
 */
export function classifyMembershipUiState(
  input: MembershipStateInput
): MembershipUiState {
  const now = input.now ?? new Date();
  const subStatus = (input.stripeSubscriptionStatus || "").toLowerCase().trim();
  const mem = (input.membership || "").toLowerCase().trim();
  const pay = (input.payment || "").toLowerCase().trim();
  const accessOk = hasRemainingServiceAccess(input.serviceAccessUntil, now);

  if (
    subStatus === "past_due" ||
    subStatus === "unpaid" ||
    subStatus === "incomplete" ||
    pay === "failed" ||
    pay === "unpaid"
  ) {
    return "payment_problem";
  }

  if (subStatus === "incomplete_expired") {
    return accessOk ? "cancellation_scheduled" : "expired";
  }

  if (
    (subStatus === "active" || subStatus === "trialing") &&
    input.cancelAtPeriodEnd
  ) {
    return "cancellation_scheduled";
  }

  if (
    (subStatus === "active" || subStatus === "trialing") &&
    !input.cancelAtPeriodEnd
  ) {
    return "active";
  }

  if (input.cancelAtPeriodEnd && (mem === "active" || accessOk)) {
    return "cancellation_scheduled";
  }

  if (pay === "paid" && mem === "active" && !input.cancelAtPeriodEnd) {
    return "active";
  }

  if (mem === "pending payment" || pay === "pending") {
    return "incomplete_onboarding";
  }

  if (subStatus === "canceled" || mem === "cancelled" || mem === "canceled") {
    return accessOk ? "cancellation_scheduled" : "expired";
  }

  if (!accessOk && (mem !== "active" || pay !== "paid")) {
    return "expired";
  }

  if (mem && mem !== "active") return "expired";
  if (pay && pay !== "paid") return "payment_problem";

  return "unknown";
}

export function formatMembershipAccessDate(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = String(raw).trim();
  if (!s) return "";
  return s.slice(0, 10);
}
