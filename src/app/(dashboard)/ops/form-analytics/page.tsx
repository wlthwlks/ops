"use client";

import { useCallback, useEffect, useState } from "react";
import { Col, Row, Table } from "antd";
import { OpsPageHeader } from "@/components/ops/OpsPageHeader";
import { KpiCard } from "@/components/ops/KpiCard";
import { ErrorState } from "@/components/ops/ErrorState";

export default function FormAnalyticsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kpis, setKpis] = useState<Record<string, number | null>>({});
  const [recent, setRecent] = useState<Array<Record<string, unknown>>>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ops-dashboard/form-analytics");
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || res.statusText);
      setKpis(json.kpis || {});
      setRecent(json.recent || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <OpsPageHeader
        title="Form analytics"
        description="Signup funnel foundation (Tally replacement metrics). Requires NEW_FORM_ANALYTICS_ENABLED."
        breadcrumbs={[
          { title: "System", href: "/ops" },
          { title: "Form analytics" },
        ]}
        onRefresh={load}
        refreshing={loading}
      />

      {error && <ErrorState message={error} onRetry={load} />}

      <Row gutter={[12, 12]} style={{ marginBottom: 24 }}>
        <Col xs={12} md={6}>
          <KpiCard title="Form views" value={kpis.formViews ?? 0} />
        </Col>
        <Col xs={12} md={6}>
          <KpiCard title="Accounts started" value={kpis.accountStarted ?? 0} />
        </Col>
        <Col xs={12} md={6}>
          <KpiCard title="Checkouts started" value={kpis.checkoutStarted ?? 0} />
        </Col>
        <Col xs={12} md={6}>
          <KpiCard
            title="Completed"
            value={kpis.onboardingCompleted ?? 0}
            hint={
              kpis.completionRate != null
                ? `${kpis.completionRate}% completion`
                : undefined
            }
          />
        </Col>
      </Row>

      <Table
        size="small"
        loading={loading}
        rowKey={(r) => String(r.id)}
        dataSource={recent}
        columns={[
          { title: "Event", dataIndex: "eventType" },
          { title: "Stage", dataIndex: "stage" },
          { title: "UTM source", dataIndex: "utmSource" },
          { title: "Campaign", dataIndex: "utmCampaign" },
          {
            title: "When",
            dataIndex: "createdAt",
            render: (v) => (v ? new Date(String(v)).toLocaleString() : "—"),
          },
        ]}
      />
    </div>
  );
}
