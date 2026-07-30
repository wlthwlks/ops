export type IntroductionsMode = "read_only" | "live";

export class IntroductionsReadOnlyError extends Error {
  readonly code = "INTRODUCTIONS_READ_ONLY";
  readonly mode: IntroductionsMode = "read_only";
  readonly action: string;

  constructor(action: string) {
    super(
      `Introductions are in read-only mode. No messages or database writes are allowed. (action: ${action})`
    );
    this.name = "IntroductionsReadOnlyError";
    this.action = action;
  }
}

export class IntroductionsConfigError extends Error {
  readonly code = "INTRODUCTIONS_CONFIG_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "IntroductionsConfigError";
  }
}

/**
 * Server-only runtime mode for introductions.
 * Missing or empty INTRODUCTIONS_MODE → read_only (safe default).
 * Unsupported values throw — do not write or deliver.
 */
export function getIntroductionsMode(): IntroductionsMode {
  const raw = (process.env.INTRODUCTIONS_MODE || "").trim().toLowerCase();
  if (!raw || raw === "read_only") return "read_only";
  if (raw === "live") return "live";
  throw new IntroductionsConfigError(
    `Unsupported INTRODUCTIONS_MODE="${process.env.INTRODUCTIONS_MODE}". Use "read_only" or "live".`
  );
}

export function isIntroductionsLive(): boolean {
  return getIntroductionsMode() === "live";
}

export function assertIntroductionsLive(action: string): void {
  if (!isIntroductionsLive()) {
    throw new IntroductionsReadOnlyError(action);
  }
}

export function introductionsModePayload() {
  const mode = getIntroductionsMode();
  const live = mode === "live";
  return {
    mode,
    readOnly: !live,
    live,
    sendEnabled: live,
    writesEnabled: live,
    slackDeliveryEnabled: live,
    airtableWritesEnabled: live,
    postgresWritesEnabled: live,
    pineconeWritesEnabled: live,
    automationWillSend: live,
  };
}
