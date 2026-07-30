"use client";

import { Collapse, Space, Table, Tag, Typography } from "antd";
import type { OpStatus } from "@/lib/queries";
import Link from "next/link";
import { RunButton } from "./run-button";
import { OperationRiskTag } from "@/components/ops/OperationRiskTag";

const statusColors: Record<string, string> = {
  idle: "default",
  running: "processing",
  success: "success",
  failed: "error",
};

const CATEGORY_LABELS: Record<string, string> = {
  health_checks: "Health Checks",
  airtable_maintenance: "Airtable Maintenance",
  billing_stripe: "Billing and Stripe",
  slack: "Slack",
  city_relationships: "City Relationships",
  introduction_history: "Introduction History",
  pinecone_matching: "Pinecone / Matching Data",
  legacy_disabled: "Legacy / Disabled",
};

const CATEGORY_ORDER = [
  "health_checks",
  "airtable_maintenance",
  "billing_stripe",
  "slack",
  "city_relationships",
  "introduction_history",
  "pinecone_matching",
  "legacy_disabled",
];

export function OpsTable({ ops }: { ops: OpStatus[] }) {
  const byCategory = new Map<string, OpStatus[]>();
  for (const op of ops) {
    const cat = op.category || "airtable_maintenance";
    const list = byCategory.get(cat) || [];
    list.push(op);
    byCategory.set(cat, list);
  }

  const orderedCats = [
    ...CATEGORY_ORDER.filter((c) => byCategory.has(c)),
    ...[...byCategory.keys()].filter((c) => !CATEGORY_ORDER.includes(c)),
  ];

  const columns = [
    {
      title: "Name",
      dataIndex: "name",
      key: "name",
      render: (name: string, record: OpStatus) => (
        <Space orientation="vertical" size={0}>
          <Link href={`/ops/${record.slug}`}>{name}</Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.summary || record.description}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "Risk",
      key: "risk",
      width: 120,
      render: (_: unknown, record: OpStatus) => (
        <OperationRiskTag risk={record.riskLevel} />
      ),
    },
    {
      title: "Mode",
      key: "mode",
      width: 100,
      render: (_: unknown, record: OpStatus) =>
        record.cliOnly ? (
          <Tag>CLI</Tag>
        ) : record.requiresLiveMode ? (
          <Tag color="orange">Live</Tag>
        ) : record.supportsReadOnly ? (
          <Tag color="green">Read-only OK</Tag>
        ) : (
          <Tag>Admin</Tag>
        ),
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (status: string) => (
        <Tag color={statusColors[status]}>{status.toUpperCase()}</Tag>
      ),
    },
    {
      title: "Last Run",
      key: "lastRun",
      width: 160,
      render: (_: unknown, record: OpStatus) =>
        record.lastRun?.startedAt
          ? new Date(record.lastRun.startedAt).toLocaleString()
          : "Never",
    },
    {
      title: "Schedule",
      dataIndex: "schedule",
      key: "schedule",
      width: 120,
      render: (schedule?: string) => schedule ?? "Manual",
    },
    {
      title: "Actions",
      key: "actions",
      width: 140,
      render: (_: unknown, record: OpStatus) => (
        <RunButton
          slug={record.slug}
          disabled={Boolean(record.cliOnly || record.deprecated)}
          cliOnly={record.cliOnly}
          commandEquivalent={record.commandEquivalent}
        />
      ),
    },
  ];

  return (
    <Collapse
      defaultActiveKey={orderedCats.slice(0, 3)}
      items={orderedCats.map((cat) => ({
        key: cat,
        label: CATEGORY_LABELS[cat] || cat,
        children: (
          <Table
            dataSource={byCategory.get(cat) || []}
            columns={columns}
            rowKey="slug"
            pagination={false}
            size="middle"
            expandable={{
              expandedRowRender: (record: OpStatus) => (
                <div style={{ padding: 8 }}>
                  <Typography.Paragraph>
                    <strong>What:</strong> {record.detailedDescription || record.description}
                  </Typography.Paragraph>
                  {record.whenToRun && (
                    <Typography.Paragraph>
                      <strong>When to run:</strong> {record.whenToRun}
                    </Typography.Paragraph>
                  )}
                  {record.whenNotToRun && (
                    <Typography.Paragraph>
                      <strong>When not to run:</strong> {record.whenNotToRun}
                    </Typography.Paragraph>
                  )}
                  {record.sideEffects && (
                    <Typography.Paragraph>
                      <strong>Side effects:</strong> {record.sideEffects.join("; ")}
                    </Typography.Paragraph>
                  )}
                  {record.commandEquivalent && (
                    <Typography.Paragraph>
                      <strong>CLI:</strong>{" "}
                      <Typography.Text code>{record.commandEquivalent}</Typography.Text>
                    </Typography.Paragraph>
                  )}
                  <Link href={`/ops/${record.slug}`}>Open details & run history →</Link>
                </div>
              ),
            }}
          />
        ),
      }))}
    />
  );
}
