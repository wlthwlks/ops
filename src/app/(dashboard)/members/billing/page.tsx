"use client";

import { useCallback, useEffect, useState, Suspense } from "react";
import {
  Button,
  Card,
  Col,
  Row,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OpsPageHeader } from "@/components/ops/OpsPageHeader";
import { KpiCard } from "@/components/ops/KpiCard";
import { ErrorState } from "@/components/ops/ErrorState";
import { TabHelpLabel } from "@/components/ops/TabHelpLabel";
import { MemberDetailsDrawer } from "@/components/ops/MemberDetailsDrawer";
import { IssueSeverityTag } from "@/components/ops/IssueSeverityTag";
import type { MemberHealthRow } from "@/lib/ops/member-health-types";

const TAB_HELP: Record<string, string> = {
  overview:
    "KPI summary from the light member scan and full Stripe scan status. Unchecked Stripe-only metrics show Not checked, never a misleading zero.",
  missing_stripe:
    "Service-eligible members missing a Stripe Customer ID link. Identity problem — not automatic proof of non-payment.",
  conflicts:
    "Duplicate emails, shared Stripe IDs, multi-customer emails. Automatic changes blocked.",
  service_access:
    "Service access until vs Stripe paid-through classifications using the shared access rule.",
  stripe_missing_airtable:
    "Paying Stripe customers without Airtable Members. Requires full scan. No Create Member button — CLI-only historical repair.",
  scan_history: "Billing scan run history when available; otherwise explains how to run CLI scans.",
  how: "Explanations of billing integrity concepts and rules.",
};

function BillingPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") || "overview";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState<MemberHealthRow | null>(null);
  const [mode, setMode] = useState("read_only");
  const [scannedAt, setScannedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({
        tab,
        page: String(page),
        pageSize: "100",
      });
      const res = await fetch(`/api/ops-dashboard/billing?${p}`);
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || res.statusText);
      setData(json);
      setMode((json.summary as { mode?: string })?.mode || "read_only");
      setScannedAt((json.summary as { scannedAt?: string })?.scannedAt || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tab, page]);

  useEffect(() => {
    load();
  }, [load]);

  const setTab = (t: string) => {
    const p = new URLSearchParams(searchParams.toString());
    p.set("tab", t);
    p.set("page", "1");
    router.replace(`${pathname}?${p.toString()}`);
  };

  const kpis = (data?.kpis || {}) as Record<
    string,
    { value: number | null; display?: string; checked?: boolean; note?: string }
  >;

  const kpiDisplay = (key: string, title: string, tooltip: string) => {
    const k = kpis[key];
    if (!k) {
      return (
        <KpiCard title={title} value="—" tooltip={tooltip} />
      );
    }
    const value =
      k.checked === false || k.value == null
        ? k.display || "Not checked"
        : k.value;
    return (
      <KpiCard
        title={title}
        value={value}
        tooltip={`${tooltip}${k.note ? ` ${k.note}` : ""} Source checked: ${k.checked ? "yes" : "no"}.`}
      />
    );
  };

  const members = (data?.members || []) as MemberHealthRow[];
  const rows = (data?.rows || []) as Array<{
    member: MemberHealthRow;
    classification: string;
    differenceDays: number | null;
  }>;
  const total = Number(data?.total || 0);

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <OpsPageHeader
        title="Billing Integrity"
        description="Stripe linkage, conflicts, and service-access comparisons. Conservative rules only."
        breadcrumbs={[
          { title: "Members", href: "/members" },
          { title: "Billing Integrity" },
        ]}
        mode={mode}
        scannedAt={scannedAt}
        onRefresh={load}
        refreshing={loading}
      />

      {error && <ErrorState message={error} onRetry={load} />}

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "overview",
            label: <TabHelpLabel label="Overview" help={TAB_HELP.overview} />,
            children: loading ? (
              <Spin />
            ) : (
              <Row gutter={[12, 12]}>
                <Col xs={24} sm={12} md={8} lg={6}>
                  {kpiDisplay(
                    "withServiceAccess",
                    "Current service access",
                    "Members with current access via Active+Paid or unexpired Service access until. From light member scan."
                  )}
                </Col>
                <Col xs={24} sm={12} md={8} lg={6}>
                  {kpiDisplay(
                    "withStripeCustomerId",
                    "With Stripe Customer ID",
                    "Airtable members with a cus_ Stripe Customer ID linked."
                  )}
                </Col>
                <Col xs={24} sm={12} md={8} lg={6}>
                  {kpiDisplay(
                    "currentAccessMissingStripeId",
                    "Access missing Stripe ID",
                    "Current-access members missing Stripe Customer ID. Actionable identity link issue."
                  )}
                </Col>
                <Col xs={24} sm={12} md={8} lg={6}>
                  {kpiDisplay(
                    "duplicateStripeIds",
                    "Duplicate Stripe IDs",
                    "Same Stripe ID on multiple Airtable records. Critical conflict."
                  )}
                </Col>
                <Col xs={24} sm={12} md={8} lg={6}>
                  {kpiDisplay(
                    "duplicateAirtableEmails",
                    "Duplicate Airtable emails",
                    "Multiple Airtable members share primary email."
                  )}
                </Col>
                <Col xs={24} sm={12} md={8} lg={6}>
                  {kpiDisplay(
                    "serviceAccessBehindStripe",
                    "Access behind Stripe",
                    "Service access until earlier than Stripe paid-through when billing checked."
                  )}
                </Col>
                <Col xs={24} sm={12} md={8} lg={6}>
                  {kpiDisplay(
                    "accessLaterThanStripe",
                    "Access later than Stripe",
                    "Not an automatic error. Do not shorten."
                  )}
                </Col>
                <Col xs={24} sm={12} md={8} lg={6}>
                  {kpiDisplay(
                    "payingStripeMissingAirtable",
                    "Paying Stripe, missing Airtable",
                    "Requires full Stripe invoice scan. Never shown as 0 when unchecked."
                  )}
                </Col>
                <Col xs={24} sm={12} md={8} lg={6}>
                  {kpiDisplay(
                    "lastFullBillingScan",
                    "Last full billing scan",
                    "Timestamp of last full Stripe invoice scan when available."
                  )}
                </Col>
                <Col xs={24} sm={12} md={8} lg={6}>
                  {kpiDisplay(
                    "billingScanStatus",
                    "Billing scan status",
                    "Status of full Stripe scan pipeline."
                  )}
                </Col>
                <Col span={24}>
                  <Card size="small">
                    <Typography.Text>
                      Related operations:{" "}
                      <Link href="/ops">Open Ops centre</Link> → Stripe reconcile /
                      service-access backfill (CLI catalogue). No dashboard Create Member
                      action.
                    </Typography.Text>
                  </Card>
                </Col>
              </Row>
            ),
          },
          {
            key: "missing_stripe",
            label: (
              <TabHelpLabel label="Missing Stripe Links" help={TAB_HELP.missing_stripe} />
            ),
            children: (
              <>
                <Typography.Paragraph type="secondary">
                  {(data?.explanation as string) || ""}
                </Typography.Paragraph>
                <Space style={{ marginBottom: 12 }}>
                  <Link href="/ops">
                    <Button>Open dry-run operation catalogue</Button>
                  </Link>
                </Space>
                <Table
                  size="small"
                  loading={loading}
                  rowKey={(r) => r.airtableRecordId || r.primaryEmail}
                  dataSource={members}
                  pagination={{
                    current: page,
                    pageSize: 100,
                    total,
                    onChange: (p) => {
                      const sp = new URLSearchParams(searchParams.toString());
                      sp.set("page", String(p));
                      router.replace(`${pathname}?${sp}`);
                    },
                  }}
                  onRow={(r) => ({
                    onClick: () => setSelected(r),
                    style: { cursor: "pointer" },
                  })}
                  columns={[
                    { title: "Name", dataIndex: "name" },
                    { title: "Email", dataIndex: "primaryEmail" },
                    { title: "City", dataIndex: "city" },
                    {
                      title: "Access",
                      render: (_, r) =>
                        r.hasCurrentServiceAccess ? (
                          <Tag color="success">Yes</Tag>
                        ) : (
                          <Tag>No</Tag>
                        ),
                    },
                    {
                      title: "Severity",
                      render: (_, r) => (
                        <IssueSeverityTag severity={r.highestSeverity} />
                      ),
                    },
                    {
                      title: "Action",
                      dataIndex: "recommendedNextAction",
                      ellipsis: true,
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "conflicts",
            label: <TabHelpLabel label="Conflicts" help={TAB_HELP.conflicts} />,
            children: (
              <>
                <Typography.Paragraph type="secondary">
                  {(data?.explanation as string) || ""}
                </Typography.Paragraph>
                <Table
                  size="small"
                  loading={loading}
                  rowKey={(r) => r.airtableRecordId || r.primaryEmail}
                  dataSource={members}
                  pagination={{
                    current: page,
                    pageSize: 100,
                    total,
                    onChange: (p) => {
                      const sp = new URLSearchParams(searchParams.toString());
                      sp.set("page", String(p));
                      router.replace(`${pathname}?${sp}`);
                    },
                  }}
                  onRow={(r) => ({
                    onClick: () => setSelected(r),
                    style: { cursor: "pointer" },
                  })}
                  columns={[
                    { title: "Name", dataIndex: "name" },
                    { title: "Email", dataIndex: "primaryEmail" },
                    {
                      title: "Stripe ID",
                      dataIndex: "stripeCustomerId",
                      render: (v: string) => v || "—",
                    },
                    {
                      title: "Issues",
                      render: (_, r) =>
                        r.issues
                          .filter((i) =>
                            [
                              "DUPLICATE_AIRTABLE_EMAIL",
                              "STRIPE_CUSTOMER_ID_CONFLICT",
                              "MULTIPLE_STRIPE_CUSTOMERS_FOR_EMAIL",
                              "STRIPE_CUSTOMER_ASSIGNED_TO_MULTIPLE_AIRTABLE_RECORDS",
                            ].includes(i.code)
                          )
                          .map((i) => i.label)
                          .join("; "),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "service_access",
            label: (
              <TabHelpLabel label="Service Access" help={TAB_HELP.service_access} />
            ),
            children: (
              <>
                <Typography.Paragraph type="secondary">
                  {(data?.explanation as string) || ""}
                </Typography.Paragraph>
                <Table
                  size="small"
                  loading={loading}
                  rowKey={(r) => r.member.airtableRecordId || r.member.primaryEmail}
                  dataSource={rows}
                  pagination={{
                    current: page,
                    pageSize: 100,
                    total,
                    onChange: (p) => {
                      const sp = new URLSearchParams(searchParams.toString());
                      sp.set("page", String(p));
                      router.replace(`${pathname}?${sp}`);
                    },
                  }}
                  onRow={(r) => ({
                    onClick: () => setSelected(r.member),
                    style: { cursor: "pointer" },
                  })}
                  columns={[
                    { title: "Member", render: (_, r) => r.member.name },
                    { title: "Membership", render: (_, r) => r.member.membership },
                    { title: "Payment", render: (_, r) => r.member.payment },
                    {
                      title: "Cancellation",
                      render: (_, r) => r.member.cancellationDate || "—",
                    },
                    {
                      title: "Service access until",
                      render: (_, r) => r.member.serviceAccessUntil || "—",
                    },
                    {
                      title: "Stripe paid-through",
                      render: (_, r) =>
                        r.member.latestQualifyingPaidThrough || "Not checked",
                    },
                    {
                      title: "Diff (days)",
                      render: (_, r) =>
                        r.differenceDays == null ? "—" : r.differenceDays,
                    },
                    {
                      title: "Classification",
                      render: (_, r) => <Tag>{r.classification}</Tag>,
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "stripe_missing_airtable",
            label: (
              <TabHelpLabel
                label="Paying Stripe, Missing Airtable"
                help={TAB_HELP.stripe_missing_airtable}
              />
            ),
            children: (
              <>
                <Typography.Paragraph type="secondary">
                  {(data?.explanation as string) || ""}
                </Typography.Paragraph>
                <Card size="small" style={{ marginBottom: 12 }}>
                  <Typography.Text>
                    CLI-only historical repair:{" "}
                    <Typography.Text code>
                      npm run airtable:historical-stripe-repair
                    </Typography.Text>
                    . <strong>--create-missing is CLI-only</strong> and is not available as
                    a dashboard button.
                  </Typography.Text>
                </Card>
                {members.length === 0 ? (
                  <Typography.Text type="secondary">
                    {(data?.displayWhenEmpty as string) || "No full scan available"}
                  </Typography.Text>
                ) : (
                  <Table
                    size="small"
                    loading={loading}
                    rowKey={(r) => r.stripeCustomerId || r.primaryEmail}
                    dataSource={members}
                    pagination={{ current: page, pageSize: 100, total }}
                    columns={[
                      { title: "Stripe email", dataIndex: "primaryEmail" },
                      { title: "Stripe Customer ID", dataIndex: "stripeCustomerId" },
                      { title: "Name", dataIndex: "name" },
                    ]}
                  />
                )}
              </>
            ),
          },
          {
            key: "scan_history",
            label: <TabHelpLabel label="Scan History" help={TAB_HELP.scan_history} />,
            children: (
              <Card size="small">
                <Typography.Paragraph>
                  Full Stripe billing scan history is produced by CLI/ops catalogue
                  operations. Open the Ops centre for run logs.
                </Typography.Paragraph>
                <Link href="/ops">
                  <Button type="primary">View Ops run logs</Button>
                </Link>
              </Card>
            ),
          },
          {
            key: "how",
            label: <TabHelpLabel label="How Billing Works" help={TAB_HELP.how} />,
            children: (
              <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
                {(
                  (data?.sections as Array<{ title: string; body: string }>) || [
                    {
                      title: "Service access rule",
                      body: "Active+Paid OR unexpired Service access until.",
                    },
                    {
                      title: "Stripe Customer ID",
                      body: "Identity link only — not full invoice proof.",
                    },
                    {
                      title: "Member creation",
                      body: "Dashboard never creates Members from Stripe.",
                    },
                  ]
                ).map((s) => (
                  <Card key={s.title} size="small" title={s.title}>
                    {s.body}
                  </Card>
                ))}
              </Space>
            ),
          },
        ]}
      />

      <MemberDetailsDrawer
        open={Boolean(selected)}
        member={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: 48, textAlign: "center" }}>
          <Spin size="large" />
        </div>
      }
    >
      <BillingPageInner />
    </Suspense>
  );
}
