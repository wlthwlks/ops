"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Descriptions,
  Flex,
  Input,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { SearchOutlined, ReloadOutlined } from "@ant-design/icons";

const { Title, Text } = Typography;

interface CityOption {
  cityCode: string;
  cityName: string | null;
  activeMemberCount: number | null;
}

interface HistoryMember {
  key: string;
  email: string;
  name: string | null;
  city: string | null;
  postcode: string | null;
  industry: string | null;
  businessStage: string | null;
  professionalHeadline: string | null;
  phone: string | null;
  socialMedia: string | null;
  website: string | null;
  helpWanted: string[];
  expertise: string[];
}

interface HistoryDeliveryEvent {
  eventType: string;
  providerTs: string | null;
}

interface HistoryDelivery {
  id: string;
  recipientEmail: string;
  recipientName: string | null;
  deliverToEmail: string;
  originalTo: string[] | null;
  status: string;
  resendMessageId: string | null;
  attemptCount: number;
  error: string | null;
  sentAt: string | null;
  events: HistoryDeliveryEvent[];
}

interface HistoryGroup {
  id: string;
  cityName: string | null;
  status: string;
  overallScore: number | null;
  scoreBreakdown: Record<string, number> | null;
  sentAt: string | null;
  subject: string | null;
  members: HistoryMember[];
  deliveries: HistoryDelivery[];
}

interface UnifiedResult {
  source: "unified";
  run: {
    id: string;
    cycleDate: string | null;
    status: string;
    deliveryMode: string;
    createdAt: string;
    cityCodes: string[];
  };
  groups: HistoryGroup[];
}

interface LegacyResult {
  source: "legacy";
  event: {
    id: string;
    createdAt: string;
    mode: string;
    newMemberEmail: string;
    newMemberPostcode: string | null;
    newMemberCity: string | null;
    newMemberIndustry: string | null;
    summary: string | null;
    error: string | null;
    slackSentAt: string | null;
    slackRecipientCount: number | null;
  };
  matches: Array<{
    rank: number;
    email: string;
    postcode: string | null;
    city: string | null;
    industry: string | null;
    similarityScore: number | null;
  }>;
}

type ResultItem = UnifiedResult | LegacyResult;

interface NotSentBlockedRun {
  id: string;
  cycleDate: string | null;
  source: string;
  status: string;
  deliveryMode: string;
  cityNames: string[];
  summary: string | null;
  error: string | null;
  createdAt: string;
}

interface NotSentGroup {
  id: string;
  runId: string;
  cycleDate: string | null;
  source: string;
  deliveryMode: string;
  cityName: string | null;
  status: string;
  subject: string | null;
  sentAt: string | null;
  members: HistoryMember[];
  failedDeliveries: HistoryDelivery[];
}

interface NotSentResponse {
  blockedRuns: NotSentBlockedRun[];
  groups: NotSentGroup[];
}

const STATUS_COLORS: Record<string, string> = {
  planned: "default",
  approved: "blue",
  sending: "processing",
  sent: "blue",
  delivered: "green",
  delayed: "orange",
  bounced: "red",
  complained: "red",
  suppressed: "red",
  failed: "red",
  completed: "green",
  partial: "orange",
  cancelled: "default",
  expired: "default",
};

const MODE_TAG: Record<string, { color: string; label: string }> = {
  simulation: { color: "default", label: "Simulation" },
  provider_test: { color: "orange", label: "Provider test" },
  canary: { color: "gold", label: "Canary" },
  production: { color: "red", label: "Production" },
};

function GroupMembersTable({ members }: { members: HistoryMember[] }) {
  return (
    <Table<HistoryMember>
      size="small"
      rowKey="key"
      pagination={false}
      dataSource={members}
      columns={[
        {
          title: "Member",
          dataIndex: "name",
          render: (_: string | null, member) => (
            <Space direction="vertical" size={0}>
              <Text strong>{member.name ?? "—"}</Text>
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
              <Text>
                {member.city ?? "—"} · {member.industry ?? "—"} · {member.businessStage ?? "—"}
              </Text>
              <Text type="secondary">Postcode: {member.postcode ?? "—"}</Text>
            </Space>
          ),
        },
        {
          title: "Contact",
          render: (_, member) => (
            <Space direction="vertical" size={0}>
              {member.phone && <Text>Phone: {member.phone}</Text>}
              {member.socialMedia && <Text>Social: {member.socialMedia}</Text>}
              {member.website && <Text>Website: {member.website}</Text>}
            </Space>
          ),
        },
        {
          title: "Help / Expertise",
          render: (_, member) => (
            <Space direction="vertical" size={0}>
              {member.helpWanted.length > 0 && (
                <Text>Needs: {member.helpWanted.join(", ")}</Text>
              )}
              {member.expertise.length > 0 && (
                <Text>Offers: {member.expertise.join(", ")}</Text>
              )}
            </Space>
          ),
        },
      ]}
    />
  );
}

function GroupDeliveriesTable({ deliveries }: { deliveries: HistoryDelivery[] }) {
  return (
    <Table<HistoryDelivery>
      size="small"
      rowKey="id"
      pagination={false}
      dataSource={deliveries}
      expandable={{
        expandedRowRender: (delivery) =>
          delivery.events.length === 0 ? (
            <Text type="secondary">No provider events yet</Text>
          ) : (
            <Space direction="vertical" size={4}>
              {delivery.events.map((event, index) => (
                <Text key={index} type="secondary">
                  {event.eventType} ·{" "}
                  {event.providerTs ? new Date(event.providerTs).toLocaleString() : "—"}
                </Text>
              ))}
            </Space>
          ),
      }}
      columns={[
        {
          title: "Recipient",
          dataIndex: "recipientEmail",
          render: (email: string, delivery) => (
            <Space direction="vertical" size={0}>
              <Text strong>{email}</Text>
              {delivery.recipientName && (
                <Text type="secondary">{delivery.recipientName}</Text>
              )}
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
                <Text type="secondary">
                  original: {(delivery.originalTo ?? []).join(", ")}
                </Text>
              </Space>
            ) : (
              email
            ),
        },
        {
          title: "Status",
          dataIndex: "status",
          render: (status: string) => (
            <Tag color={STATUS_COLORS[status] ?? "default"}>{status}</Tag>
          ),
        },
        {
          title: "Sent at",
          dataIndex: "sentAt",
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
  );
}

export default function IntroductionsHistoryPage() {
  const { message } = App.useApp();
  const [person, setPerson] = useState("");
  const [cityCode, setCityCode] = useState<string | undefined>(undefined);
  const [cities, setCities] = useState<CityOption[]>([]);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notSent, setNotSent] = useState<NotSentResponse | null>(null);
  const [notSentLoading, setNotSentLoading] = useState(false);

  const loadNotSent = useCallback(async () => {
    setNotSentLoading(true);
    try {
      const res = await fetch("/api/introductions/not-sent", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok || body.success === false) {
        message.error(body.message ?? "Could not load unsent emails");
        return;
      }
      setNotSent({ blockedRuns: body.blockedRuns ?? [], groups: body.groups ?? [] });
    } catch {
      message.error("Could not load unsent emails");
    } finally {
      setNotSentLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadNotSent();
  }, [loadNotSent]);

  useEffect(() => {
    fetch("/api/introductions/cities", { cache: "no-store" })
      .then((res) => res.json())
      .then((body) =>
        setCities(
          (body.cities ?? []).filter((c: CityOption) => c.cityName).map((c: CityOption) => c)
        )
      )
      .catch(() => {});
  }, []);

  const search = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (person.trim()) params.set("person", person.trim());
      if (cityCode) params.set("city", cityCode);
      const res = await fetch(`/api/introductions/history?${params.toString()}`, {
        cache: "no-store",
      });
      const body = await res.json();
      if (!res.ok || body.success === false) {
        message.error(body.message ?? "Search failed");
        return;
      }
      setResults(body.results ?? []);
      setSearched(true);
    } catch {
      message.error("Search failed");
    } finally {
      setLoading(false);
    }
  }, [person, cityCode, message]);

  const matchesTab = (
    <Flex vertical gap={16}>
      <Flex gap={12} wrap align="center">
        <Input
          style={{ maxWidth: 340 }}
          placeholder="Person — email, name or record id"
          value={person}
          onChange={(e) => setPerson(e.target.value)}
          onPressEnter={() => void search()}
          allowClear
        />
        <Select
          style={{ minWidth: 220 }}
          placeholder="City"
          showSearch
          allowClear
          optionFilterProp="label"
          value={cityCode}
          onChange={(value?: string) => setCityCode(value)}
          options={cities.map((city) => ({
            value: city.cityCode,
            label: `${city.cityName ?? city.cityCode} (${city.activeMemberCount ?? 0})`,
          }))}
        />
        <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={() => void search()}>
          Search
        </Button>
      </Flex>

      {searched && results.length === 0 && (
        <Alert type="info" showIcon message="No matches found for this search." />
      )}

      {results.map((item) =>
        item.source === "legacy" ? (
          <Card
            key={`legacy-${item.event.id}`}
            size="small"
            title={
              <Space wrap>
                <Tag color="purple">Legacy Get Matched</Tag>
                <Text strong>{item.event.newMemberEmail}</Text>
                <Text type="secondary">{new Date(item.event.createdAt).toLocaleString()}</Text>
              </Space>
            }
          >
            <Descriptions size="small" column={2}>
              <Descriptions.Item label="City">{item.event.newMemberCity ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="Postcode">{item.event.newMemberPostcode ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="Industry">{item.event.newMemberIndustry ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="Mode">{item.event.mode}</Descriptions.Item>
              <Descriptions.Item label="Slack sent">
                {item.event.slackSentAt ? new Date(item.event.slackSentAt).toLocaleString() : "—"}
              </Descriptions.Item>
              <Descriptions.Item label="Slack recipients">
                {item.event.slackRecipientCount ?? "—"}
              </Descriptions.Item>
              {item.event.summary && (
                <Descriptions.Item label="Summary" span={2}>
                  {item.event.summary}
                </Descriptions.Item>
              )}
              {item.event.error && (
                <Descriptions.Item label="Error" span={2}>
                  <Text type="danger">{item.event.error}</Text>
                </Descriptions.Item>
              )}
            </Descriptions>
            <Table
              size="small"
              rowKey={(row) => `${item.event.id}-${row.rank}`}
              pagination={false}
              dataSource={item.matches}
              columns={[
                { title: "Rank", dataIndex: "rank", width: 70 },
                { title: "Match", dataIndex: "email" },
                { title: "City", dataIndex: "city", render: (v: string | null) => v ?? "—" },
                { title: "Industry", dataIndex: "industry", render: (v: string | null) => v ?? "—" },
                {
                  title: "Similarity",
                  dataIndex: "similarityScore",
                  render: (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(0)}%`),
                },
              ]}
            />
          </Card>
        ) : (
          <Card
            key={`run-${item.run.id}`}
            size="small"
            title={
              <Space wrap>
                <Text code>{item.run.id.slice(0, 8)}…</Text>
                <Text strong>{item.run.cycleDate ?? "?"}</Text>
                {MODE_TAG[item.run.deliveryMode] && (
                  <Tag color={MODE_TAG[item.run.deliveryMode].color}>
                    {MODE_TAG[item.run.deliveryMode].label}
                  </Tag>
                )}
                <Tag color={STATUS_COLORS[item.run.status] ?? "default"}>{item.run.status}</Tag>
                <Text type="secondary">created {new Date(item.run.createdAt).toLocaleString()}</Text>
              </Space>
            }
          >
            <Collapse
              size="small"
              items={item.groups.map((group) => ({
                key: group.id,
                label: (
                  <Space wrap>
                    <Text strong>{group.cityName ?? "?"}</Text>
                    <Text type="secondary">{group.subject ?? "—"}</Text>
                    {group.overallScore != null && (
                      <Tag color="blue">Score {(group.overallScore * 100).toFixed(0)}%</Tag>
                    )}
                    <Tag color={STATUS_COLORS[group.status] ?? "default"}>{group.status}</Tag>
                    {group.sentAt && (
                      <Text type="secondary">sent {new Date(group.sentAt).toLocaleString()}</Text>
                    )}
                  </Space>
                ),
                children: (
                  <Flex vertical gap={12}>
                    {group.scoreBreakdown && (
                      <Space wrap size={4}>
                        {Object.entries(group.scoreBreakdown).map(([component, score]) => (
                          <Tag key={component}>
                            {component}: {(score * 100).toFixed(0)}%
                          </Tag>
                        ))}
                      </Space>
                    )}
                    <GroupMembersTable members={group.members} />
                    <GroupDeliveriesTable deliveries={group.deliveries} />
                  </Flex>
                ),
              }))}
            />
          </Card>
        )
      )}
    </Flex>
  );

  const notSentTab = (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Text type="secondary">
          Emails that never went out: blocked runs, failed groups and failed deliveries.
        </Text>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={notSentLoading}
          onClick={() => void loadNotSent()}
        >
          Refresh
        </Button>
      </Flex>

      {notSent === null ? (
        <Alert type="info" showIcon message={notSentLoading ? "Loading…" : "No data loaded."} />
      ) : notSent.blockedRuns.length === 0 && notSent.groups.length === 0 ? (
        <Alert type="success" showIcon message="No unsent emails found." />
      ) : (
        <>
          {notSent.blockedRuns.length > 0 && (
            <Card size="small" title={`Blocked runs (${notSent.blockedRuns.length})`}>
              <Table<NotSentBlockedRun>
                size="small"
                rowKey="id"
                pagination={{ pageSize: 20 }}
                dataSource={notSent.blockedRuns}
                columns={[
                  {
                    title: "City",
                    dataIndex: "cityNames",
                    render: (names: string[]) => (
                      <Text strong>{names.join(", ") || "—"}</Text>
                    ),
                  },
                  {
                    title: "Cycle date",
                    dataIndex: "cycleDate",
                    render: (v: string | null) => v ?? "—",
                  },
                  {
                    title: "Kind",
                    render: (_, run) => (
                      <Space size={4} wrap>
                        <Text code>{run.source}</Text>
                        {MODE_TAG[run.deliveryMode] && (
                          <Tag color={MODE_TAG[run.deliveryMode].color}>
                            {MODE_TAG[run.deliveryMode].label}
                          </Tag>
                        )}
                      </Space>
                    ),
                  },
                  {
                    title: "Status",
                    dataIndex: "status",
                    render: (status: string) => (
                      <Tag color={STATUS_COLORS[status] ?? "default"}>{status}</Tag>
                    ),
                  },
                  {
                    title: "Summary / Error",
                    render: (_, run) => (
                      <Space direction="vertical" size={0}>
                        {run.summary && <Text>{run.summary}</Text>}
                        {run.error && <Text type="danger">{run.error}</Text>}
                      </Space>
                    ),
                  },
                ]}
              />
            </Card>
          )}

          {notSent.groups.length > 0 && (
            <Card size="small" title={`Failed groups (${notSent.groups.length})`}>
              <Collapse
                size="small"
                items={notSent.groups.map((group) => ({
                  key: group.id,
                  label: (
                    <Space wrap>
                      <Text strong>{group.cityName ?? "?"}</Text>
                      <Text code>{group.source}</Text>
                      {MODE_TAG[group.deliveryMode] && (
                        <Tag color={MODE_TAG[group.deliveryMode].color}>
                          {MODE_TAG[group.deliveryMode].label}
                        </Tag>
                      )}
                      <Tag color={STATUS_COLORS[group.status] ?? "default"}>
                        {group.status}
                      </Tag>
                      {group.failedDeliveries.length > 0 && (
                        <Tag color="red">
                          {group.failedDeliveries.length} failed{" "}
                          {group.failedDeliveries.length === 1 ? "delivery" : "deliveries"}
                        </Tag>
                      )}
                      {group.subject && (
                        <Text type="secondary">{group.subject}</Text>
                      )}
                    </Space>
                  ),
                  children: (
                    <Flex vertical gap={12}>
                      <GroupMembersTable members={group.members} />
                      {group.failedDeliveries.length > 0 && (
                        <GroupDeliveriesTable deliveries={group.failedDeliveries} />
                      )}
                    </Flex>
                  ),
                }))}
              />
            </Card>
          )}
        </>
      )}
    </Flex>
  );

  return (
    <Flex vertical gap={16}>
      <Title level={4} style={{ margin: 0 }}>
        Match History
      </Title>

      <Tabs
        items={[
          { key: "matches", label: "Matches", children: matchesTab },
          {
            key: "not-sent",
            label: notSent
              ? `Not Sent (${notSent.blockedRuns.length + notSent.groups.length})`
              : "Not Sent",
            children: notSentTab,
          },
        ]}
      />
    </Flex>
  );
}
