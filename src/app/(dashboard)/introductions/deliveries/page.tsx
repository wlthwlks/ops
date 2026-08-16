"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Descriptions, Flex, Select, Space, Table, Tag, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";

const { Title, Text } = Typography;

interface RunRow {
  id: string;
  cycleDate: string | null;
  status: string;
  deliveryMode: string;
  totalGroups: number | null;
  createdAt: string;
}

interface DeliveryRow {
  id: string;
  groupId: string;
  recipientEmail: string;
  recipientName: string | null;
  deliverToEmail: string;
  originalTo: string[] | null;
  status: string;
  resendMessageId: string | null;
  attemptCount: number;
  nextRetryAt: string | null;
  lastEventAt: string | null;
  error: string | null;
  sentAt: string | null;
}

interface EventRow {
  id: string;
  deliveryId: string;
  eventType: string;
  providerEventId: string;
  providerTs: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "default",
  processing: "processing",
  sent: "blue",
  delivered: "green",
  delayed: "orange",
  bounced: "red",
  complained: "red",
  suppressed: "red",
  failed: "red",
};

export default function IntroductionsDeliveriesPage() {
  const { message } = App.useApp();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/introductions/runs", { cache: "no-store" });
      const body = await res.json();
      setRuns(body.runs ?? []);
    } catch {
      message.error("Could not load runs");
    }
  }, [message]);

  const loadDeliveries = useCallback(
    async (runId: string) => {
      setLoading(true);
      try {
        const res = await fetch(`/api/introductions/deliveries?runId=${runId}`, {
          cache: "no-store",
        });
        const body = await res.json();
        setDeliveries(body.deliveries ?? []);
        setEvents(body.events ?? []);
      } catch {
        message.error("Could not load deliveries");
      } finally {
        setLoading(false);
      }
    },
    [message]
  );

  useEffect(() => {
    void loadRuns();
    const params = new URLSearchParams(window.location.search);
    const runId = params.get("runId");
    if (runId) {
      setSelectedRunId(runId);
      void loadDeliveries(runId);
    }
  }, [loadRuns, loadDeliveries]);

  const eventsByDelivery = new Map<string, EventRow[]>();
  for (const event of events) {
    const list = eventsByDelivery.get(event.deliveryId) ?? [];
    list.push(event);
    eventsByDelivery.set(event.deliveryId, list);
  }

  const redirected = deliveries.filter((d) => d.originalTo !== null).length;

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Title level={4} style={{ margin: 0 }}>
          Delivery History
        </Title>
        <Button icon={<ReloadOutlined />} onClick={() => selectedRunId && void loadDeliveries(selectedRunId)}>
          Refresh
        </Button>
      </Flex>

      <Flex gap={16} align="center">
        <Text strong>Run:</Text>
        <Select
          style={{ minWidth: 340 }}
          placeholder="Select a run"
          value={selectedRunId ?? undefined}
          onChange={(value) => {
            setSelectedRunId(value);
            void loadDeliveries(value);
          }}
          options={runs.map((run) => ({
            value: run.id,
            label: `${run.cycleDate ?? "?"} · ${run.status} · ${run.deliveryMode} · ${run.id.slice(0, 8)}`,
          }))}
        />
      </Flex>

      {redirected > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`${redirected} delivery(ies) are redirected to internal addresses. Original recipients are preserved for audit.`}
        />
      )}

      <Card size="small" title={`Deliveries (${deliveries.length})`}>
        <Table<DeliveryRow>
          rowKey="id"
          loading={loading}
          size="small"
          dataSource={deliveries}
          pagination={{ pageSize: 20 }}
          expandable={{
            expandedRowRender: (delivery) => {
              const deliveryEvents = eventsByDelivery.get(delivery.id) ?? [];
              if (deliveryEvents.length === 0) return <Text type="secondary">No provider events yet</Text>;
              return (
                <Table<EventRow>
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={deliveryEvents}
                  columns={[
                    { title: "Event", dataIndex: "eventType" },
                    { title: "Provider event id", dataIndex: "providerEventId", render: (v: string) => <Text code>{v}</Text> },
                    {
                      title: "At",
                      dataIndex: "providerTs",
                      render: (v: string | null) => (v ? new Date(v).toLocaleString() : "—"),
                    },
                  ]}
                />
              );
            },
          }}
          columns={[
            {
              title: "Recipient",
              dataIndex: "recipientEmail",
              render: (email: string, delivery) => (
                <Space direction="vertical" size={0}>
                  <Text strong>{email}</Text>
                  {delivery.recipientName && <Text type="secondary">{delivery.recipientName}</Text>}
                </Space>
              ),
            },
            {
              title: "Deliver to",
              dataIndex: "deliverToEmail",
              render: (email: string, delivery) =>
                delivery.originalTo ? (
                  <Space>
                    <Tag color="gold">{email}</Tag>
                    <Text type="secondary">original: {(delivery.originalTo ?? []).join(", ")}</Text>
                  </Space>
                ) : (
                  email
                ),
            },
            {
              title: "Status",
              dataIndex: "status",
              render: (status: string) => <Tag color={STATUS_COLORS[status] ?? "default"}>{status}</Tag>,
            },
            {
              title: "Resend id",
              dataIndex: "resendMessageId",
              render: (v: string | null) => (v ? <Text code>{v.slice(0, 12)}…</Text> : "—"),
            },
            { title: "Attempts", dataIndex: "attemptCount", width: 90 },
            {
              title: "Next retry",
              dataIndex: "nextRetryAt",
              width: 170,
              render: (v: string | null) => (v ? new Date(v).toLocaleString() : "—"),
            },
            {
              title: "Error",
              dataIndex: "error",
              ellipsis: true,
              render: (v: string | null) => (v ? <Text type="danger">{v}</Text> : "—"),
            },
          ]}
        />
      </Card>

      <Card size="small" title="Worker behaviour">
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="Claim model">
            Conditional UPDATE with a status guard — concurrent workers can never double-send.
          </Descriptions.Item>
          <Descriptions.Item label="Duplicate protection">
            Unique delivery keys in the database plus Resend idempotency keys per batch.
          </Descriptions.Item>
          <Descriptions.Item label="Retries">
            Transient failures retry with exponential backoff (max 5 attempts). Bounces,
            complaints and suppressions are never retried.
          </Descriptions.Item>
          <Descriptions.Item label="Recovery">
            Claims older than 10 minutes are reclaimed automatically; a crashed worker can
            never strand a city.
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </Flex>
  );
}
