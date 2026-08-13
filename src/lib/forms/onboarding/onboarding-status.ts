/**
 * Shared helpers for interpreting the Airtable "Onboarding status" field.
 *
 * The canonical completed value is "COMPLETE". A blank value marks a legacy /
 * pre-widget member (established, not mid-signup) — see the status API's own
 * note in `src/app/api/onboarding/status/route.ts`.
 */

const COMPLETE_VALUES = new Set(["COMPLETE", "COMPLETED"]);

/**
 * True when the member is established and must NOT be pushed back into the
 * signup flow: onboarding status is blank (legacy) or already completed.
 *
 * Reactivation / post-checkout billing sync use this to avoid overwriting an
 * established member's "Onboarding status" with "PAYMENT_CONFIRMED", which
 * would otherwise re-enter them into the progressive signup form.
 */
export function isEstablishedOnboarding(
  status: string | null | undefined
): boolean {
  const s = (status ?? "").trim().toUpperCase();
  if (!s) return true;
  return COMPLETE_VALUES.has(s);
}

/**
 * True when the member is actively mid-signup (a non-empty, non-completed
 * stage) and SHOULD have their onboarding status advanced by billing events.
 */
export function isInProgressOnboarding(
  status: string | null | undefined
): boolean {
  return !isEstablishedOnboarding(status);
}
