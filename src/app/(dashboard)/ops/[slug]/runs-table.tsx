"use client";

import { Table, Tag, Empty } from "antd";
import type { OpRun } from "@/db/schema";

const statusColors: Record<string, string> = {
  running: "processing",
  success: "success",
  failed: "error",
};

export function RunsTable({ runs }: { runs: OpRun[] }) {
  const columns = [
    { title: "Started", dataIndex: "startedAt", key: "startedAt" },
    { title: "Finished", dataIndex: "finishedAt", key: "finishedAt", render: (v: string | null) => v ?? "\u2014" },
    { title: "Status", dataIndex: "status", key: "status", render: (status: string) => <Tag color={statusColors[status]}>{status.toUpperCase()}</Tag> },
    { title: "Summary", dataIndex: "summary", key: "summary", render: (v: string | null) => v ?? "\u2014" },
  ];

  if (runs.length === 0) {
    return <Empty description="No runs yet" />;
  }

  return (
    <Table
      dataSource={runs}
      columns={columns}
      rowKey="id"
      pagination={{ pageSize: 10 }}
      size="middle"
      expandable={{
        expandedRowRender: (record: OpRun) => (
          <pre style={{ maxHeight: 300, overflow: "auto", background: "#fafafa", padding: 12, fontSize: 12, whiteSpace: "pre-wrap" }}>
            {record.log || "No logs"}
          </pre>
        ),
      }}
    />
  );
}
