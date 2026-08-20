/**
 * Shared "Recurring intro status" pause state — single source of truth for
 * both introduction engines (unified and legacy).
 *
 * Pause semantics (fail closed):
 *   - status "Paused" blocks intros until "Recurring pause until" (inclusive)
 *   - "Paused" with a missing/unparsable date blocks indefinitely
 *   - "Excluded" blocks permanently and is never touched by pause helpers
 *   - any other status (including "Active" / blank) is not a pause
 */

export type IntroPauseState = "active" | "paused" | "excluded" | "unknown";

export interface ResolvedIntroPause {
  state: IntroPauseState;
  /** True when the member must NOT receive introductions right now. */
  isPaused: boolean;
  /** Parsed pause-until date, or null when blank/unparsable. */
  pauseUntilDate: Date | null;
  /** Paused with a blank/unparsable pause-until date (blocks forever). */
  missingDate: boolean;
}

export function parsePauseUntil(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const date = new Date(String(value).trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

export function resolveIntroPauseState(
  recurringIntroStatus: string | null | undefined,
  recurringPauseUntil: string | null | undefined,
  now: Date = new Date()
): ResolvedIntroPause {
  const status = (recurringIntroStatus ?? "").trim().toLowerCase();
  if (status === "excluded") {
    return {
      state: "excluded",
      isPaused: false,
      pauseUntilDate: null,
      missingDate: false,
    };
  }
  if (status === "paused") {
    const pauseUntilDate = parsePauseUntil(recurringPauseUntil);
    const missingDate = pauseUntilDate == null;
    const isPaused = missingDate || now.getTime() < pauseUntilDate!.getTime();
    return { state: "paused", isPaused, pauseUntilDate, missingDate };
  }
  if (status === "active" || status === "") {
    return {
      state: "active",
      isPaused: false,
      pauseUntilDate: null,
      missingDate: false,
    };
  }
  return {
    state: "unknown",
    isPaused: false,
    pauseUntilDate: null,
    missingDate: false,
  };
}

/**
 * Airtable patch that clears an active intro pause. Only fires when the
 * member's current status is exactly "Paused" — never touches "Excluded" or
 * any other status so membership-eligibility semantics stay intact.
 */
export function introPauseClearPatch(fields: {
  recurringIntroStatus?: string | null;
}): Record<string, unknown> {
  const status = (fields.recurringIntroStatus ?? "").trim();
  if (status !== "Paused") return {};
  return {
    "Recurring intro status": "Active",
    "Recurring pause until": "",
  };
}
