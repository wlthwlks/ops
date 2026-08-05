import { NextResponse } from "next/server";
import { optionsCors, withCors } from "@/lib/forms/cors";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import {
  findMemberByMemberstackId,
  recordToProfileDtoResolved,
} from "@/lib/forms/airtable/members-sync";
import { FormsError } from "@/lib/forms/errors";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function GET(request: Request) {
  try {
    const member = await verifyMemberstackToken(
      extractMemberstackToken(request),
      request
    );
    const rows = await findMemberByMemberstackId(member.id);
    if (rows.length === 0) {
      return withCors(
        NextResponse.json({
          success: true,
          exists: false,
          memberstackId: member.id,
          onboardingStatus: null,
          resumeStage: "ACCOUNT",
        }),
        request
      );
    }
    if (rows.length > 1) {
      throw new FormsError("AIRTABLE_DUPLICATE_MEMBER", "Duplicate Memberstack ID");
    }
    const profile = await recordToProfileDtoResolved(rows[0]);
    // Blank status = legacy / pre-widget member — not mid-signup.
    const status = (profile.onboardingStatus || "").trim();
    // Billing truth: Airtable Payment + Membership only (not onboarding stage alone).
    const paymentConfirmed =
      profile.payment.trim().toLowerCase() === "paid" &&
      profile.membership.trim().toLowerCase() === "active";
    const resumeStage = status
      ? mapResumeStage(status, paymentConfirmed)
      : "COMPLETE";
    const onboardingIncomplete = isExplicitInProgressOnboarding(status);
    return withCors(
      NextResponse.json({
        success: true,
        exists: true,
        memberstackId: member.id,
        airtableRecordId: profile.airtableRecordId,
        onboardingStatus: status || null,
        resumeStage,
        paymentConfirmed,
        /** True only for mid new-widget signup — never for cancelled legacy members. */
        onboardingIncomplete,
        profile,
      }),
      request
    );
  } catch (err) {
    if (err instanceof FormsError) {
      return withCors(
        NextResponse.json(
          { success: false, code: err.code, message: err.message },
          { status: err.status }
        ),
        request
      );
    }
    return withCors(
      NextResponse.json(
        {
          success: false,
          code: "INTERNAL_UNEXPECTED_ERROR",
          message: err instanceof Error ? err.message : "Status failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}

const IN_PROGRESS_ONBOARDING = new Set([
  "ACCOUNT_CREATED",
  "ACCOUNT",
  "LOCATION",
  "BUSINESS",
  "PAYMENT_PENDING",
  "PAYMENT_CONFIRMED",
  "GOAL",
  "HELP_WANTED",
  "EXPERTISE",
  "CONNECTION",
]);

/**
 * New signup widget only. Blank / COMPLETE / unknown = not mid-signup.
 * Cancelled billing must never force this true for established members.
 */
export function isExplicitInProgressOnboarding(status: string | null | undefined): boolean {
  const s = (status || "").trim().toUpperCase();
  if (!s || s === "COMPLETE") return false;
  return IN_PROGRESS_ONBOARDING.has(s);
}

/**
 * Map last completed onboarding status → next widget stage to show.
 * Status columns store the step just finished; resume is the following step.
 */
export function mapResumeStage(status: string, paymentConfirmed: boolean): string {
  const s = (status || "").trim().toUpperCase();
  if (s === "COMPLETE") return "COMPLETE";

  // Paid members never land back on Payment
  if (
    paymentConfirmed &&
    (s === "BUSINESS" ||
      s === "PAYMENT_PENDING" ||
      s === "PAYMENT_CONFIRMED" ||
      s === "ACCOUNT_CREATED" ||
      s === "ACCOUNT" ||
      s === "LOCATION")
  ) {
    // Still need location/business data if never saved — only skip payment
    if (s === "ACCOUNT_CREATED" || s === "ACCOUNT") return "LOCATION";
    if (s === "LOCATION") return "BUSINESS";
    return "GOAL";
  }

  if (s === "ACCOUNT_CREATED" || s === "ACCOUNT" || s === "") return "LOCATION";
  if (s === "LOCATION") return "BUSINESS";
  if (s === "BUSINESS") return "PAYMENT_PENDING";
  if (s === "PAYMENT_PENDING") return "PAYMENT_PENDING";
  if (s === "PAYMENT_CONFIRMED") return "GOAL";
  if (s === "GOAL") return "HELP_WANTED";
  if (s === "HELP_WANTED") return "EXPERTISE";
  if (s === "EXPERTISE") return "CONNECTION";
  if (s === "CONNECTION") return "COMPLETE";
  return "LOCATION";
}

void MEMBER_FIELDS;
