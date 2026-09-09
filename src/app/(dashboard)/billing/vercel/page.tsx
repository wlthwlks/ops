"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Card, Col, Row, Spin, Table, Tag, Typography, Descriptions } from "antd";
import dynamic from "next/dynamic";
import { OpsPageHeader } from "@/components/ops/OpsPageHeader";
import { KpiCard } from "@/components/ops/KpiCard";
import { ErrorState } from "@/components/ops/ErrorState";

const { Text } = Typography;

const Column = dynamic(() => import("@ant-design/charts").then((m) => m.Column), {
  ssr: false,
  loading: () => <Spin />,
});

type BoundaryRow = {
  invoiceKey: string;
  serviceName: string;
  threshold: number;
  consumed: number;
  unit: string;
  pct: number;
  status: "ok" | "warning" | "exceeded";
};

type VercelBillingResponse = {
  success: boolean;
  fetchedAt?: string;
  team?: { id: string; slug: string; name: string | null };
  plan?: {
    plan: string;
    planIteration: string | null;
    currency: string;
    status: string | null;
    billingEmail: string | null;
    subscriptionMonthlyUsd: number;
    includedAllocationUsd: number;
    additionalSeats: number;
    periodStart: string | null;
    periodEnd: string | null;
  };
  summary?: {
    totalUsageCost: number;
    byService: Array<{
      service: string;
      category: string;
      cost: number;
      quantity: number;
      unit: string | null;
    }>;
    byDay: Array<{ date: string; cost: number }>;
  };
  analysis?: {
    boundaries: BoundaryRow[];
    flags: Array<{ level: "info" | "warning" | "error"; title: string; message: string }>;
    projectedUsageCost: number | null;
  };
  note?: string;
  message?: string;
};

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const num = (n: number, digits = 0) =>
  n.toLocaleString("en-US", { maximumFractionDigits: digits });

export default function VercelBillingPage() {
  const [data, setData] = useState<VercelBillingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotConfigured(false);
    try {
      const res = await fetch("/api/ops-dashboard/vercel-billing");
      const json = (await res.json()) as VercelBillingResponse & { code?: string };
      if (!res.ok || json.success === false) {
        if (json.code === "VERCEL_NOT_CONFIGURED") {
          setNotConfigured(true);
          setData(null);
          return;
        }
        throw new Error(json.message || `HTTP ${res.status}`);
      }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const chartData = useMemo(
    () =>
      (data?.summary?.byDay ?? [])
        .filter((d) => d.cost > 0)
        .map((d) => ({ date: d.date.slice(5), cost: Number(d.cost.toFixed(4)) })),
    [data?.summary?.byDay]
  );

  const boundaryColumns = [
    { title: "Service", dataIndex: "serviceName", key: "serviceName" },
    {
      title: "Included",
      key: "threshold",
      render: (_: unknown, row: BoundaryRow) => `${num(row.threshold, 1)} ${row.unit}`,
    },
    {
      title: "Used",
      key: "consumed",
      render: (_: unknown, row: BoundaryRow) => `${num(row.consumed, 1)} ${row.unit}`,
    },
    {
      title: "Used %",
      key: "pct",
      render: (_: unknown, row: BoundaryRow) => (
        <Tag color={row.status === "exceeded" ? "red" : row.status === "warning" ? "orange" : "green"}>
          {(row.pct * 100).toFixed(1)}%
        </Tag>
      ),
    },
  ];

  const serviceColumns = [
    { title: "Service", dataIndex: "service", key: "service" },
    { title: "Category", dataIndex: "category", key: "category" },
    {
      title: "Consumed",
      key: "quantity",
      render: (_: unknown, row: { quantity: number; unit: string | null }) =>
        row.quantity > 0 ? `${num(row.quantity, 2)} ${row.unit ?? ""}` : "—",
    },
    {
      title: "Cost this period",
      dataIndex: "cost",
      key: "cost",
      align: "right" as const,
      render: (v: number) => <Text strong>{usd(v)}</Text>,
    },
  ];

  const plan = data?.plan;
  const analysis = data?.analysis;
  const summary = data?.summary;
  const isHobby = (plan?.plan ?? "") === "hobby";

  return (
    <div>
      <OpsPageHeader
        title="Vercel Billing"
        description="Real charges and plan boundaries from the Vercel API — usage costs, included allowances, and upgrade signals."
        scannedAt={data?.fetchedAt}
        onRefresh={load}
        refreshing={loading}
      />

      {notConfigured && (
        <ErrorState
          title="Vercel token not configured"
          message="Add VERCEL_TOKEN (from vercel.com/account/tokens) to the environment to enable this tab."
          onRetry={load}
        />
      )}

      {error && <ErrorState message={error} onRetry={load} />}

      {loading && !data && (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Spin />
        </div>
      )}

      {data && data.success && (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Col xs={24} sm={12} lg={6}>
              <KpiCard
                title="Usage charges this period"
                value={usd(summary?.totalUsageCost ?? 0)}
                hint={`Pay-as-you-go beyond included allowances`}
                tooltip="Sum of Usage-category BilledCost rows for the current billing period. $0 means everything fits inside the included allowances."
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KpiCard
                title="Subscription"
                value={usd(plan?.subscriptionMonthlyUsd ?? 0)}
                hint={`${(plan?.plan ?? "?").toUpperCase()}${plan?.planIteration ? ` · ${plan.planIteration}` : ""} · ${(plan?.currency ?? "usd").toUpperCase()}`}
                tooltip="Flat monthly plan price from the team billing record. Additional seats and add-ons are shown in the plan card."
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KpiCard
                title="Included usage allocation"
                value={usd(plan?.includedAllocationUsd ?? 0)}
                hint="Credit absorbing pay-as-you-go usage before real charges"
                tooltip="Vercel Pro includes a usage allocation credit; usage charges only appear after it is exhausted."
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KpiCard
                title="Projected usage cost"
                value={analysis?.projectedUsageCost != null ? usd(analysis.projectedUsageCost) : "—"}
                hint={isHobby ? "Hobby has hard caps, no usage billing" : "End-of-period estimate at current burn rate"}
                tooltip="MTD usage cost extrapolated over the full billing period. Only shown when usage charges are non-zero."
              />
            </Col>
          </Row>

          {(analysis?.flags ?? []).map((flag) => (
            <Alert
              key={flag.title}
              type={flag.level === "error" ? "error" : flag.level === "warning" ? "warning" : "info"}
              showIcon
              message={flag.title}
              description={flag.message}
              style={{ marginBottom: 12 }}
            />
          ))}

          <Row gutter={[16, 16]}>
            <Col xs={24} lg={10}>
              <Card size="small" title="Plan" styles={{ body: { padding: 16 } }}>
                <Descriptions column={1} size="small" colon={false}>
                  <Descriptions.Item label="Team">
                    {data.team?.name ?? data.team?.slug ?? "—"}
                  </Descriptions.Item>
                  <Descriptions.Item label="Plan">
                    <Tag color={isHobby ? "default" : "green"}>
                      {(plan?.plan ?? "?").toUpperCase()}
                    </Tag>
                    {plan?.planIteration && <Text type="secondary"> ({plan.planIteration})</Text>}
                  </Descriptions.Item>
                  <Descriptions.Item label="Status">{plan?.status ?? "—"}</Descriptions.Item>
                  <Descriptions.Item label="Billing period">
                    {plan?.periodStart
                      ? `${plan.periodStart.slice(0, 10)} → ${(plan?.periodEnd ?? "").slice(0, 10)}`
                      : "—"}
                  </Descriptions.Item>
                  <Descriptions.Item label="Billing contact">
                    {plan?.billingEmail ?? "—"}
                  </Descriptions.Item>
                  <Descriptions.Item label="Additional seats">
                    {plan?.additionalSeats ? usd(plan.additionalSeats) : "—"}
                  </Descriptions.Item>
                </Descriptions>
                {data.note && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {data.note}
                  </Text>
                )}
              </Card>
            </Col>
            <Col xs={24} lg={14}>
              <Card
                size="small"
                title="Included allowance boundaries"
                styles={{ body: { padding: 0 } }}
                extra={
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    vs plan thresholds from Vercel
                  </Text>
                }
              >
                {(analysis?.boundaries?.length ?? 0) > 0 ? (
                  <Table
                    rowKey="invoiceKey"
                    size="small"
                    pagination={false}
                    columns={boundaryColumns as never}
                    dataSource={analysis?.boundaries ?? []}
                  />
                ) : (
                  <div style={{ padding: 16 }}>
                    <Text type="secondary">
                      No metered service is close to its included allowance yet — nothing to
                      flag. (Only services with traffic this period appear here.)
                    </Text>
                  </div>
                )}
              </Card>
            </Col>
          </Row>

          <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
            <Col xs={24} lg={14}>
              <Card size="small" title="Daily usage charges (30 days)" styles={{ body: { padding: 16 } }}>
                {chartData.length > 0 ? (
                  <Column
                    data={chartData}
                    xField="date"
                    yField="cost"
                    height={260}
                    axis={{ x: { title: false }, y: { title: false } }}
                  />
                ) : (
                  <Text type="secondary">
                    No usage charges in the last 30 days — usage is inside the included
                    allowances.
                  </Text>
                )}
              </Card>
            </Col>
            <Col xs={24} lg={10}>
              <Card size="small" title="Usage by service" styles={{ body: { padding: 0 } }}>
                <Table
                  rowKey="service"
                  size="small"
                  pagination={false}
                  columns={serviceColumns}
                  dataSource={summary?.byService ?? []}
                />
              </Card>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}
