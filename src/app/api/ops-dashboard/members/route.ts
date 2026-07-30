import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import {
  buildMemberFilterOptions,
  filterMembers,
  scanMemberHealth,
  type MemberFilterQuery,
} from "@/lib/ops/member-health";
import { severityRank } from "@/lib/ops/member-issue-classifier";

export const runtime = "nodejs";
export const maxDuration = 120;

function flag(url: URL, key: string): boolean {
  return url.searchParams.get(key) === "1";
}

export async function GET(request: Request) {
  try {
    await requireOpsViewer();
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const rawSize = parseInt(url.searchParams.get("pageSize") || "100", 10);
    const pageSize = [50, 100, 200].includes(rawSize) ? rawSize : 100;
    const includeChannels =
      url.searchParams.get("channels") === "1" ||
      flag(url, "missingCityChannel") ||
      flag(url, "missingAllMembers") ||
      flag(url, "expiredStillInSlack");

    const query: MemberFilterQuery = {
      q: url.searchParams.get("q") || undefined,
      city: url.searchParams.get("city") || undefined,
      cities: url.searchParams.get("cities")
        ? url.searchParams.get("cities")!.split("|").filter(Boolean)
        : undefined,
      membership: url.searchParams.get("membership") || undefined,
      payment: url.searchParams.get("payment") || undefined,
      severity: url.searchParams.get("severity") || undefined,
      issueCode: url.searchParams.get("issueCode") || undefined,
      serviceAccess: url.searchParams.get("serviceAccess") || undefined,
      needsAction: flag(url, "needsAction"),
      missingSlack: flag(url, "missingSlack"),
      missingStripeId: flag(url, "missingStripeId"),
      slackIdentityUnresolved: flag(url, "slackIdentityUnresolved"),
      missingCityChannel: flag(url, "missingCityChannel"),
      missingAllMembers: flag(url, "missingAllMembers"),
      criticalIssues: flag(url, "criticalIssues"),
      gracePeriod: flag(url, "gracePeriod"),
      expiredStillInSlack: flag(url, "expiredStillInSlack"),
      stripeConflict: flag(url, "stripeConflict"),
      duplicateStripe: flag(url, "duplicateStripe"),
      actionableOnly: flag(url, "actionableOnly"),
      informationalOnly: flag(url, "informationalOnly"),
      accessEndingDays: url.searchParams.get("accessEndingDays")
        ? parseInt(url.searchParams.get("accessEndingDays")!, 10)
        : undefined,
      dateJoinedFrom: url.searchParams.get("dateJoinedFrom") || undefined,
      dateJoinedTo: url.searchParams.get("dateJoinedTo") || undefined,
      cancellationFrom: url.searchParams.get("cancellationFrom") || undefined,
      cancellationTo: url.searchParams.get("cancellationTo") || undefined,
      slackIdentityState: url.searchParams.get("slackIdentityState") || undefined,
    };

    const scan = await scanMemberHealth({
      includeSlack: true,
      includeChannelMembership: includeChannels,
    });

    let filtered = filterMembers(scan.members, query);

    filtered = [...filtered].sort((a, b) => {
      const sr = severityRank(a.highestSeverity) - severityRank(b.highestSeverity);
      if (sr !== 0) return sr;
      return a.name.localeCompare(b.name);
    });

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);
    const filterOptions = buildMemberFilterOptions(scan.members);

    return jsonOk({
      summary: scan.summary,
      total,
      page,
      pageSize,
      members: items,
      filterOptions,
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
