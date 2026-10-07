"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Flex, Input, Popconfirm, Space, Table, Typography } from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";

const { Title, Text } = Typography;

interface BannedPairRow {
  id: string;
  memberAEmail: string | null;
  memberBEmail: string | null;
  memberAName: string | null;
  memberBName: string | null;
  note: string | null;
  createdAt: string;
}

function displayName(name: string | null, email: string | null): string {
  if (name) return name;
  return email ?? "—";
}

export default function BannedPairsPage() {
  const { message } = App.useApp();
  const [pairs, setPairs] = useState<BannedPairRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [emailA, setEmailA] = useState("");
  const [emailB, setEmailB] = useState("");
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/introductions/banned-pairs", { cache: "no-store" });
      const body = await res.json();
      setPairs(body.pairs ?? []);
    } catch {
      message.error("Could not load banned pairs");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!emailA.trim() || !emailB.trim()) {
      message.warning("Enter both email addresses");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch("/api/introductions/banned-pairs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailA: emailA.trim(), emailB: emailB.trim(), note: note.trim() || null }),
      });
      const body = await res.json();
      if (!res.ok) {
        message.error(body.message ?? "Could not create ban");
        return;
      }
      message.success("Ban created");
      setEmailA("");
      setEmailB("");
      setNote("");
      await load();
    } catch {
      message.error("Create ban failed");
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/introductions/banned-pairs/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        message.error(body?.message ?? "Could not remove ban");
        return;
      }
      message.success("Ban removed");
      await load();
    } catch {
      message.error("Remove ban failed");
    }
  };

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Title level={4} style={{ margin: 0 }}>
          Banned Pairs
        </Title>
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          Refresh
        </Button>
      </Flex>

      <Alert
        type="info"
        showIcon
        message="Bans prevent two specific members from ever being matched together — in monthly cycles and manual introductions. They are keyed by member, so email changes don't break them."
      />

      <Card size="small" title="Add a ban">
        <Flex gap={8} wrap align="center">
          <Input
            placeholder="first@example.com"
            value={emailA}
            onChange={(e) => setEmailA(e.target.value)}
            style={{ width: 260 }}
          />
          <Input
            placeholder="second@example.com"
            value={emailB}
            onChange={(e) => setEmailB(e.target.value)}
            style={{ width: 260 }}
          />
          <Input
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ width: 260 }}
          />
          <Button type="primary" icon={<PlusOutlined />} loading={adding} onClick={() => void add()}>
            Add ban
          </Button>
        </Flex>
      </Card>

      <Card size="small" title={`Banned pairs (${pairs.length})`}>
        <Table<BannedPairRow>
          rowKey="id"
          loading={loading}
          size="small"
          pagination={false}
          dataSource={pairs}
          columns={[
            {
              title: "Member A",
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Text strong>{displayName(row.memberAName, row.memberAEmail)}</Text>
                  <Text type="secondary">{row.memberAEmail ?? "—"}</Text>
                </Space>
              ),
            },
            {
              title: "Member B",
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Text strong>{displayName(row.memberBName, row.memberBEmail)}</Text>
                  <Text type="secondary">{row.memberBEmail ?? "—"}</Text>
                </Space>
              ),
            },
            { title: "Note", dataIndex: "note", render: (v: string | null) => v ?? "—" },
            {
              title: "Created",
              dataIndex: "createdAt",
              width: 180,
              render: (v: string) => new Date(v).toLocaleString(),
            },
            {
              title: "",
              width: 90,
              render: (_, row) => (
                <Popconfirm title="Remove this ban?" onConfirm={() => void remove(row.id)}>
                  <Button size="small" danger>
                    Remove
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Card>
    </Flex>
  );
}
