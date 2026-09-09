import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import {
  listRecentResendEmails,
  type ResendEmailSummary,
} from "@/lib/integrations/resend-emails";
import { listLiveDeliveryStates } from "@/lib/introduction/resend-delivery-status";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RESEND_MAX_PAGES = 30;
const RESEND_CACHE_TTL_MS = 60_000;

let resendCache: { at: number; emails: ResendEmailSummary[] } | null = null;

async function getResendEmails(): Promise<ResendEmailSummary[]> {
  const now = Date.now();
  if (resendCache && now - resendCache.at < RESEND_CACHE_TTL_MS) {
    return resendCache.emails;
  }
  // A dedicated read key wins (the send-only key is restricted from listing
  // emails); fall back to the main key for convenience.
  const apiKey =
    process.env.RESEND_READ_API_KEY?.trim() || process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Neither RESEND_READ_API_KEY nor RESEND_API_KEY is configured"
    );
  }
  const { emails } = await listRecentResendEmails({
    apiKey,
    maxPages: RESEND_MAX_PAGES,
  });
  resendCache = { at: now, emails };
  return emails;
}

/**
 * Live delivery states for the "Delivery States" tab: the team's sent emails
 * from the Resend API (paginated, cached 60s) merged with the introduction
 * delivery ledger on the stored resend message id. Filters: statuses
 * (comma-separated live statuses), city (city code) and person (recipient
 * email search).
 */
export async function GET(request: NextRequest) {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { searchParams } = new URL(request.url);
    const statuses = (searchParams.get("statuses") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const cityCode = searchParams.get("city")?.trim() || undefined;
    const person = searchParams.get("person")?.trim() || undefined;

    const emails = await getResendEmails();
    const rows = await listLiveDeliveryStates(db, emails, {
      statuses,
      cityCode,
      person,
    });
    return jsonOk({ rows } as unknown as Record<string, unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonError("RESEND_FETCH_FAILED", message, 502);
  }
}
