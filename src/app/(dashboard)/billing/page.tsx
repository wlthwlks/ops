"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Col, Row, Spin, Table, Tag, Typography, Descriptions, Alert } from "antd";
import dynamic from "next/dynamic";
import { OpsPageHeader } from "@/components/ops/OpsPageHeader";
import { KpiCard } from "@/components/ops/KpiCard";
import { ErrorState } from "@/components/ops/ErrorState";

const { Text } = Typography;

const Column = dynamic(() => import("@ant-design/charts").then((m) => m.Column), {
  ssr: false,
  loading: () => <Spin />,
});

type ProjectRow = {
  id: string;
  name: string;
  envLabel: string;
  isCurrentEnv: boolean;
  regionId: string | null;
  pgVersion: number | null;
  createdAt: string | null;
  cost: {
    computeCuHours: number;
    rootStorageGbMonths: number;
    childStorageGbMonths: number;
    instantRestoreGbMonths: number;
    snapshotGbMonths: number;
    publicTransferGb: number;
    billablePublicTransferGb: number;
    billableExtraBranchMonths: number;
    computeCost: number;
    storageCost: number;
    transferCost: number;
    extraBranchCost: number;
    totalCost: number;
  } | null;
  freeUsage: {
    computeCuHours: number;
    storageGbMonths: number;
    transferGb: number;
  } | null;
  latestHourUsage: { computeCuHours: number; storageGbMonths: number } | null;
};

type NeonBillingResponse = {
  success: boolean;
  fetchedAt?: string;
  org?: { id: string; name: string; plan: string };
  plan?: string;
  environment?: string | null;
  rates?: Record<string, number | string>;
  projects?: ProjectRow[];
  totals?: {
    usage: {
      computeCuHours: number;
      rootStorageGbMonths: number;
      childStorageGbMonths: number;
      instantRestoreGbMonths: number;
      snapshotGbMonths: number;
      publicTransferGb: number;
      extraBranchMonths: number;
    };
    computeCost: number;
    storageCost: number;
    instantRestoreCost: number;
    snapshotCost: number;
    extraBranchCost: number;
    transferCost: number;
    totalCost: number;
  };
  series?: Array<{
    date: string;
    projectId: string;
    envLabel: string;
    computeCuHours: number;
    storageGbMonths: number;
    estimatedCost: number;
  }>;
  freePlanNote?: string | null;
  message?: string;
};

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const num = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const ENV_COLOR: Record<string, string> = { Production: "blue", Preview: "gold" };

export default function NeonBillingPage() {
  const [data, setData] = useState<NeonBillingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotConfigured(false);
    try {
      const res = await fetch("/api/ops-dashboard/neon-billing");
      const json = (await res.json()) as NeonBillingResponse & { code?: string };
      if (!res.ok || json.success === false) {
        if (json.code === "NEON_NOT_CONFIGURED") {
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
      (data?.series ?? []).map((s) => ({
        date: s.date.slice(5),
        envLabel: s.envLabel,
        estimatedCost: Number(s.estimatedCost.toFixed(4)),
      })),
    [data?.series]
  );

  const totals = data?.totals;
  const totalCost = totals?.totalCost ?? 0;
  const isFree = (data?.plan ?? "") === "free";

  const projectColumns = [
    {
      title: "Environment",
      dataIndex: "envLabel",
      key: "envLabel",
      render: (label: string, row: ProjectRow) => (
        <span>
          <Tag color={ENV_COLOR[label] || "default"}>{label}</Tag>
          {row.isCurrentEnv && <Tag color="geekblue">this env</Tag>}
        </span>
      ),
    },
    {
      title: "Project",
      dataIndex: "name",
      key: "name",
      render: (name: string, row: ProjectRow) => (
        <span>
          <Text strong>{name}</Text>
          <div style={{ fontSize: 12, color: "rgba(0,0,0,0.45)" }}>{row.id}</div>
        </span>
      ),
    },
    { title: "Region", dataIndex: "regionId", key: "regionId" },
    {
      title: "Postgres",
      dataIndex: "pgVersion",
      key: "pgVersion",
      render: (v: number | null) => (v ? `v${v}` : "—"),
    },
    {
      title: "Compute (CU-hrs)",
      key: "compute",
      render: (_: unknown, row: ProjectRow) =>
        row.cost ? num(row.cost.computeCuHours, 1) : num(row.freeUsage?.computeCuHours ?? 0, 1),
    },
    {
      title: "Storage (GB-mo)",
      key: "storage",
      render: (_: unknown, row: ProjectRow) =>
        row.cost
          ? num(row.cost.rootStorageGbMonths + row.cost.childStorageGbMonths)
          : num(row.freeUsage?.storageGbMonths ?? 0),
    },
    {
      title: "Egress (GB)",
      key: "egress",
      render: (_: unknown, row: ProjectRow) =>
        row.cost ? num(row.cost.publicTransferGb) : num(row.freeUsage?.transferGb ?? 0),
    },
    {
      title: "Last 24h compute",
      key: "last24",
      render: (_: unknown, row: ProjectRow) =>
        row.latestHourUsage ? `${num(row.latestHourUsage.computeCuHours, 1)} CU-hrs` : "—",
    },
    {
      title: "Est. cost",
      key: "cost",
      align: "right" as const,
      render: (_: unknown, row: ProjectRow) => (
        <Text strong>{row.cost ? usd(row.cost.totalCost) : usd(0)}</Text>
      ),
    },
    {
      title: "Share",
      key: "share",
      align: "right" as const,
      render: (_: unknown, row: ProjectRow) => {
        const c = row.cost?.totalCost ?? 0;
        if (totalCost <= 0) return "—";
        return `${num((c / totalCost) * 100, 0)}%`;
      },
    },
  ];

  return (
    <div>
      <OpsPageHeader
        title="Neon Database Billing"
        description="Estimated Neon spend across all projects in our organization (production + preview), calculated from the Neon consumption API and the published plan rate card."
        scannedAt={data?.fetchedAt}
        onRefresh={load}
        refreshing={loading}
      />

      {notConfigured && (
        <ErrorState
          title="Neon API key not configured"
          message="Add NEON_API_KEY (org-scoped, from the Neon Console → Account settings → API keys) to the environment to enable this tab."
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
                title="Estimated total spend"
                value={usd(totalCost)}
                hint={`${data.org?.name ?? "Org"} · ${data.plan ?? "?"} plan · ${data.environment ?? ""}`}
                tooltip="Sum of estimated production + preview costs for the current billing period, computed from Neon consumption metrics multiplied by the plan rate card. Not an invoice."
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KpiCard
                title="Compute usage"
                value={`${num(totals?.usage.computeCuHours ?? 0, 1)} CU-hrs`}
                hint={
                  isFree
                    ? "Free plan allowance: 100 CU-hrs/project"
                    : `${usd((totals?.computeCost ?? 0) + (totals?.extraBranchCost ?? 0))} compute + extra branches`
                }
                tooltip="Compute Unit hours (1 CU ≈ 4 GB RAM) across all projects this billing period."
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KpiCard
                title="Storage usage"
                value={`${num(
                  (totals?.usage.rootStorageGbMonths ?? 0) +
                    (totals?.usage.childStorageGbMonths ?? 0) +
                    (totals?.usage.instantRestoreGbMonths ?? 0),
                  1
                )} GB-mo`}
                hint={
                  isFree
                    ? "Free plan allowance: 0.5 GB/project"
                    : `${usd((totals?.storageCost ?? 0) + (totals?.instantRestoreCost ?? 0) + (totals?.snapshotCost ?? 0))} storage + history`
                }
                tooltip="Branch storage + instant-restore history in GB-months (billing month = 744 hours)."
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KpiCard
                title="Public egress"
                value={`${num(totals?.usage.publicTransferGb ?? 0, 1)} GB`}
                hint={`${usd(totals?.transferCost ?? 0)} · 500 GB/project included on paid plans`}
                tooltip="Outbound data transfer over the public network this billing period."
              />
            </Col>
          </Row>

          {data.freePlanNote && (
            <Alert
              type="info"
              showIcon
              message={data.freePlanNote}
              style={{ marginBottom: 16 }}
            />
          )}

          <Row gutter={[16, 16]}>
            <Col xs={24} lg={10}>
              <Card size="small" title="Plan" styles={{ body: { padding: 16 } }}>
                <Descriptions column={1} size="small" colon={false}>
                  <Descriptions.Item label="Organization">
                    {data.org?.name}
                  </Descriptions.Item>
                  <Descriptions.Item label="Plan">
                    <Tag color={isFree ? "default" : "green"}>
                      {(data.plan ?? "?").toUpperCase()}
                    </Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="Compute rate">
                    {usd(Number(data.rates?.computePerCuHour ?? 0))} / CU-hr
                  </Descriptions.Item>
                  <Descriptions.Item label="Storage rate">
                    {usd(Number(data.rates?.storagePerGbMonth ?? 0))} / GB-mo
                  </Descriptions.Item>
                  <Descriptions.Item label="PITR history rate">
                    {usd(Number(data.rates?.instantRestorePerGbMonth ?? 0))} / GB-mo
                  </Descriptions.Item>
                  <Descriptions.Item label="Egress allowance">
                    {Number(data.rates?.publicTransferIncludedGb ?? 0) >= 1e9
                      ? "Unlimited (free plan)"
                      : `${data.rates?.publicTransferIncludedGb ?? 0} GB/project, then ${usd(
                          Number(data.rates?.publicTransferPerGb ?? 0)
                        )}/GB`}
                  </Descriptions.Item>
                  <Descriptions.Item label="Branches included">
                    {data.rates?.includedBranchesPerProject ?? 0}/project
                  </Descriptions.Item>
                </Descriptions>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Costs are estimates from Neon consumption metrics × published rates —
                  not an invoice. Rates come from neon.com/docs/introduction/plans and can be
                  overridden with NEON_RATE_CARD_JSON.
                </Text>
              </Card>
            </Col>
            <Col xs={24} lg={14}>
              <Card
                size="small"
                title="Daily estimated cost (30 days, stacked)"
                styles={{ body: { padding: 16 } }}
              >
                {chartData.length > 0 ? (
                  <Column
                    data={chartData}
                    xField="date"
                    yField="estimatedCost"
                    seriesField="envLabel"
                    stack
                    height={280}
                    axis={{ x: { title: false }, y: { title: false } }}
                  />
                ) : (
                  <Text type="secondary">No consumption data yet for the last 30 days.</Text>
                )}
              </Card>
            </Col>
          </Row>

          <Card
            size="small"
            title="Projects"
            style={{ marginTop: 16 }}
            styles={{ body: { padding: 0 } }}
          >
            <Table<ProjectRow>
              rowKey="id"
              columns={projectColumns}
              dataSource={data.projects ?? []}
              pagination={false}
              size="small"
            />
          </Card>
        </>
      )}
    </div>
  );
}
