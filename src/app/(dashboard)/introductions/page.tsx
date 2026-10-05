"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Descriptions,
  Flex,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import Link from "next/link";

const { Title, Text } = Typography;

const COMPONENT_LABELS: Record<string, string> = {
  proximity: "Proximity",
  ai_correlation: "AI correlation",
  help_expertise: "Help/Expertise",
  goal_relevance: "90-day goal",
  connection_type: "Connection type",
  industry: "Industry",
  business_stage: "Business stage",
};

interface IndividualPartner {
  key: string;
  email: string;
  name: string | null;
  professionalHeadline: string | null;
  city: string | null;
  industry: string | null;
  businessStage: string | null;
}

interface IndividualProposal {
  success: boolean;
  code?: string;
  error?: string;
  target: IndividualPartner | null;
  partners: IndividualPartner[];
  groupScore: number | null;
  groupScoreBreakdown: Record<string, number> | null;
  cityCode: string | null;
  cityName: string | null;
  eligiblePoolSize: number;
}

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

  const [individualEmail, setIndividualEmail] = useState("");
  const [individualPreviewing, setIndividualPreviewing] = useState(false);
  const [individualProposal, setIndividualProposal] = useState<IndividualProposal | null>(null);
  const [individualCreating, setIndividualCreating] = useState(false);
  const [individualDeliveryMode, setIndividualDeliveryMode] = useState("production");
  const [individualConfirmOpen, setIndividualConfirmOpen] = useState(false);
  const [individualConfirmation, setIndividualConfirmation] = useState("");

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

  const previewIndividual = async () => {
    if (!individualEmail.trim()) return;
    setIndividualPreviewing(true);
    setIndividualProposal(null);
    try {
      const res = await fetch("/api/introductions/individual-match/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: individualEmail.trim() }),
      });
      const body = await res.json();
      setIndividualProposal(body as IndividualProposal);
    } catch (err) {
      message.error(`Preview failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setIndividualPreviewing(false);
    }
  };

  const createIndividual = async () => {
    setIndividualCreating(true);
    try {
      const res = await fetch("/api/introductions/individual-match/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: individualEmail.trim(), deliveryMode: individualDeliveryMode }),
      });
      const body = await res.json();
      if (!res.ok) {
        message.error(body.error ?? "Could not create individual introduction");
        return;
      }
      message.success(
        body.runId
          ? `Created (${body.deliveryCount} deliveries). The delivery worker will send it.`
          : "Created"
      );
      setIndividualProposal(null);
      setIndividualEmail("");
      setIndividualConfirmOpen(false);
      setIndividualConfirmation("");
      await load();
    } catch (err) {
      message.error(`Create failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setIndividualCreating(false);
    }
  };

  const requestCreate = () => {
    if (individualDeliveryMode === "production") {
      setIndividualConfirmOpen(true);
    } else {
      void createIndividual();
    }
  };

  const memberLine = (m: IndividualPartner) =>
    [m.name, m.professionalHeadline, m.industry, m.city].filter(Boolean).join(" · ");

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

      <Card size="small" title="Individual introduction">
        <Flex vertical gap={12}>
          <Text type="secondary">
            Match one person (paused or cancelled members included) with the two best-fitting
            active members from their city, using the same matching configuration.
          </Text>
          <Space wrap>
            <Input
              placeholder="member@example.com"
              value={individualEmail}
              onChange={(event) => setIndividualEmail(event.target.value)}
              onPressEnter={() => void previewIndividual()}
              style={{ width: 320 }}
            />
            <Button type="primary" loading={individualPreviewing} onClick={() => void previewIndividual()}>
              Preview match
            </Button>
          </Space>

          {individualProposal && !individualProposal.success && (
            <Alert
              type="error"
              showIcon
              message={individualProposal.error ?? individualProposal.code ?? "Could not match"}
            />
          )}

          {individualProposal?.success && individualProposal.target && (
            <Flex vertical gap={12}>
              <Alert
                type="info"
                showIcon
                message={`${individualProposal.cityName ?? "City"} · ${individualProposal.eligiblePoolSize} eligible member(s) available`}
              />
              <Space direction="vertical" size={4}>
                <Text strong>Person to introduce:</Text>
                <Text>
                  {individualProposal.target.name ?? "—"} <Text type="secondary">{individualProposal.target.email}</Text>
                </Text>
                <Text strong>Matched with:</Text>
                {individualProposal.partners.map((p) => (
                  <Text key={p.key}>
                    {memberLine(p)} <Text type="secondary">{p.email}</Text>
                  </Text>
                ))}
              </Space>
              <Space wrap>
                <Tag color="blue">Group score {individualProposal.groupScore ?? "—"}</Tag>
                {Object.entries(individualProposal.groupScoreBreakdown ?? {}).map(([component, score]) => (
                  <Tag key={component}>
                    {COMPONENT_LABELS[component] ?? component}: {Math.round((score as number) * 100)}
                  </Tag>
                ))}
              </Space>
              <Space wrap>
                <Select
                  value={individualDeliveryMode}
                  onChange={setIndividualDeliveryMode}
                  style={{ width: 160 }}
                  options={[
                    { value: "production", label: "Production" },
                    { value: "canary", label: "Canary" },
                    { value: "provider_test", label: "Provider test" },
                  ]}
                />
                <Button type="primary" danger loading={individualCreating} onClick={requestCreate}>
                  Create & send
                </Button>
              </Space>
            </Flex>
          )}
        </Flex>
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

      <Modal
        title="Confirm production send"
        open={individualConfirmOpen}
        onCancel={() => {
          setIndividualConfirmOpen(false);
          setIndividualConfirmation("");
        }}
        onOk={() => void createIndividual()}
        okText="Send"
        okButtonProps={{ disabled: individualConfirmation !== "SEND" }}
        confirmLoading={individualCreating}
      >
        <Flex vertical gap={12}>
          <Alert
            type="error"
            showIcon
            message="This will email real members. Type SEND to confirm."
          />
          <Input
            placeholder="SEND"
            value={individualConfirmation}
            onChange={(event) => setIndividualConfirmation(event.target.value)}
          />
        </Flex>
      </Modal>
    </Flex>
  );
}
