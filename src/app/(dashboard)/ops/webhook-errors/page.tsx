"use client";

import { useCallback, useEffect, useState } from "react";
import {
  App,
  Button,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { OpsPageHeader } from "@/components/ops/OpsPageHeader";
import { ErrorState } from "@/components/ops/ErrorState";

type ErrRow = {
  id: string;
  publicErrorCode: string;
  source: string;
  operation: string;
  severity: string;
  status: string;
  title: string;
  message: string;
  memberstackId: string | null;
  stripeCustomerId: string | null;
  airtableRecordId: string | null;
  webhookEventId: string | null;
  lastSeenAt: string;
};

export default function WebhookErrorsPage() {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ErrRow[]>([]);
  const [status, setStatus] = useState("open");
  const [source, setSource] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ status, pageSize: "100" });
      if (source) p.set("source", source);
      const res = await fetch(`/api/ops-dashboard/integration-errors?${p}`);
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || res.statusText);
      setRows(json.errors || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [status, source]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, action: "resolve" | "ignore") => {
    const res = await fetch("/api/ops-dashboard/integration-errors", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    const json = await res.json();
    if (!res.ok || json.success === false) {
      message.error(json.message || "Action failed");
      return;
    }
    message.success(action === "resolve" ? "Resolved" : "Ignored");
    void load();
  };

  const retryWebhook = async (webhookEventId: string | null | undefined) => {
    if (!webhookEventId) {
      message.warning("No linked webhook event on this error");
      return;
    }
    const res = await fetch(`/api/ops-dashboard/webhook-events/${webhookEventId}/retry`, {
      method: "POST",
    });
    const json = await res.json();
    if (!res.ok || json.success === false) {
      message.error(json.message || "Retry failed");
      return;
    }
    message.success(`Retry: ${json.status} — ${json.reason || ""}`);
    void load();
  };

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <OpsPageHeader
        title="Webhook & integration errors"
        description="Failures from Memberstack/Stripe webhooks and form Airtable sync. Matching and introductions are not modified by these systems."
        breadcrumbs={[
          { title: "System", href: "/ops" },
          { title: "Webhook errors" },
        ]}
        onRefresh={load}
        refreshing={loading}
      />

      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          value={status}
          style={{ width: 140 }}
          onChange={setStatus}
          options={[
            { value: "open", label: "Open" },
            { value: "resolved", label: "Resolved" },
            { value: "ignored", label: "Ignored" },
          ]}
        />
        <Select
          allowClear
          placeholder="Provider"
          style={{ width: 160 }}
          value={source}
          onChange={setSource}
          options={[
            { value: "stripe", label: "Stripe" },
            { value: "memberstack", label: "Memberstack" },
            { value: "update_details", label: "Update details" },
            { value: "cron", label: "Cron" },
          ]}
        />
      </Space>

      {error && <ErrorState message={error} onRetry={load} />}

      <Table
        size="small"
        loading={loading}
        rowKey="id"
        dataSource={rows}
        expandable={{
          expandedRowRender: (r) => (
            <Typography.Paragraph style={{ margin: 0 }}>{r.message}</Typography.Paragraph>
          ),
        }}
        columns={[
          {
            title: "Severity",
            dataIndex: "severity",
            width: 100,
            render: (v: string) => (
              <Tag color={v === "critical" ? "red" : v === "warning" ? "orange" : "default"}>
                {v}
              </Tag>
            ),
          },
          { title: "Code", dataIndex: "publicErrorCode", width: 200 },
          { title: "Source", dataIndex: "source", width: 120 },
          { title: "Title", dataIndex: "title" },
          {
            title: "IDs",
            render: (_, r) =>
              [r.memberstackId, r.stripeCustomerId, r.airtableRecordId]
                .filter(Boolean)
                .join(" · ") || "—",
          },
          {
            title: "Actions",
            width: 260,
            render: (_, r) => (
              <Space wrap>
                {r.webhookEventId && (
                  <Button size="small" onClick={() => void retryWebhook(r.webhookEventId)}>
                    Retry webhook
                  </Button>
                )}
                {r.status === "open" ? (
                  <>
                    <Button size="small" onClick={() => void act(r.id, "resolve")}>
                      Resolve
                    </Button>
                    <Button size="small" onClick={() => void act(r.id, "ignore")}>
                      Ignore
                    </Button>
                  </>
                ) : (
                  <Tag>{r.status}</Tag>
                )}
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
}
