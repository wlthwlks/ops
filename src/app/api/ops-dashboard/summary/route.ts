import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { scanMemberHealth } from "@/lib/ops/member-health";
import { db } from "@/db";
import { opRuns } from "@/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  try {
    await requireOpsViewer();
    const scan = await scanMemberHealth({
      includeSlack: true,
      includeChannelMembership: false,
    });

    let failedOps24h = 0;
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const rows = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(opRuns)
        .where(and(eq(opRuns.status, "failed"), gte(opRuns.startedAt, since)));
      failedOps24h = Number(rows[0]?.c ?? 0);
    } catch {
      // Postgres optional for summary
    }

    const criticalRows = scan.members
      .filter((m) => m.highestSeverity === "critical")
      .slice(0, 25)
      .map((m) => ({
        airtableRecordId: m.airtableRecordId,
        name: m.name,
        email: m.primaryEmail,
        city: m.city,
        issues: m.issues.filter((i) => i.severity === "critical").map((i) => i.code),
        recommendedNextAction: m.recommendedNextAction,
      }));

    return jsonOk({
      summary: {
        ...scan.summary,
        failedOperations24h: failedOps24h,
      },
      criticalIssues: criticalRows,
      funnel: {
        serviceEligible: scan.summary.withServiceAccess,
        inAirtable: scan.summary.totalAirtableMembers,
        stripeLinked: scan.members.filter(
          (m) => m.hasCurrentServiceAccess && m.stripeCustomerId.startsWith("cus_")
        ).length,
        slackResolved: scan.members.filter(
          (m) =>
            m.hasCurrentServiceAccess &&
            (m.slackIdentityState === "matched_primary_email" ||
              m.slackIdentityState === "matched_slack_email")
        ).length,
        fullyConnected: scan.summary.fullyConnected,
      },
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
