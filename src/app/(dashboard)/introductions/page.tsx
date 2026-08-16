"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, App, Badge, Button, Card, Descriptions, Flex, Table, Tag, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import Link from "next/link";

const { Title, Text } = Typography;

interface RunRow {
  id: string;
  cycleDate: string | null;
  cityCodesJson: string | null;
  deliveryMode: string;
  status: string;
  totalGroups: number | null;
  totalDeliveries: number | null;
  planHash: string | null;
  createdAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  planned: "default",
  approved: "blue",
  sending: "processing",
  completed: "green",
  partial: "orange",
  failed: "red",
  cancelled: "default",
  expired: "default",
};

const MODE_TAG: Record<string, { color: string; label: string }> = {
  simulation: { color: "default", label: "Simulation" },
  provider_test: { color: "orange", label: "Provider test" },
  canary: { color: "gold", label: "Canary" },
  production: { color: "red", label: "Production" },
};

export default function IntroductionsOverviewPage() {
  const { message } = App.useApp();
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [configRes, runsRes] = await Promise.all([
        fetch("/api/introductions/config", { cache: "no-store" }),
        fetch("/api/introductions/runs", { cache: "no-store" }),
      ]);
      if (configRes.ok) {
        const configBody = await configRes.json();
        setConfig(configBody);
      }
      if (runsRes.ok) {
        const runsBody = await runsRes.json();
        setRuns(runsBody.runs ?? []);
      }
    } catch (err) {
      message.error(`Could not load introductions overview: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const cfg = (config?.config ?? {}) as {
    senderFrom?: string;
    canaryEmails?: string[];
    providerTestEmails?: string[];
    defaultProfileId?: string | null;
    defaultTemplateId?: string | null;
  };
  const configured = (config?.configured ?? {}) as Record<string, boolean>;

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Title level={4} style={{ margin: 0 }}>
          Unified Introduction Engine
        </Title>
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          Refresh
        </Button>
      </Flex>

      {config && (
        <Alert
          type={config?.readOnly ? "info" : "warning"}
          showIcon
          message={
            config?.readOnly
              ? "Introductions are in read-only mode. Previews and plan editing work; no emails are sent."
              : "Introductions are LIVE. Approved production plans will send real emails."
          }
        />
      )}

      <Flex gap={16} wrap>
        <Card size="small" title="Sender" style={{ minWidth: 280 }}>
          <Text code>{cfg.senderFrom ?? "—"}</Text>
        </Card>
        <Card size="small" title="Canary addresses" style={{ minWidth: 280 }}>
          {(cfg.canaryEmails ?? []).map((email) => (
            <Tag key={email} color="gold">
              {email}
            </Tag>
          ))}
          {(cfg.canaryEmails ?? []).length === 0 && <Text type="secondary">Not configured</Text>}
        </Card>
        <Card size="small" title="Provider-test addresses" style={{ minWidth: 280 }}>
          {(cfg.providerTestEmails ?? []).map((email) => (
            <Tag key={email} color="orange">
              {email}
            </Tag>
          ))}
          {(cfg.providerTestEmails ?? []).length === 0 && <Text type="secondary">Not configured</Text>}
        </Card>
        <Card size="small" title="Integrations" style={{ minWidth: 300 }}>
          <Flex gap={8} wrap>
            {Object.entries(configured).map(([key, present]) => (
              <Badge key={key} status={present ? "success" : "error"} text={key} />
            ))}
          </Flex>
        </Card>
      </Flex>

      <Card size="small" title="Recent runs">
        <Table<RunRow>
          rowKey="id"
          loading={loading}
          dataSource={runs}
          pagination={{ pageSize: 10 }}
          size="small"
          columns={[
            {
              title: "Run",
              dataIndex: "id",
              render: (id: string) => (
                <Link href={`/introductions/city-runs?runId=${id}`}>
                  <Text code>{id.slice(0, 8)}…</Text>
                </Link>
              ),
            },
            { title: "Cycle", dataIndex: "cycleDate", width: 110 },
            {
              title: "City",
              dataIndex: "cityCodesJson",
              render: (raw: string | null) => {
                try {
                  return (JSON.parse(raw ?? "[]") as string[]).join(", ") || "—";
                } catch {
                  return "—";
                }
              },
            },
            {
              title: "Mode",
              dataIndex: "deliveryMode",
              render: (mode: string) => {
                const tag = MODE_TAG[mode] ?? MODE_TAG.simulation;
                return <Tag color={tag.color}>{tag.label}</Tag>;
              },
            },
            {
              title: "Status",
              dataIndex: "status",
              render: (status: string) => <Tag color={STATUS_COLORS[status] ?? "default"}>{status}</Tag>,
            },
            { title: "Groups", dataIndex: "totalGroups", width: 80 },
            { title: "Deliveries", dataIndex: "totalDeliveries", width: 100 },
            {
              title: "Created",
              dataIndex: "createdAt",
              width: 180,
              render: (value: string) => new Date(value).toLocaleString(),
            },
          ]}
        />
      </Card>

      <Card size="small" title="Quick start">
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="Preview a city">
            <Link href="/introductions/city-runs">City Runs</Link> → pick a city → Preview → review
            groups and score breakdowns.
          </Descriptions.Item>
          <Descriptions.Item label="Approve & send">
            Freeze the plan with a delivery mode. Production requires live mode and typed
            confirmation; canary/provider-test modes redirect to internal addresses.
          </Descriptions.Item>
          <Descriptions.Item label="Configure weights">
            <Link href="/introductions/settings">Matching Settings</Link> → create a versioned
            matching profile with normalized weights.
          </Descriptions.Item>
          <Descriptions.Item label="Edit email">
            <Link href="/introductions/templates">Email Templates</Link> → edit, preview, publish
            and restore versions.
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </Flex>
  );
}
