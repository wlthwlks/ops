"use client";

import { useCallback, useEffect, useState, Suspense } from "react";
import { App, Button, Input, Segmented, Space, Spin, Table, Typography } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OpsPageHeader } from "@/components/ops/OpsPageHeader";
import { IssueSeverityTag } from "@/components/ops/IssueSeverityTag";
import { ErrorState } from "@/components/ops/ErrorState";
import { TabHelpLabel } from "@/components/ops/TabHelpLabel";
import {
  MemberDetailsDrawer,
  type OpenedFromIssue,
} from "@/components/ops/MemberDetailsDrawer";
import { ISSUE_CATEGORY_HELP } from "@/lib/ops/issue-category-help";
import type { MemberHealthRow, MemberIssue } from "@/lib/ops/member-health-types";

type IssueRow = {
  airtableRecordId: string | null;
  name: string;
  email: string;
  city: string;
  issue: MemberIssue;
  detectedAt: string;
  member: MemberHealthRow;
};

function catLabel(value: string, label: string) {
  return {
    label: (
      <TabHelpLabel
        label={label}
        help={ISSUE_CATEGORY_HELP[value] || ISSUE_CATEGORY_HELP.all}
      />
    ),
    value,
  };
}

function DataIssuesPageInner() {
  const { message } = App.useApp();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const category = searchParams.get("category") || "all";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [total, setTotal] = useState(0);
  const [mode, setMode] = useState("read_only");
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MemberHealthRow | null>(null);
  const [openedFrom, setOpenedFrom] = useState<OpenedFromIssue | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({
        category,
        page: String(page),
        pageSize: "50",
        actionable: "1",
      });
      if (q) p.set("q", q);
      const res = await fetch(`/api/ops-dashboard/issues?${p}`);
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || res.statusText);
      setIssues(json.issues || []);
      setTotal(json.total || 0);
      setMode(json.summary?.mode || "read_only");
      setScannedAt(json.summary?.scannedAt || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [category, page, q]);

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = () => {
    const lines = [
      "severity,code,name,email,city,explanation,action",
      ...issues.map((r) =>
        [
          r.issue.severity,
          r.issue.code,
          r.name,
          r.email,
          r.city,
          r.issue.explanation,
          r.issue.recommendedAction,
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(",")
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "member-issues.csv";
    a.click();
    message.success("Exported current page");
  };

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <OpsPageHeader
        title="Data Issues"
        description="Operational work queue ordered by severity. Click a row for full member details."
        breadcrumbs={[
          { title: "Members", href: "/members" },
          { title: "Data Issues" },
        ]}
        mode={mode}
        scannedAt={scannedAt}
        onRefresh={load}
        refreshing={loading}
        extra={<Button onClick={exportCsv}>Export CSV</Button>}
      />

      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented
          value={category}
          onChange={(v) => {
            setPage(1);
            const p = new URLSearchParams(searchParams.toString());
            p.set("category", String(v));
            router.replace(`${pathname}?${p.toString()}`);
          }}
          options={[
            catLabel("all", "All"),
            catLabel("critical", "Critical"),
            catLabel("billing", "Billing"),
            catLabel("slack", "Slack"),
            catLabel("channel", "Channels"),
            catLabel("identity", "Identity"),
            catLabel("service_access", "Service access"),
          ]}
        />
        <Input.Search
          placeholder="Search…"
          allowClear
          onSearch={(v) => {
            setPage(1);
            setQ(v);
          }}
          style={{ width: 240 }}
        />
        <Typography.Text type="secondary">{total} issue(s)</Typography.Text>
      </Space>

      {error && <ErrorState message={error} onRetry={load} />}

      <Table
        size="small"
        loading={loading}
        rowKey={(r) => `${r.airtableRecordId}-${r.issue.code}-${r.email}`}
        dataSource={issues}
        scroll={{ x: 1100 }}
        onRow={(record) => ({
          onClick: () => {
            // Member payload already on the row — no second full scan
            setSelected(record.member);
            setOpenedFrom({ issue: record.issue, detectedAt: record.detectedAt });
          },
          style: { cursor: "pointer" },
        })}
        pagination={{
          current: page,
          pageSize: 50,
          total,
          onChange: setPage,
        }}
        columns={[
          {
            title: "Severity",
            width: 100,
            render: (_, r) => <IssueSeverityTag severity={r.issue.severity} />,
          },
          { title: "Member", dataIndex: "name", width: 150 },
          { title: "City", dataIndex: "city", width: 110 },
          { title: "Issue", render: (_, r) => r.issue.label },
          {
            title: "Systems",
            width: 140,
            render: (_, r) => r.issue.systems.join(", "),
          },
          {
            title: "Explanation",
            render: (_, r) => r.issue.explanation,
            ellipsis: true,
          },
          {
            title: "Action",
            render: (_, r) => r.issue.recommendedAction,
            ellipsis: true,
          },
        ]}
      />

      <MemberDetailsDrawer
        open={Boolean(selected)}
        member={selected}
        openedFromIssue={openedFrom}
        onClose={() => {
          setSelected(null);
          setOpenedFrom(null);
        }}
      />
    </div>
  );
}

export default function DataIssuesPage() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: 48, textAlign: "center" }}>
          <Spin size="large" />
        </div>
      }
    >
      <DataIssuesPageInner />
    </Suspense>
  );
}
