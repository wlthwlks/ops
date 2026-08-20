/**
 * Classify membership/billing state for Update Details and billing APIs.
 * Stripe subscription fields are preferred when present; Airtable is fallback.
 */

export type MembershipUiState =
  | "active"
  | "cancellation_scheduled"
  | "payment_problem"
  | "paused"
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
  cancellationEffectiveAt?: string | null;
  /** Stripe pause-collection resume date (blank = paused indefinitely). */
  billingPauseResumesAt?: string | null;
  now?: Date;
};

/** Accept checkbox/boolean/string flags from Airtable or Stripe-derived payloads. */
export function parseTruthyFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  const s = String(value).trim().toLowerCase();
  if (!s) return false;
  return s === "true" || s === "1" || s === "yes" || s === "y" || s === "checked";
}

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
 * Best date to show members for "access until / ends on".
 * Prefer paid-through, then Stripe period end, then cancellation effective.
 */
export function resolveAccessUntilLabel(input: {
  serviceAccessUntil?: string | null;
  currentPeriodEnd?: string | null;
  cancellationEffectiveAt?: string | null;
}): string {
  const candidates = [
    input.serviceAccessUntil,
    input.currentPeriodEnd,
    input.cancellationEffectiveAt,
  ];
  for (const c of candidates) {
    const label = formatMembershipAccessDate(c);
    if (label) return label;
  }
  return "";
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
  const cancelAtPeriodEnd = Boolean(input.cancelAtPeriodEnd);

  // Access from any known paid-through signal
  const accessRaw =
    input.serviceAccessUntil ||
    input.currentPeriodEnd ||
    input.cancellationEffectiveAt ||
    null;
  const accessOk = hasRemainingServiceAccess(accessRaw, now);

  if (
    subStatus === "past_due" ||
    subStatus === "unpaid" ||
    subStatus === "incomplete" ||
    pay === "failed" ||
    pay === "unpaid"
  ) {
    return "payment_problem";
  }

  // Stripe pause collection (indefinite or scheduled) — distinct from cancel.
  if (subStatus === "paused") {
    return "paused";
  }

  // Scheduled cancel is the primary product state we want to surface.
  // Check BEFORE treating bare active as normal active.
  if (cancelAtPeriodEnd) {
    // Still entitled through period end (or Stripe still active/trialing).
    if (
      accessOk ||
      subStatus === "active" ||
      subStatus === "trialing" ||
      mem === "active" ||
      !subStatus
    ) {
      return "cancellation_scheduled";
    }
    return "expired";
  }

  if (subStatus === "incomplete_expired") {
    return accessOk ? "cancellation_scheduled" : "expired";
  }

  if (subStatus === "active" || subStatus === "trialing") {
    return "active";
  }

  if (pay === "paid" && mem === "active") {
    return "active";
  }

  if (mem === "pending payment" || pay === "pending") {
    return "incomplete_onboarding";
  }

  // Fully canceled in Stripe/Airtable but still inside paid-through window
  if (
    subStatus === "canceled" ||
    mem === "cancelled" ||
    mem === "canceled"
  ) {
    return accessOk ? "cancellation_scheduled" : "expired";
  }

  if (!accessOk && (mem !== "active" || pay !== "paid")) {
    return "expired";
  }

  if (mem && mem !== "active") {
    return accessOk ? "cancellation_scheduled" : "expired";
  }
  if (pay && pay !== "paid") return "payment_problem";

  return "unknown";
}

export function formatMembershipAccessDate(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = String(raw).trim();
  if (!s) return "";
  return s.slice(0, 10);
}
