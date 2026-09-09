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

type ResendBillingResponse = {
  success: boolean;
  fetchedAt?: string;
  plan?: string;
  limits?: {
    label: string;
    pricePerMonthUsd: number;
    dailyQuota: number | null;
    monthlyQuota: number | null;
    domainsLimit: number;
    overagePerThousandUsd: number | null;
  };
  totals?: {
    sentToday: number;
    sentThisMonth: number;
    delivered: number;
    bounced: number;
    complained: number;
    bounceRatePct: number;
    complaintRatePct: number;
  };
  domains?: { total: number; verified: number };
  estimatedMonthlyCostUsd?: number | null;
  flags?: Array<{ level: "info" | "warning" | "error"; title: string; message: string }>;
  series?: Array<{
    date: string;
    sent: number;
    delivered: number;
    bounced: number;
    complained: number;
  }>;
  note?: string;
  message?: string;
};

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const num = (n: number) => n.toLocaleString("en-US");

export default function ResendBillingPage() {
  const [data, setData] = useState<ResendBillingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotConfigured(false);
    try {
      const res = await fetch("/api/ops-dashboard/resend-billing");
      const json = (await res.json()) as ResendBillingResponse & { code?: string };
      if (!res.ok || json.success === false) {
        if (json.code === "RESEND_NOT_CONFIGURED") {
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

  const chartData = useMemo(() => {
    const rows = (data?.series ?? []).map((s) => ({
      date: s.date.slice(5),
      type: "Sent",
      value: s.sent,
    }));
    rows.push(
      ...(data?.series ?? []).map((s) => ({
        date: s.date.slice(5),
        type: "Bounced",
        value: s.bounced,
      }))
    );
    return rows;
  }, [data?.series]);

  const totals = data?.totals;
  const limits = data?.limits;

  const quotaColumns = [
    { title: "Limit", key: "limit" },
    { title: "Plan value", key: "value" },
  ];

  return (
    <div>
      <OpsPageHeader
        title="Resend Billing"
        description="Email volume vs plan quotas and account health thresholds from the Resend API. Resend does not expose billing data — plan pricing comes from configuration."
        scannedAt={data?.fetchedAt}
        onRefresh={load}
        refreshing={loading}
      />

      {notConfigured && (
        <ErrorState
          title="Resend API key not configured"
          message="Set RESEND_API_KEY (or RESEND_READ_API_KEY for read-only) to enable this tab."
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
                title="Emails today"
                value={num(totals?.sentToday ?? 0)}
                hint={
                  limits?.dailyQuota
                    ? `Daily quota ${num(limits.dailyQuota)}`
                    : "No daily quota on paid plans"
                }
                tooltip="Emails accepted by Resend today (UTC)."
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KpiCard
                title="Emails this month"
                value={num(totals?.sentThisMonth ?? 0)}
                hint={
                  limits?.monthlyQuota
                    ? `Included ${num(limits.monthlyQuota)}/month`
                    : "No monthly quota configured"
                }
                tooltip="Emails sent this calendar month vs the plan's included monthly quota."
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KpiCard
                title="Bounce rate"
                value={`${(totals?.bounceRatePct ?? 0).toFixed(2)}%`}
                status={(totals?.bounceRatePct ?? 0) >= 4 ? "danger" : (totals?.bounceRatePct ?? 0) >= 2 ? "warning" : "success"}
                hint="Sending pauses at 4%"
                tooltip="Bounced / sent this month. Resend pauses sending above 4%."
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KpiCard
                title="Complaint rate"
                value={`${(totals?.complaintRatePct ?? 0).toFixed(3)}%`}
                status={(totals?.complaintRatePct ?? 0) >= 0.08 ? "danger" : "success"}
                hint="Sending pauses at 0.08%"
                tooltip="Spam complaints / delivered this month. Resend pauses sending above 0.08%."
              />
            </Col>
          </Row>

          {(data.flags ?? []).map((flag) => (
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
              <Card size="small" title="Plan & limits" styles={{ body: { padding: 16 } }}>
                <Descriptions column={1} size="small" colon={false}>
                  <Descriptions.Item label="Plan">
                    <Tag color={(limits?.pricePerMonthUsd ?? 0) === 0 ? "default" : "green"}>
                      {limits?.label ?? data.plan ?? "?"}
                    </Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="Plan price">
                    {usd(limits?.pricePerMonthUsd ?? 0)}/month
                  </Descriptions.Item>
                  <Descriptions.Item label="Monthly quota">
                    {limits?.monthlyQuota ? num(limits.monthlyQuota) : "—"}
                  </Descriptions.Item>
                  <Descriptions.Item label="Daily quota">
                    {limits?.dailyQuota ? num(limits.dailyQuota) : "—"}
                  </Descriptions.Item>
                  <Descriptions.Item label="Overage">
                    {limits?.overagePerThousandUsd != null
                      ? `${usd(limits.overagePerThousandUsd)}/1,000 emails`
                      : "—"}
                  </Descriptions.Item>
                  <Descriptions.Item label="Domains">
                    {num(data.domains?.total ?? 0)}/{num(limits?.domainsLimit ?? 0)}
                  </Descriptions.Item>
                  <Descriptions.Item label="Estimated monthly cost">
                    <Text strong>{usd(data.estimatedMonthlyCostUsd ?? 0)}</Text>
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
              <Card size="small" title="Daily volume (30 days)" styles={{ body: { padding: 16 } }}>
                {chartData.length > 0 ? (
                  <Column
                    data={chartData}
                    xField="date"
                    yField="value"
                    seriesField="type"
                    stack
                    height={280}
                    axis={{ x: { title: false }, y: { title: false } }}
                  />
                ) : (
                  <Text type="secondary">No email volume in the last 30 days.</Text>
                )}
              </Card>
            </Col>
          </Row>

          <Card size="small" title="Quota status" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
            <Table
              rowKey="limit"
              size="small"
              pagination={false}
              columns={quotaColumns}
              dataSource={[
                {
                  key: "daily",
                  limit: "Daily quota",
                  value: limits?.dailyQuota
                    ? `${num(totals?.sentToday ?? 0)} / ${num(limits.dailyQuota)}`
                    : "No limit",
                },
                {
                  key: "monthly",
                  limit: "Monthly quota",
                  value: limits?.monthlyQuota
                    ? `${num(totals?.sentThisMonth ?? 0)} / ${num(limits.monthlyQuota)}`
                    : "No limit",
                },
                {
                  key: "domains",
                  limit: "Domains",
                  value: `${num(data.domains?.total ?? 0)} / ${num(limits?.domainsLimit ?? 0)}`,
                },
              ].map((row) => ({ limit: row.limit, value: row.value }))}
            />
          </Card>
        </>
      )}
    </div>
  );
}
