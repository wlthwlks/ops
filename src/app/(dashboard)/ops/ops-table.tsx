"use client";

import { Table, Tag } from "antd";
import type { OpStatus } from "@/lib/queries";
import Link from "next/link";
import { RunButton } from "./run-button";

const statusColors: Record<string, string> = {
  idle: "default",
  running: "processing",
  success: "success",
  failed: "error",
};

export function OpsTable({ ops }: { ops: OpStatus[] }) {
  const columns = [
    {
      title: "Name",
      dataIndex: "name",
      key: "name",
      render: (name: string, record: OpStatus) => (
        <Link href={`/ops/${record.slug}`}>{name}</Link>
      ),
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (status: string) => (
        <Tag color={statusColors[status]}>{status.toUpperCase()}</Tag>
      ),
    },
    {
      title: "Last Run",
      key: "lastRun",
      render: (_: unknown, record: OpStatus) => record.lastRun?.startedAt ?? "Never",
    },
    {
      title: "Schedule",
      dataIndex: "schedule",
      key: "schedule",
      render: (schedule?: string) => schedule ?? "Manual",
    },
    {
      title: "Actions",
      key: "actions",
      render: (_: unknown, record: OpStatus) => <RunButton slug={record.slug} />,
    },
  ];

  return (
    <Table dataSource={ops} columns={columns} rowKey="slug" pagination={false} size="middle" />
  );
}
