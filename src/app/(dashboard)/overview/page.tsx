"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Card, Col, Row, Spin, Table, Typography } from "antd";
import dynamic from "next/dynamic";
import { OpsPageHeader } from "@/components/ops/OpsPageHeader";
import { KpiCard } from "@/components/ops/KpiCard";
import { IntegrationHealthCard } from "@/components/ops/IntegrationHealthCard";
import { ErrorState } from "@/components/ops/ErrorState";
import { SectionHelpTooltip } from "@/components/ops/MetricHelpTooltip";
import {
  OVERVIEW_FUNNEL_TOOLTIPS,
  OVERVIEW_KPI_TOOLTIPS,
  OVERVIEW_SECTION_TOOLTIPS,
} from "@/lib/ops/overview-tooltips";

const Column = dynamic(
  () => import("@ant-design/charts").then((m) => m.Column),
  { ssr: false, loading: () => <Spin /> }
);

type SummaryResponse = {
  success: boolean;
  summary?: {
    scannedAt: string;
    withServiceAccess: number;
    fullyConnected: number;
    payingMissingSlack: number;
    payingStripeMissingAirtable: number;
    missingStripeCustomerId: number;
    criticalIssues: number;
    channelGaps: number;
    failedOperations24h?: number;
    integrations: Array<{
      name: string;
      status: string;
      configured: boolean;
      checked: boolean;
      message: string;
    }>;
    mode: string;
    partial: boolean;
    warnings: string[];
  };
  criticalIssues?: Array<{
    airtableRecordId: string | null;
    name: string;
    email: string;
    city: string;
    issues: string[];
    recommendedNextAction: string;
  }>;
  funnel?: Record<string, number>;
  message?: string;
};

export default function OverviewPage() {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ops-dashboard/summary");
      const json = (await res.json()) as SummaryResponse;
      if (!res.ok || json.success === false) {
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

  const s = data?.summary;
  const funnelData = data?.funnel
    ? [
        {
          stage: "Service eligible",
          value: data.funnel.serviceEligible || 0,
          tip: OVERVIEW_FUNNEL_TOOLTIPS.serviceEligible,
        },
        {
          stage: "In Airtable",
          value: data.funnel.inAirtable || 0,
          tip: OVERVIEW_FUNNEL_TOOLTIPS.inAirtable,
        },
        {
          stage: "Stripe linked",
          value: data.funnel.stripeLinked || 0,
          tip: OVERVIEW_FUNNEL_TOOLTIPS.stripeLinked,
        },
        {
          stage: "Slack resolved",
          value: data.funnel.slackResolved || 0,
          tip: OVERVIEW_FUNNEL_TOOLTIPS.slackResolved,
        },
        {
          stage: "Fully connected",
          value: data.funnel.fullyConnected || 0,
          tip: OVERVIEW_FUNNEL_TOOLTIPS.fullyConnected,
        },
      ]
    : [];

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <OpsPageHeader
        title="Operations Overview"
        description="Current member health across Airtable, Stripe and Slack."
        breadcrumbs={[{ title: "Overview" }]}
        mode={s?.mode}
        scannedAt={s?.scannedAt}
        onRefresh={load}
        refreshing={loading}
      />

      {error && <ErrorState message={error} onRetry={load} />}
      {loading && !s && (
        <div style={{ textAlign: "center", padding: 48 }}>
          <Spin size="large" />
        </div>
      )}

      {s && (
        <>
          {s.partial && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              title={
                <span>
                  Partial scan{" "}
                  <SectionHelpTooltip
                    title="Partial scan"
                    content={OVERVIEW_SECTION_TOOLTIPS.partialScan}
                  />
                </span>
              }
              description={
                s.warnings?.length
                  ? s.warnings.join(" · ")
                  : "Some integrations were not fully checked."
              }
            />
          )}
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title="Stripe does not create Airtable members from this dashboard"
            description="Paying Stripe customers missing Airtable must be fixed via Memberstack → Make, or the one-time historical CLI repair. The invoice.paid webhook never creates Members."
          />

          <Row gutter={[12, 12]} style={{ marginBottom: 20 }}>
            <Col xs={24} sm={12} md={8} lg={6}>
              <KpiCard
                title="Service access"
                value={s.withServiceAccess}
                href="/members?serviceAccess=current&page=1&pageSize=100"
                status="success"
                tooltip={OVERVIEW_KPI_TOOLTIPS.serviceAccess}
              />
            </Col>
            <Col xs={24} sm={12} md={8} lg={6}>
              <KpiCard
                title="Fully connected"
                value={s.fullyConnected}
                href="/members?page=1&pageSize=100"
                status="success"
                tooltip={OVERVIEW_KPI_TOOLTIPS.fullyConnected}
              />
            </Col>
            <Col xs={24} sm={12} md={8} lg={6}>
              <KpiCard
                title="Paying missing Slack"
                value={s.payingMissingSlack}
                href="/members/slack-access?tab=needs"
                status={s.payingMissingSlack ? "danger" : "default"}
                tooltip={OVERVIEW_KPI_TOOLTIPS.payingMissingSlack}
              />
            </Col>
            <Col xs={24} sm={12} md={8} lg={6}>
              <KpiCard
                title="Stripe missing Airtable"
                value={s.payingStripeMissingAirtable}
                href="/members/billing?tab=missing-airtable"
                status={s.payingStripeMissingAirtable ? "danger" : "default"}
                hint="Requires billing scan / CLI"
                tooltip={OVERVIEW_KPI_TOOLTIPS.payingStripeMissingAirtable}
              />
            </Col>
            <Col xs={24} sm={12} md={8} lg={6}>
              <KpiCard
                title="Missing Stripe Customer ID"
                value={s.missingStripeCustomerId}
                href="/members/billing?tab=missing-links"
                status={s.missingStripeCustomerId ? "warning" : "default"}
                tooltip={OVERVIEW_KPI_TOOLTIPS.missingStripeCustomerId}
              />
            </Col>
            <Col xs={24} sm={12} md={8} lg={6}>
              <KpiCard
                title="Critical issues"
                value={s.criticalIssues}
                href="/members/issues?category=critical"
                status={s.criticalIssues ? "danger" : "default"}
                tooltip={OVERVIEW_KPI_TOOLTIPS.criticalIssues}
              />
            </Col>
            <Col xs={24} sm={12} md={8} lg={6}>
              <KpiCard
                title="Channel gaps"
                value={s.channelGaps}
                href="/members/slack-access?tab=channels"
                status={s.channelGaps ? "warning" : "default"}
                hint="Run channel scan for accuracy"
                tooltip={OVERVIEW_KPI_TOOLTIPS.channelGaps}
              />
            </Col>
            <Col xs={24} sm={12} md={8} lg={6}>
              <KpiCard
                title="Failed ops (24h)"
                value={s.failedOperations24h ?? 0}
                href="/ops"
                status={(s.failedOperations24h ?? 0) > 0 ? "danger" : "default"}
                tooltip={OVERVIEW_KPI_TOOLTIPS.failedOps24h}
              />
            </Col>
          </Row>

          <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
            <Col xs={24} lg={14}>
              <Card
                size="small"
                title={
                  <span>
                    Coverage funnel{" "}
                    <SectionHelpTooltip
                      title="Coverage funnel"
                      content={OVERVIEW_FUNNEL_TOOLTIPS.section}
                    />
                  </span>
                }
              >
                {funnelData.length > 0 ? (
                  <>
                    <Column
                      data={funnelData}
                      xField="stage"
                      yField="value"
                      height={280}
                      label={{ text: "value", style: { fill: "#000" } }}
                      axis={{ x: { title: false }, y: { title: false } }}
                    />
                    <div style={{ marginTop: 8, fontSize: 12, color: "rgba(0,0,0,0.55)" }}>
                      {funnelData.map((f) => (
                        <div key={f.stage} style={{ marginBottom: 4 }}>
                          <strong>{f.stage}</strong>{" "}
                          <SectionHelpTooltip title={f.stage} content={f.tip} />
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <Typography.Text type="secondary">No funnel data</Typography.Text>
                )}
              </Card>
            </Col>
            <Col xs={24} lg={10}>
              <Card
                size="small"
                title={
                  <span>
                    Integration health{" "}
                    <SectionHelpTooltip
                      title="Integration health"
                      content={OVERVIEW_SECTION_TOOLTIPS.integrationHealth}
                    />
                  </span>
                }
              >
                <Row gutter={[8, 8]}>
                  {(s.integrations || []).map((item) => (
                    <Col span={24} key={item.name}>
                      <IntegrationHealthCard item={item as never} />
                    </Col>
                  ))}
                </Row>
              </Card>
            </Col>
          </Row>

          <Card
            size="small"
            title={
              <span>
                Critical issues{" "}
                <SectionHelpTooltip
                  title="Critical issues"
                  content={OVERVIEW_SECTION_TOOLTIPS.criticalIssues}
                />
              </span>
            }
          >
            <Table
              size="small"
              rowKey={(r) => `${r.airtableRecordId}-${r.issues.join(",")}`}
              dataSource={data?.criticalIssues || []}
              pagination={{ pageSize: 10 }}
              locale={{ emptyText: "No critical issues detected in this scan." }}
              columns={[
                { title: "Member", dataIndex: "name" },
                { title: "Email", dataIndex: "email" },
                { title: "City", dataIndex: "city", width: 120 },
                {
                  title: "Issues",
                  dataIndex: "issues",
                  render: (v: string[]) => v.join(", "),
                },
                { title: "Next action", dataIndex: "recommendedNextAction" },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
