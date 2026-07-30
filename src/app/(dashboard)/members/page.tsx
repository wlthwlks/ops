"use client";

import { useCallback, useEffect, useMemo, useState, Suspense } from "react";
import { App, Badge, Button, Input, Space, Spin, Table, Tag, Typography } from "antd";
import { FilterOutlined } from "@ant-design/icons";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OpsPageHeader } from "@/components/ops/OpsPageHeader";
import { IssueSeverityTag } from "@/components/ops/IssueSeverityTag";
import { ErrorState } from "@/components/ops/ErrorState";
import { EmptyState } from "@/components/ops/EmptyState";
import { MemberDetailsDrawer } from "@/components/ops/MemberDetailsDrawer";
import { TableColumnHelp, MEMBER_COLUMN_HELP } from "@/components/ops/TableColumnHelp";
import { ActiveFilterChips } from "@/components/ops/ActiveFilterChips";
import {
  MemberFilterDrawer,
  type FilterOptions,
  type MemberFilterState,
} from "@/components/ops/MemberFilterDrawer";
import type { MemberHealthRow } from "@/lib/ops/member-health-types";

const PAGE_SIZES = [50, 100, 200] as const;

const FILTER_KEYS = [
  "city",
  "membership",
  "payment",
  "severity",
  "issueCode",
  "serviceAccess",
  "slackIdentityState",
  "accessEndingDays",
  "dateJoinedFrom",
  "dateJoinedTo",
  "cancellationFrom",
  "cancellationTo",
  "needsAction",
  "missingSlack",
  "missingStripeId",
  "slackIdentityUnresolved",
  "missingCityChannel",
  "missingAllMembers",
  "criticalIssues",
  "gracePeriod",
  "expiredStillInSlack",
  "stripeConflict",
  "duplicateStripe",
  "actionableOnly",
  "informationalOnly",
  "q",
] as const;

function MembersDirectoryPageInner() {
  const { message } = App.useApp();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberHealthRow[]>([]);
  const [total, setTotal] = useState(0);
  const [mode, setMode] = useState("read_only");
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [selected, setSelected] = useState<MemberHealthRow | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({
    cities: [],
    memberships: [],
    payments: [],
    issueCodes: [],
    slackIdentityStates: [],
  });

  const q = searchParams.get("q") || "";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const rawSize = parseInt(searchParams.get("pageSize") || "100", 10);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(rawSize) ? rawSize : 100;
  const view = searchParams.get("view") || "";

  const replaceParams = useCallback(
    (patch: Record<string, string | null>, opts?: { resetPage?: boolean }) => {
      const p = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") p.delete(k);
        else p.set(k, v);
      }
      if (opts?.resetPage) p.set("page", "1");
      if (!p.get("pageSize")) p.set("pageSize", String(pageSize));
      router.replace(`${pathname}?${p.toString()}`);
    },
    [pathname, router, searchParams, pageSize]
  );

  const filterState: MemberFilterState = useMemo(() => {
    const get = (k: string) => searchParams.get(k) || undefined;
    const flag = (k: string) => (searchParams.get(k) === "1" ? true : undefined);
    return {
      city: get("city"),
      membership: get("membership"),
      payment: get("payment"),
      severity: get("severity"),
      issueCode: get("issueCode"),
      serviceAccess: get("serviceAccess"),
      slackIdentityState: get("slackIdentityState"),
      accessEndingDays: get("accessEndingDays")
        ? parseInt(get("accessEndingDays")!, 10)
        : undefined,
      dateJoinedFrom: get("dateJoinedFrom"),
      dateJoinedTo: get("dateJoinedTo"),
      cancellationFrom: get("cancellationFrom"),
      cancellationTo: get("cancellationTo"),
      missingSlack: flag("missingSlack"),
      missingStripeId: flag("missingStripeId"),
      slackIdentityUnresolved: flag("slackIdentityUnresolved"),
      missingCityChannel: flag("missingCityChannel"),
      missingAllMembers: flag("missingAllMembers"),
      gracePeriod: flag("gracePeriod"),
      expiredStillInSlack: flag("expiredStillInSlack"),
      stripeConflict: flag("stripeConflict"),
      duplicateStripe: flag("duplicateStripe"),
      actionableOnly: flag("actionableOnly"),
      informationalOnly: flag("informationalOnly"),
    };
  }, [searchParams]);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    for (const k of FILTER_KEYS) {
      if (k === "q") continue;
      if (searchParams.get(k)) n++;
    }
    if (view) n++;
    return n;
  }, [searchParams, view]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams(searchParams.toString());
      p.set("page", String(page));
      p.set("pageSize", String(pageSize));
      // Apply quick views as API flags
      if (view === "needs_action") p.set("needsAction", "1");
      if (view === "current_access") p.set("serviceAccess", "current");
      if (view === "expired_access") p.set("serviceAccess", "expired");
      if (view === "missing_slack") p.set("missingSlack", "1");
      if (view === "missing_stripe") p.set("missingStripeId", "1");
      if (view === "slack_unresolved") p.set("slackIdentityUnresolved", "1");
      if (view === "missing_city_channel") p.set("missingCityChannel", "1");
      if (view === "missing_all_members") p.set("missingAllMembers", "1");
      if (view === "critical") p.set("criticalIssues", "1");
      if (view === "grace") p.set("gracePeriod", "1");
      if (view === "expired_in_slack") p.set("expiredStillInSlack", "1");

      const res = await fetch(`/api/ops-dashboard/members?${p}`);
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || res.statusText);

      const nextTotal = Number(json.total || 0);
      const maxPage = Math.max(1, Math.ceil(nextTotal / pageSize) || 1);
      if (page > maxPage && nextTotal >= 0) {
        replaceParams({ page: String(maxPage) });
        return;
      }

      setMembers(json.members || []);
      setTotal(nextTotal);
      setMode(json.summary?.mode || "read_only");
      setScannedAt(json.summary?.scannedAt || null);
      if (json.filterOptions) setFilterOptions(json.filterOptions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [searchParams, page, pageSize, view, replaceParams]);

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = () => {
    const headers = [
      "name",
      "email",
      "city",
      "membership",
      "payment",
      "serviceAccessUntil",
      "stripeCustomerId",
      "slackIdentityState",
      "highestSeverity",
      "issues",
    ];
    const lines = [headers.join(",")];
    for (const m of members) {
      lines.push(
        [
          m.name,
          m.primaryEmail,
          m.city,
          m.membership,
          m.payment,
          m.serviceAccessUntil,
          m.stripeCustomerId,
          m.slackIdentityState,
          m.highestSeverity || "",
          m.issues.map((i) => i.code).join("|"),
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(",")
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "members-page.csv";
    a.click();
    URL.revokeObjectURL(url);
    message.success("CSV exported (current page)");
  };

  const applyFilters = (next: MemberFilterState) => {
    const patch: Record<string, string | null> = {};
    const boolKeys = [
      "missingSlack",
      "missingStripeId",
      "slackIdentityUnresolved",
      "missingCityChannel",
      "missingAllMembers",
      "gracePeriod",
      "expiredStillInSlack",
      "stripeConflict",
      "duplicateStripe",
      "actionableOnly",
      "informationalOnly",
    ] as const;
    for (const k of boolKeys) {
      patch[k] = next[k] ? "1" : null;
    }
    patch.city = next.city || null;
    patch.membership = next.membership || null;
    patch.payment = next.payment || null;
    patch.severity = next.severity || null;
    patch.issueCode = next.issueCode || null;
    patch.serviceAccess = next.serviceAccess || null;
    patch.slackIdentityState = next.slackIdentityState || null;
    patch.accessEndingDays =
      next.accessEndingDays != null ? String(next.accessEndingDays) : null;
    patch.dateJoinedFrom = next.dateJoinedFrom || null;
    patch.dateJoinedTo = next.dateJoinedTo || null;
    patch.cancellationFrom = next.cancellationFrom || null;
    patch.cancellationTo = next.cancellationTo || null;
    patch.view = null;
    replaceParams(patch, { resetPage: true });
  };

  const chips = useMemo(() => {
    const list: { key: string; label: string; onRemove: () => void }[] = [];
    if (view) {
      list.push({
        key: "view",
        label: `View: ${view.replace(/_/g, " ")}`,
        onRemove: () => replaceParams({ view: null }, { resetPage: true }),
      });
    }
    if (q) {
      list.push({
        key: "q",
        label: `Search: ${q}`,
        onRemove: () => replaceParams({ q: null }, { resetPage: true }),
      });
    }
    for (const [k, v] of Object.entries(filterState)) {
      if (v == null || v === false || v === "") continue;
      list.push({
        key: k,
        label: `${k}: ${String(v)}`,
        onRemove: () => replaceParams({ [k]: null }, { resetPage: true }),
      });
    }
    return list;
  }, [filterState, q, view, replaceParams]);

  const quickViews = [
    { id: "", label: "All members" },
    { id: "needs_action", label: "Needs action" },
    { id: "current_access", label: "Current access" },
    { id: "expired_access", label: "Expired access" },
    { id: "missing_slack", label: "Missing Slack" },
    { id: "missing_stripe", label: "Missing Stripe ID" },
    { id: "slack_unresolved", label: "Slack identity unresolved" },
    { id: "missing_city_channel", label: "Missing city channel" },
    { id: "missing_all_members", label: "Missing all-wlth-wlks" },
    { id: "critical", label: "Critical issues" },
    { id: "grace", label: "Cancelled but grace period" },
    { id: "expired_in_slack", label: "Expired still in Slack" },
  ];

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <OpsPageHeader
        title="Member Directory"
        description="Operational directory of Airtable members with Stripe and Slack health."
        breadcrumbs={[{ title: "Members", href: "/members" }, { title: "Directory" }]}
        mode={mode}
        scannedAt={scannedAt}
        onRefresh={load}
        refreshing={loading}
        extra={
          <Button onClick={exportCsv} disabled={!members.length}>
            Export CSV
          </Button>
        }
      />

      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search
          placeholder="Search name, email, Stripe ID…"
          allowClear
          defaultValue={q}
          onSearch={(v) => replaceParams({ q: v || null }, { resetPage: true })}
          style={{ width: 280 }}
        />
        <Badge count={activeFilterCount} size="small">
          <Button icon={<FilterOutlined />} onClick={() => setFilterOpen(true)}>
            Filters
          </Button>
        </Badge>
        <Button
          onClick={() => {
            router.replace(`${pathname}?page=1&pageSize=100`);
          }}
        >
          Reset
        </Button>
        <Typography.Text type="secondary">{total} result(s)</Typography.Text>
      </Space>

      <Space wrap style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary">Quick views:</Typography.Text>
        {quickViews.map((v) => (
          <Tag
            key={v.id || "all"}
            color={(view || "") === v.id ? "blue" : "default"}
            style={{ cursor: "pointer" }}
            onClick={() =>
              replaceParams(
                {
                  view: v.id || null,
                  needsAction: null,
                  serviceAccess: null,
                  missingSlack: null,
                  missingStripeId: null,
                },
                { resetPage: true }
              )
            }
          >
            {v.label}
          </Tag>
        ))}
      </Space>

      <ActiveFilterChips
        chips={chips}
        onClearAll={() => router.replace(`${pathname}?page=1&pageSize=100`)}
      />

      {error && <ErrorState message={error} onRetry={load} />}

      <Table
        size="small"
        loading={loading}
        rowKey={(r) => r.airtableRecordId || r.primaryEmail}
        dataSource={members}
        scroll={{ x: 1100 }}
        onRow={(record) => ({
          onClick: () => setSelected(record),
          style: { cursor: "pointer" },
        })}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: PAGE_SIZES.map(String),
          showTotal: (t, range) => `${range[0]}–${range[1]} of ${t} members`,
          onChange: (p, ps) => {
            replaceParams({
              page: String(p),
              pageSize: String(ps || pageSize),
            });
          },
        }}
        locale={{
          emptyText: (
            <EmptyState
              title="No members match"
              description="Adjust filters or run a fresh scan."
              actionLabel="Scan"
              onAction={load}
            />
          ),
        }}
        columns={[
          { title: "Name", dataIndex: "name", fixed: "left", width: 160 },
          { title: "Email", dataIndex: "primaryEmail", width: 220 },
          { title: "City", dataIndex: "city", width: 120 },
          {
            title: <TableColumnHelp title="Access" content={MEMBER_COLUMN_HELP.access} />,
            dataIndex: "hasCurrentServiceAccess",
            width: 100,
            render: (v: boolean) =>
              v ? <Tag color="success">Yes</Tag> : <Tag>No</Tag>,
          },
          {
            title: <TableColumnHelp title="Stripe" content={MEMBER_COLUMN_HELP.stripe} />,
            dataIndex: "stripeCustomerId",
            width: 140,
            render: (v: string) => (v ? <Tag color="blue">Linked</Tag> : <Tag>Missing</Tag>),
          },
          {
            title: <TableColumnHelp title="Slack" content={MEMBER_COLUMN_HELP.slack} />,
            dataIndex: "slackIdentityState",
            width: 140,
            render: (v: string) => <Tag>{v.replace(/_/g, " ")}</Tag>,
          },
          {
            title: (
              <TableColumnHelp title="Severity" content={MEMBER_COLUMN_HELP.severity} />
            ),
            dataIndex: "highestSeverity",
            width: 110,
            render: (v) => <IssueSeverityTag severity={v} />,
          },
          {
            title: (
              <TableColumnHelp title="Next action" content={MEMBER_COLUMN_HELP.nextAction} />
            ),
            dataIndex: "recommendedNextAction",
            ellipsis: true,
          },
        ]}
      />

      <MemberDetailsDrawer
        open={Boolean(selected)}
        member={selected}
        onClose={() => setSelected(null)}
      />

      <MemberFilterDrawer
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        value={filterState}
        options={filterOptions}
        onApply={applyFilters}
      />
    </div>
  );
}

export default function MembersDirectoryPage() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: 48, textAlign: "center" }}>
          <Spin size="large" />
        </div>
      }
    >
      <MembersDirectoryPageInner />
    </Suspense>
  );
}
