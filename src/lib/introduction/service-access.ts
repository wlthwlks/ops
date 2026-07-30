/**
 * Shared service-access eligibility helper.
 *
 * A member has access when either:
 *   1. Membership is "Active" AND Payment is "Paid", OR
 *   2. "Service access until" exists and is on or after the reference date.
 *
 * A future "Service access until" date overrides a cancelled/inactive state
 * until the paid-through date passes.
 */
export function hasServiceAccess(
  membership: string,
  payment: string,
  serviceAccessUntil: string | null,
  referenceDate: Date
): boolean {
  if (membership === "Active" && payment === "Paid") return true;
  if (!serviceAccessUntil) return false;
  const untilDate = new Date(serviceAccessUntil);
  return untilDate >= referenceDate;
}

export type ServiceAccessResult =
  | { accessible: true }
  | { accessible: false; reason: string };

export function checkServiceAccess(
  membership: string,
  payment: string,
  serviceAccessUntil: string | null,
  referenceDate: Date
): ServiceAccessResult {
  if (membership === "Active" && payment === "Paid") return { accessible: true };
  if (serviceAccessUntil) {
    const untilDate = new Date(serviceAccessUntil);
    if (untilDate >= referenceDate) return { accessible: true };
    return { accessible: false, reason: "Service access until has expired" };
  }
  return { accessible: false, reason: "Not paid or inactive, and no service access extension" };
}
