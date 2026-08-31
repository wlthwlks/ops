"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Flex,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { EyeOutlined, LockOutlined, ReloadOutlined, SendOutlined, ThunderboltOutlined, UnlockOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";

const { Title, Text } = Typography;

interface CityRow {
  cityCode: string;
  cityName: string | null;
  activeMemberCount: number | null;
  enabled: boolean;
  schedulingMode: string;
  repeatPairDays: number | null;
  targetGroupSize: number | null;
}

interface RunRow {
  id: string;
  cycleDate: string | null;
  status: string;
  deliveryMode: string;
  totalGroups: number | null;
  createdAt: string;
}

interface Member {
  key: string;
  email: string;
  name: string | null;
  professionalHeadline: string | null;
  city: string | null;
  industry: string | null;
  businessStage: string | null;
  alternatives: Array<{ key: string; overall: number; breakdown: Record<string, number> }>;
}

interface GroupRow {
  id: string;
  locked: boolean;
  overallScore: number | null;
  scoreBreakdown: Record<string, number> | null;
  members: Member[];
}

interface Report {
  deliveryMode: string;
  safety: { level: string; label: string; description: string };
  eligibleMembers: number;
  matchedMembers: number;
  unmatchedMembers: number;
  unmatchedMemberDetails: Array<{ email: string; reason: string }>;
  groups: number;
  deliveries: number;
  duplicateMembers: string[];
  invalidEmails: string[];
  renderedEmails: number;
  recipientCount: number;
  canaryRedirectCount: number;
  validationFailures: string[];
  queue: { batchSize: number; batches: number; workerTicks: number };
  minEligibleMembers: number;
  blockedReason: string | null;
  groupSizes: { target: number; min: number; max: number; strict: boolean } | null;
}

const COMPONENT_LABELS: Record<string, string> = {
  proximity: "Proximity",
  ai_correlation: "AI correlation",
  help_expertise: "Help/Expertise",
  goal_relevance: "90-day goal",
  connection_type: "Connection type",
  industry: "Industry",
  business_stage: "Business stage",
};

export default function CityRunsPage() {
  const { message } = App.useApp();
  const [cities, setCities] = useState<CityRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loadingCities, setLoadingCities] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewCity, setPreviewCity] = useState<string | null>(null);
  const [previewDate, setPreviewDate] = useState<Dayjs>(dayjs());
  const [previewMode, setPreviewMode] = useState<string>("simulation");
  const [previewLoading, setPreviewLoading] = useState(false);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [runMeta, setRunMeta] = useState<RunRow | null>(null);
  const [planLoading, setPlanLoading] = useState(false);

  const [approveOpen, setApproveOpen] = useState(false);
  const [approveMode, setApproveMode] = useState<string>("simulation");
  const [approveConfirmation, setApproveConfirmation] = useState("");
  const [approveLoading, setApproveLoading] = useState(false);
  const [schedulerLoading, setSchedulerLoading] = useState(false);

  const loadCities = useCallback(async () => {
    setLoadingCities(true);
    try {
      const res = await fetch("/api/introductions/cities", { cache: "no-store" });
      const body = await res.json();
      setCities((body.cities ?? []).filter((c: CityRow) => c.cityName));
    } catch {
      message.error("Could not load cities");
    } finally {
      setLoadingCities(false);
    }
  }, [message]);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/introductions/runs", { cache: "no-store" });
      const body = await res.json();
      setRuns(body.runs ?? []);
    } catch {
      message.error("Could not load runs");
    }
  }, [message]);

  const loadPlan = useCallback(
    async (runId: string) => {
      setPlanLoading(true);
      try {
        const [detailRes, reportRes] = await Promise.all([
          fetch(`/api/introductions/runs/${runId}`, { cache: "no-store" }),
          fetch(`/api/introductions/runs/${runId}/simulation`, { cache: "no-store" }),
        ]);
        const detail = await detailRes.json();
        const reportBody = await reportRes.json();
        setGroups(detail.groups ?? []);
        setRunMeta(detail.run ?? null);
        setReport(reportBody.report ?? null);
      } catch {
        message.error("Could not load the plan");
      } finally {
        setPlanLoading(false);
      }
    },
    [message]
  );

  useEffect(() => {
    void loadCities();
    void loadRuns();
    const params = new URLSearchParams(window.location.search);
    const runId = params.get("runId");
    if (runId) {
      setSelectedRunId(runId);
      void loadPlan(runId);
    }
  }, [loadCities, loadRuns, loadPlan]);

  const runPreview = async () => {
    if (!previewCity) return;
    setPreviewLoading(true);
    try {
      const res = await fetch("/api/introductions/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cityCode: previewCity,
          cycleDate: previewDate.format("YYYY-MM-DD"),
          deliveryMode: previewMode,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        message.error(body.message ?? body.code ?? "Preview failed");
        return;
      }
      message.success(`Preview built: ${body.report.groups} group(s), ${body.report.eligibleMembers} eligible`);
      setPreviewOpen(false);
      setSelectedRunId(body.runId);
      await Promise.all([loadRuns(), loadPlan(body.runId)]);
    } catch {
      message.error("Preview request failed");
    } finally {
      setPreviewLoading(false);
    }
  };

  const patchPlan = async (edit: Record<string, unknown>) => {
    if (!selectedRunId) return;
    try {
      const res = await fetch(`/api/introductions/runs/${selectedRunId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edit }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        message.error(body.message ?? "Edit failed");
        return;
      }
      message.success(body.summary ?? "Plan updated");
      await loadPlan(selectedRunId);
    } catch {
      message.error("Edit request failed");
    }
  };

  const approvePlan = async () => {
    if (!selectedRunId) return;
    setApproveLoading(true);
    try {
      const res = await fetch(`/api/introductions/runs/${selectedRunId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deliveryMode: approveMode,
          confirmation: approveConfirmation || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        message.error(body.message ?? body.code ?? "Approval failed");
        return;
      }
      message.success(`Plan frozen: ${body.deliveryCount} delivery job(s) created`);
      setApproveOpen(false);
      setApproveConfirmation("");
      await Promise.all([loadPlan(selectedRunId), loadRuns()]);
    } catch {
      message.error("Approval request failed");
    } finally {
      setApproveLoading(false);
    }
  };

  const runSchedulerNow = useCallback(async () => {
    setSchedulerLoading(true);
    try {
      const res = await fetch("/api/introductions/city-scheduler/run", {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok || body.processed === false) {
        message.error(body.message ?? body.reason ?? body.error ?? "Scheduler tick did not run");
        return;
      }
      const outcomeCounts: Record<string, number> = {};
      for (const result of body.results ?? []) {
        outcomeCounts[result.outcome] = (outcomeCounts[result.outcome] ?? 0) + 1;
      }
      const summary = Object.entries(outcomeCounts)
        .map(([outcome, count]) => `${outcome}: ${count}`)
        .join(", ");
      message.success(
        `Scheduler tick done: ${body.dueCities ?? 0} due — ${summary || "no outcomes"}`
      );
      void loadCities();
      void loadRuns();
    } catch {
      message.error("Could not run the city scheduler");
    } finally {
      setSchedulerLoading(false);
    }
  }, [message, loadCities, loadRuns]);

  const frozen = runMeta?.status !== "planned";
  const cityOptions = useMemo(
    () =>
      cities.map((c) => ({
        value: c.cityCode,
        label: `${c.cityName ?? c.cityCode} (${c.activeMemberCount ?? 0})`,
      })),
    [cities]
  );

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Title level={4} style={{ margin: 0 }}>
          City Runs
        </Title>
        <Space>
          <Button onClick={() => void loadCities()} loading={loadingCities} icon={<ReloadOutlined />}>
            Cities
          </Button>
          <Button type="primary" icon={<EyeOutlined />} onClick={() => setPreviewOpen(true)}>
            Preview a city
          </Button>
          <Popconfirm
            title="Run the city scheduler now?"
            description="Processes every due scheduled city: builds previews and auto-freezes them per city settings. Never sends email itself."
            onConfirm={() => void runSchedulerNow()}
          >
            <Button icon={<ThunderboltOutlined />} loading={schedulerLoading}>
              Run city scheduler now
            </Button>
          </Popconfirm>
        </Space>
      </Flex>

      <Flex gap={16} align="center">
        <Text strong>Plan:</Text>
        <Select
          style={{ minWidth: 320 }}
          placeholder="Select a previewed run"
          value={selectedRunId ?? undefined}
          onChange={(value) => {
            setSelectedRunId(value);
            if (value) void loadPlan(value);
          }}
          options={runs.map((run) => ({
            value: run.id,
            label: `${run.cycleDate ?? "?"} · ${run.status} · ${run.deliveryMode} · ${run.id.slice(0, 8)}`,
          }))}
        />
        {selectedRunId && (
          <Button
            type="primary"
            danger={report?.safety.level === "production"}
            icon={<SendOutlined />}
            disabled={frozen}
            onClick={() => setApproveOpen(true)}
          >
            {frozen ? "Frozen" : "Approve & freeze"}
          </Button>
        )}
      </Flex>

      {report && report.blockedReason && (
        <Alert
          type="warning"
          showIcon
          message={`City blocked: ${report.blockedReason} — ${report.eligibleMembers} eligible member(s), minimum ${report.minEligibleMembers} required`}
        />
      )}

      {report && !report.blockedReason && (
        <Alert
          type={report.safety.level === "production" ? "error" : report.safety.level === "internal" ? "warning" : "info"}
          showIcon
          message={`Delivery mode: ${report.safety.label}`}
          description={report.safety.description}
        />
      )}

      {report && (
        <Card size="small" title="Simulation report">
          <Flex gap={16} wrap>
            <Descriptions size="small" column={4} bordered>
              <Descriptions.Item label="Eligible">{report.eligibleMembers}</Descriptions.Item>
              <Descriptions.Item label="Matched">{report.matchedMembers}</Descriptions.Item>
              <Descriptions.Item label="Unmatched">{report.unmatchedMembers}</Descriptions.Item>
              <Descriptions.Item label="Groups">{report.groups}</Descriptions.Item>
              <Descriptions.Item label="Deliveries">{report.deliveries}</Descriptions.Item>
              <Descriptions.Item label="Rendered emails">{report.renderedEmails}</Descriptions.Item>
              <Descriptions.Item label="Redirected (canary/test)">{report.canaryRedirectCount}</Descriptions.Item>
              <Descriptions.Item label="Worker ticks">{report.queue.workerTicks}</Descriptions.Item>
            </Descriptions>
            {report.validationFailures.length > 0 && (
              <Alert
                type="error"
                showIcon
                message={report.validationFailures.join(" · ")}
              />
            )}
            {(report.unmatchedMemberDetails ?? []).length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="Unmatched members"
                description={report.unmatchedMemberDetails
                  .map((u) => `${u.email} (${u.reason})`)
                  .join(" · ")}
              />
            )}
            {report.unmatchedMembers > 0 &&
              report.groupSizes &&
              (report.groupSizes.strict || report.groupSizes.min > 2) && (
                <Alert
                  type="error"
                  showIcon
                  message="Group size configuration may be impossible to satisfy"
                  description={
                    report.groupSizes.strict
                      ? `Strict group size requires exactly ${report.groupSizes.target} members per group. Pairs exist but some members cannot complete a ${report.groupSizes.target}-member group — consider turning Strict off or lowering the target.`
                      : `Minimum group size is ${report.groupSizes.min}, but some members only have valid pairs (no compatible group of ${report.groupSizes.min}). Consider setting the minimum group size to 2 in City settings.`
                  }
                />
              )}
          </Flex>
        </Card>
      )}

      {groups.length > 0 && (
        <Card
          size="small"
          title={`Groups (${groups.length})`}
          extra={
            <Button
              size="small"
              disabled={frozen}
              onClick={() => void patchPlan({ type: "regenerate_city" })}
            >
              Regenerate city
            </Button>
          }
        >
          <List
            loading={planLoading}
            dataSource={groups}
            renderItem={(group) => (
              <List.Item
                actions={[
                  <Button
                    key="lock"
                    size="small"
                    icon={group.locked ? <UnlockOutlined /> : <LockOutlined />}
                    disabled={frozen}
                    onClick={() =>
                      void patchPlan({ type: "lock_group", groupId: group.id, locked: !group.locked })
                    }
                  >
                    {group.locked ? "Unlock" : "Lock"}
                  </Button>,
                  <Popconfirm
                    key="regen"
                    title="Regenerate this group?"
                    onConfirm={() => void patchPlan({ type: "regenerate_group", groupId: group.id })}
                    disabled={frozen || group.locked}
                  >
                    <Button size="small" disabled={frozen || group.locked}>
                      Regenerate
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <Flex vertical gap={8} style={{ width: "100%" }}>
                  <Space wrap>
                    {group.locked && <Tag color="purple">Locked</Tag>}
                    <Tag color="blue">Score {group.overallScore?.toFixed(1) ?? "—"}</Tag>
                    {Object.entries(group.scoreBreakdown ?? {}).map(([component, score]) => (
                      <Tag key={component}>
                        {COMPONENT_LABELS[component] ?? component}: {(score * 100).toFixed(0)}
                      </Tag>
                    ))}
                  </Space>
                  <Table<Member>
                    rowKey="key"
                    size="small"
                    pagination={false}
                    dataSource={group.members}
                    columns={[
                      {
                        title: "Member",
                        dataIndex: "name",
                        render: (name: string | null, member) => (
                          <Space direction="vertical" size={0}>
                            <Text strong>{name ?? "—"}</Text>
                            <Text type="secondary">{member.email}</Text>
                            {member.professionalHeadline && (
                              <Text type="secondary">{member.professionalHeadline}</Text>
                            )}
                          </Space>
                        ),
                      },
                      {
                        title: "Profile",
                        render: (_, member) => (
                          <Space direction="vertical" size={0}>
                            <Text>{member.industry ?? "—"}</Text>
                            <Text type="secondary">{member.businessStage ?? ""}</Text>
                          </Space>
                        ),
                      },
                      {
                        title: "Alternatives",
                        render: (_, member) => (
                          <Space>
                            <Select
                              size="small"
                              style={{ width: 260 }}
                              placeholder="Replace with…"
                              disabled={frozen || group.locked}
                              options={member.alternatives.map((alt) => ({
                                value: alt.key,
                                label: `${alt.key.replace(/^at:/, "")} · ${(alt.overall * 100).toFixed(0)}%`,
                              }))}
                              onSelect={(replacementKey) =>
                                void patchPlan({
                                  type: "replace_member",
                                  groupId: group.id,
                                  memberKey: member.key,
                                  replacementKey,
                                })
                              }
                            />
                            <Popconfirm
                              title="Remove this member from the plan?"
                              disabled={frozen || group.locked}
                              onConfirm={() =>
                                void patchPlan({
                                  type: "remove_member",
                                  groupId: group.id,
                                  memberKey: member.key,
                                })
                              }
                            >
                              <Button size="small" danger disabled={frozen || group.locked}>
                                Remove
                              </Button>
                            </Popconfirm>
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Flex>
              </List.Item>
            )}
          />
        </Card>
      )}

      <Modal
        title="Preview a city"
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        onOk={() => void runPreview()}
        confirmLoading={previewLoading}
        okText="Build preview"
      >
        <Flex vertical gap={12}>
          <Select
            placeholder="City"
            options={cityOptions}
            value={previewCity ?? undefined}
            onChange={setPreviewCity}
            loading={loadingCities}
            style={{ width: "100%" }}
          />
          <DatePicker value={previewDate} onChange={(d) => setPreviewDate(d ?? dayjs())} />
          <Select
            value={previewMode}
            onChange={setPreviewMode}
            options={[
              { value: "simulation", label: "Simulation (no sends, ever)" },
              { value: "provider_test", label: "Provider test (redirected)" },
              { value: "canary", label: "Canary (internal addresses)" },
              { value: "production", label: "Production (real members)" },
            ]}
            style={{ width: "100%" }}
          />
          <Alert
            type="info"
            showIcon
            message="Previews never send email. Building a preview writes a plan you can edit, freeze and (optionally) deliver."
          />
        </Flex>
      </Modal>

      <Modal
        title="Approve & freeze plan"
        open={approveOpen}
        onCancel={() => {
          setApproveOpen(false);
          setApproveConfirmation("");
        }}
        onOk={() => void approvePlan()}
        confirmLoading={approveLoading}
        okText="Freeze plan"
        okButtonProps={{ danger: approveMode === "production" }}
      >
        <Flex vertical gap={12}>
          <Alert
            type="warning"
            showIcon
            message="Freezing never sends email. It creates persistent delivery jobs for the queue worker."
          />
          <Select
            value={approveMode}
            onChange={setApproveMode}
            options={[
              { value: "simulation", label: "Simulation — deliveries created but never sent" },
              { value: "provider_test", label: "Provider test — redirect to provider-test addresses" },
              { value: "canary", label: "Canary — redirect to internal canary addresses" },
              { value: "production", label: "Production — real members" },
            ]}
            style={{ width: "100%" }}
          />
          {approveMode === "production" && (
            <>
              <Alert
                type="error"
                showIcon
                message="Production delivery requires live mode and typed confirmation."
              />
              <Input
                placeholder='Type "SEND" to confirm production delivery'
                value={approveConfirmation}
                onChange={(event) => setApproveConfirmation(event.target.value)}
              />
            </>
          )}
        </Flex>
      </Modal>
    </Flex>
  );
}
