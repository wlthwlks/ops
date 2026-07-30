import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { scanMemberHealth } from "@/lib/ops/member-health";
import { severityRank } from "@/lib/ops/member-issue-classifier";
import type { MemberHealthRow, MemberIssue } from "@/lib/ops/member-health-types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    await requireOpsViewer();
    const url = new URL(request.url);
    const severity = url.searchParams.get("severity") || undefined;
    const category = url.searchParams.get("category") || "all";
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const actionableOnly = url.searchParams.get("actionable") !== "0";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(
      200,
      Math.max(10, parseInt(url.searchParams.get("pageSize") || "50", 10))
    );

    const scan = await scanMemberHealth({
      includeSlack: true,
      includeChannelMembership: true,
    });

    type IssueRow = {
      airtableRecordId: string | null;
      name: string;
      email: string;
      city: string;
      issue: MemberIssue;
      detectedAt: string;
      /** Full member health row for drawer — no second scan on click */
      member: MemberHealthRow;
    };

    const rows: IssueRow[] = [];
    for (const m of [...scan.members, ...scan.orphanStripeCustomers]) {
      for (const issue of m.issues) {
        if (actionableOnly && issue.severity === "info") continue;
        if (severity && issue.severity !== severity) continue;
        if (category === "billing" && !issue.systems.includes("stripe")) continue;
        if (category === "slack" && !issue.systems.includes("slack")) continue;
        if (
          category === "channel" &&
          ![
            "MEMBER_NOT_IN_CITY_CHANNEL",
            "MEMBER_NOT_IN_ALL_MEMBERS_CHANNEL",
            "CITY_CHANNEL_NOT_CONFIGURED",
            "EXPIRED_MEMBER_STILL_IN_SLACK_WORKSPACE",
          ].includes(issue.code)
        ) {
          continue;
        }
        if (
          category === "identity" &&
          ![
            "DUPLICATE_AIRTABLE_EMAIL",
            "SLACK_IDENTITY_MATCH_AMBIGUOUS",
            "PRIMARY_EMAIL_MISSING",
            "PRIMARY_EMAIL_INVALID",
          ].includes(issue.code)
        ) {
          continue;
        }
        if (
          category === "service_access" &&
          ![
            "INVALID_SERVICE_ACCESS_DATE",
            "SERVICE_ACCESS_DATE_BEHIND_STRIPE",
            "SERVICE_ACCESS_LATER_THAN_STRIPE",
            "CANCELLED_WITH_VALID_SERVICE_ACCESS",
            "EXPIRED_MEMBER_STILL_IN_SLACK_WORKSPACE",
          ].includes(issue.code)
        ) {
          continue;
        }
        if (category === "critical" && issue.severity !== "critical") continue;
        if (q) {
          const hay =
            `${m.name} ${m.primaryEmail} ${m.city} ${issue.code} ${issue.label}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }
        rows.push({
          airtableRecordId: m.airtableRecordId,
          name: m.name,
          email: m.primaryEmail,
          city: m.city,
          issue,
          detectedAt: scan.summary.scannedAt,
          member: m,
        });
      }
    }

    rows.sort(
      (a, b) =>
        severityRank(a.issue.severity) - severityRank(b.issue.severity) ||
        a.name.localeCompare(b.name)
    );

    const total = rows.length;
    const start = (page - 1) * pageSize;
    return jsonOk({
      summary: scan.summary,
      total,
      page,
      pageSize,
      issues: rows.slice(start, start + pageSize),
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
