/**
 * Resend "List Sent Emails" API client — paginated read-only listing of the
 * team's sent emails with their latest delivery event (`last_event`).
 * Used by the Delivery States tab while Resend webhooks are not wired up.
 */

export const RESEND_API_BASE = "https://api.resend.com";
export const RESEND_EMAILS_PAGE_SIZE = 100;
export const RESEND_EMAILS_PAGE_GAP_MS = 150;

export interface ResendEmailSummary {
  /** Resend email id — matches introduction_deliveries.resend_message_id. */
  id: string;
  messageId: string | null;
  to: string[];
  from: string | null;
  createdAt: string | null;
  subject: string | null;
  lastEvent: string | null;
}

export interface ResendEmailsPage {
  items: ResendEmailSummary[];
  hasMore: boolean;
  nextAfter: string | null;
}

interface ResendListRow {
  id?: unknown;
  message_id?: unknown;
  to?: unknown;
  from?: unknown;
  created_at?: unknown;
  subject?: unknown;
  last_event?: unknown;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" && value.trim() !== "") return [value];
  return [];
}

function parseRow(row: unknown): ResendEmailSummary {
  const r = (row ?? {}) as ResendListRow;
  return {
    id: typeof r.id === "string" ? r.id : "",
    messageId: typeof r.message_id === "string" ? r.message_id : null,
    to: stringList(r.to),
    from: typeof r.from === "string" ? r.from : null,
    createdAt: typeof r.created_at === "string" ? r.created_at : null,
    subject: typeof r.subject === "string" ? r.subject : null,
    lastEvent: typeof r.last_event === "string" ? r.last_event : null,
  };
}

/** Fetch one page of the Resend emails list. */
export async function fetchResendEmailsPage(input: {
  apiKey: string;
  limit?: number;
  after?: string;
}): Promise<ResendEmailsPage> {
  const limit = input.limit ?? RESEND_EMAILS_PAGE_SIZE;
  const params = new URLSearchParams({ limit: String(limit) });
  if (input.after) params.set("after", input.after);

  const res = await fetch(`${RESEND_API_BASE}/emails?${params.toString()}`, {
    headers: { Authorization: `Bearer ${input.apiKey}` },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend emails API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    has_more?: unknown;
    data?: unknown;
  };
  const items = Array.isArray(data.data) ? data.data.map(parseRow) : [];
  const last = items[items.length - 1];
  return {
    items,
    hasMore: data.has_more === true && items.length > 0,
    nextAfter: last && last.id ? last.id : null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Paginate through the team's sent emails (newest first) up to maxPages.
 * A short gap between pages keeps the request rate well under Resend's
 * default 10 req/s limit.
 */
export async function listRecentResendEmails(input: {
  apiKey: string;
  maxPages?: number;
  onPage?: (page: number, emails: number) => void;
}): Promise<{ emails: ResendEmailSummary[]; pagesFetched: number }> {
  const maxPages = Math.min(Math.max(input.maxPages ?? 30, 1), 100);
  const emails: ResendEmailSummary[] = [];
  let after: string | undefined;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    const page = await fetchResendEmailsPage({
      apiKey: input.apiKey,
      limit: RESEND_EMAILS_PAGE_SIZE,
      ...(after ? { after } : {}),
    });
    pagesFetched += 1;
    emails.push(...page.items);
    input.onPage?.(pagesFetched, page.items.length);

    if (!page.hasMore || !page.nextAfter) break;
    after = page.nextAfter;
    if (pagesFetched < maxPages) await sleep(RESEND_EMAILS_PAGE_GAP_MS);
  }

  return { emails, pagesFetched };
}
