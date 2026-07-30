import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { filterMembers, scanMemberHealth } from "@/lib/ops/member-health";
import { severityRank } from "@/lib/ops/member-issue-classifier";
import type { MemberHealthRow } from "@/lib/ops/member-health-types";

export const runtime = "nodejs";
export const maxDuration = 120;

function serviceAccessClassification(m: MemberHealthRow): string {
  if (m.issues.some((i) => i.code === "INVALID_SERVICE_ACCESS_DATE")) {
    return "invalid_date";
  }
  if (!m.latestQualifyingPaidThrough) {
    if (m.hasCurrentServiceAccess) {
      if (m.membership !== "Active" || m.payment !== "Paid") return "grace_period";
      return "current";
    }
    return m.serviceAccessUntil ? "expired" : "not_checked";
  }
  if (m.issues.some((i) => i.code === "SERVICE_ACCESS_DATE_BEHIND_STRIPE")) {
    return "airtable_behind_stripe";
  }
  if (m.issues.some((i) => i.code === "SERVICE_ACCESS_LATER_THAN_STRIPE")) {
    return "airtable_later_than_stripe";
  }
  if (m.hasCurrentServiceAccess) {
    if (m.membership !== "Active" || m.payment !== "Paid") return "grace_period";
    return "current";
  }
  return "expired";
}

export async function GET(request: Request) {
  try {
    await requireOpsViewer();
    const url = new URL(request.url);
    const tab = url.searchParams.get("tab") || "overview";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(
      200,
      Math.max(10, parseInt(url.searchParams.get("pageSize") || "100", 10))
    );
    const q = url.searchParams.get("q") || undefined;

    const scan = await scanMemberHealth({ includeSlack: true });
    const members = scan.members;
    const orphans = scan.orphanStripeCustomers;

    const missingStripe = filterMembers(members, {
      missingStripeId: true,
      q,
    });
    const conflicts = members.filter((m) =>
      m.issues.some((i) =>
        [
          "DUPLICATE_AIRTABLE_EMAIL",
          "STRIPE_CUSTOMER_ID_CONFLICT",
          "MULTIPLE_STRIPE_CUSTOMERS_FOR_EMAIL",
          "STRIPE_CUSTOMER_ASSIGNED_TO_MULTIPLE_AIRTABLE_RECORDS",
        ].includes(i.code)
      )
    );
    const serviceAccessRows = members
      .filter(
        (m) =>
          m.issues.some((i) =>
            [
              "SERVICE_ACCESS_DATE_BEHIND_STRIPE",
              "SERVICE_ACCESS_LATER_THAN_STRIPE",
              "INVALID_SERVICE_ACCESS_DATE",
              "CANCELLED_WITH_VALID_SERVICE_ACCESS",
            ].includes(i.code)
          ) ||
          Boolean(m.serviceAccessUntil) ||
          m.hasCurrentServiceAccess
      )
      .map((m) => ({
        member: m,
        classification: serviceAccessClassification(m),
        differenceDays: (() => {
          if (!m.serviceAccessUntil || !m.latestQualifyingPaidThrough) return null;
          const a = new Date(m.serviceAccessUntil).getTime();
          const b = new Date(m.latestQualifyingPaidThrough).getTime();
          if (Number.isNaN(a) || Number.isNaN(b)) return null;
          return Math.round((a - b) / 86400000);
        })(),
      }));

    const kpis = {
      withServiceAccess: {
        value: scan.summary.withServiceAccess,
        source: "member_scan" as const,
        checked: true,
      },
      withStripeCustomerId: {
        value: members.filter((m) => m.stripeCustomerId.startsWith("cus_")).length,
        source: "member_scan" as const,
        checked: true,
      },
      currentAccessMissingStripeId: {
        value: members.filter(
          (m) =>
            m.hasCurrentServiceAccess &&
            m.issues.some((i) => i.code === "AIRTABLE_MEMBER_MISSING_STRIPE_CUSTOMER_ID")
        ).length,
        source: "member_scan" as const,
        checked: true,
      },
      duplicateStripeIds: {
        value: members.filter((m) =>
          m.issues.some(
            (i) => i.code === "STRIPE_CUSTOMER_ASSIGNED_TO_MULTIPLE_AIRTABLE_RECORDS"
          )
        ).length,
        source: "member_scan" as const,
        checked: true,
      },
      duplicateAirtableEmails: {
        value: members.filter((m) =>
          m.issues.some((i) => i.code === "DUPLICATE_AIRTABLE_EMAIL")
        ).length,
        source: "member_scan" as const,
        checked: true,
      },
      serviceAccessBehindStripe: {
        value: members.filter((m) =>
          m.issues.some((i) => i.code === "SERVICE_ACCESS_DATE_BEHIND_STRIPE")
        ).length,
        source: "member_scan" as const,
        checked: true,
        note: "Only when full Stripe paid-through is loaded on the row",
      },
      accessLaterThanStripe: {
        value: members.filter((m) =>
          m.issues.some((i) => i.code === "SERVICE_ACCESS_LATER_THAN_STRIPE")
        ).length,
        source: "member_scan" as const,
        checked: true,
      },
      payingStripeMissingAirtable: {
        value: null as number | null,
        display: "Not checked",
        source: "full_stripe_scan" as const,
        checked: false,
        note: "Requires full Stripe invoice scan / historical repair CLI. Light member scan does not enumerate Stripe-only customers.",
      },
      lastFullBillingScan: {
        value: null as string | null,
        display: "No full scan available",
        source: "full_stripe_scan" as const,
        checked: false,
      },
      billingScanStatus: {
        value: "not_checked",
        display: "Not checked",
        source: "full_stripe_scan" as const,
        checked: false,
      },
    };

    // If orphans were populated by a prior full scan path, surface them
    if (orphans.length > 0) {
      kpis.payingStripeMissingAirtable = {
        value: orphans.length,
        display: String(orphans.length),
        source: "full_stripe_scan",
        checked: true,
        note: "From scan orphan list",
      };
    }

    function pageOf<T>(items: T[]) {
      const total = items.length;
      const start = (page - 1) * pageSize;
      return { total, page, pageSize, items: items.slice(start, start + pageSize) };
    }

    if (tab === "overview") {
      return jsonOk({
        tab,
        summary: scan.summary,
        kpis,
        mode: scan.summary.mode,
      });
    }

    if (tab === "missing_stripe") {
      const sorted = [...missingStripe].sort(
        (a, b) =>
          severityRank(a.highestSeverity) - severityRank(b.highestSeverity) ||
          a.name.localeCompare(b.name)
      );
      const paged = pageOf(sorted);
      return jsonOk({
        tab,
        summary: scan.summary,
        kpis,
        total: paged.total,
        page: paged.page,
        pageSize: paged.pageSize,
        members: paged.items,
        explanation:
          "A missing Stripe Customer ID is an identity-link problem. It does not automatically mean the member has not paid. Only unique conservative candidates may be applied automatically.",
        relatedOps: [
          { slug: "airtable-reconcile-stripe", label: "Open Stripe reconcile (CLI catalogue)" },
        ],
      });
    }

    if (tab === "conflicts") {
      const sorted = [...conflicts].sort((a, b) => a.name.localeCompare(b.name));
      const paged = pageOf(sorted);
      return jsonOk({
        tab,
        summary: scan.summary,
        total: paged.total,
        page: paged.page,
        pageSize: paged.pageSize,
        members: paged.items,
        explanation:
          "Automatic changes are blocked for conflicts. Review duplicate emails, shared Stripe IDs, and multi-customer emails manually.",
      });
    }

    if (tab === "service_access") {
      const filtered = q
        ? serviceAccessRows.filter((r) => {
            const hay = `${r.member.name} ${r.member.primaryEmail}`.toLowerCase();
            return hay.includes(q.toLowerCase());
          })
        : serviceAccessRows;
      const paged = pageOf(filtered);
      return jsonOk({
        tab,
        summary: scan.summary,
        total: paged.total,
        page: paged.page,
        pageSize: paged.pageSize,
        rows: paged.items,
        explanation:
          "Shared hasServiceAccess rule: Active+Paid OR unexpired Service access until. Airtable later than Stripe is not an automatic error and must not be shortened.",
      });
    }

    if (tab === "stripe_missing_airtable") {
      const paged = pageOf(orphans);
      return jsonOk({
        tab,
        summary: scan.summary,
        total: paged.total,
        page: paged.page,
        pageSize: paged.pageSize,
        members: paged.items,
        checked: orphans.length > 0 || false,
        displayWhenEmpty: orphans.length === 0 ? "No full scan available" : null,
        explanation:
          "Memberstack + Make creates normal Members. Stripe webhooks do not create Members. Historical missing customers are a deliberate CLI repair process. --create-missing remains CLI-only with no dashboard button.",
        cliOnlyCommand: "npm run airtable:historical-stripe-repair",
        createMissingForbidden: true,
      });
    }

    if (tab === "how") {
      return jsonOk({
        tab,
        sections: [
          {
            title: "Service access rule",
            body: "A member has access when Membership is Active and Payment is Paid, or Service access until has not expired.",
          },
          {
            title: "Stripe Customer ID",
            body: "Exact ID on Airtable is the identity link. Missing ID is not proof of non-payment.",
          },
          {
            title: "Full billing scan",
            body: "Invoice qualification requires a full Stripe scan (CLI / ops). Light member health scan does not invent zeros for unchecked Stripe-only populations.",
          },
          {
            title: "Member creation",
            body: "Dashboard never creates Airtable Members from Stripe. Historical --create-missing is CLI-only.",
          },
        ],
      });
    }

    return jsonOk({ tab: "overview", summary: scan.summary, kpis });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
