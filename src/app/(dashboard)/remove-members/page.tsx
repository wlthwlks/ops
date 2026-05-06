"use client";

import { useEffect, useState, useCallback } from "react";
import { Button, Card, DatePicker, Empty, Spin, Steps, Table, Tag, Typography, Space, message } from "antd";
import { SearchOutlined, CopyOutlined, ExportOutlined, CalendarOutlined, FilterOutlined, MailOutlined, FileExcelOutlined } from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

interface CancelledMember {
  id: string;
  name: string;
  surname: string;
  email: string;
  city: string;
  phone: string;
  dateAdded: string;
}

interface ApiResponse {
  success: boolean;
  startDate: string;
  endDate: string;
  total: number;
  data: CancelledMember[];
}

type RangePreset = {
  label: string;
  value: [Dayjs, Dayjs];
};

const presets: RangePreset[] = [
  { label: "Today", value: [dayjs(), dayjs()] },
  { label: "Last 7 Days", value: [dayjs().subtract(6, "day"), dayjs()] },
  { label: "Last 30 Days", value: [dayjs().subtract(29, "day"), dayjs()] },
  { label: "Last 90 Days", value: [dayjs().subtract(89, "day"), dayjs()] },
];

export default function RemoveMembersPage() {
  const [loading, setLoading] = useState(true);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>([
    dayjs().subtract(29, "day"),
    dayjs(),
  ]);

  const fetchData = useCallback(async (range: [Dayjs, Dayjs]) => {
    setLoading(true);
    setError(null);
    try {
      const startDate = range[0].format("YYYY-MM-DD");
      const endDate = range[1].format("YYYY-MM-DD");
      const params = new URLSearchParams({ startDate, endDate });
      const res = await fetch(`/api/remove-members?${params}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data: ApiResponse = await res.json();
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(dateRange);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleDateChange(dates: [Dayjs | null, Dayjs | null] | null) {
    if (dates && dates[0] && dates[1]) {
      setDateRange([dates[0], dates[1]]);
    }
  }

  function copyEmails() {
    if (!response?.data.length) return;
    const emails = response.data.map((m) => m.email).join(", ");
    navigator.clipboard.writeText(emails);
    message.success(`Copied ${response.data.length} email(s)`);
  }

  function exportCsv() {
    if (!response?.data.length) return;

    const escapeField = (val: string) => {
      if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };

    const csvContent = response.data.map((m) => m.email).join("\n");

    const dateLabel =
      response.startDate === response.endDate
        ? response.startDate.replace(/-/g, "")
        : `${response.startDate.replace(/-/g, "")}-${response.endDate.replace(/-/g, "")}`;

    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${dateLabel}-cancelled-members.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const columns = [
    {
      title: "Name",
      key: "name",
      render: (_: unknown, record: CancelledMember) => (
        <Text strong>{`${record.name} ${record.surname}`.trim() || "—"}</Text>
      ),
    },
    {
      title: "Email",
      dataIndex: "email",
      key: "email",
    },
    {
      title: "City",
      dataIndex: "city",
      key: "city",
      render: (city: string) => city || "—",
    },
    {
      title: "Phone",
      dataIndex: "phone",
      key: "phone",
      render: (phone: string) => phone || "—",
    },
    {
      title: "Status",
      key: "status",
      render: () => <Tag color="red">Cancelled</Tag>,
    },
  ];

  return (
    <div style={{ maxWidth: 1100 }}>
      <Space orientation="vertical" size="middle" style={{ width: "100%", marginBottom: 16 }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>
            Remove Members
          </Title>
          <Text type="secondary">
            Recently cancelled members to remove from city channels
          </Text>
        </div>

        <Card size="small" title="How to remove cancelled members from Slack" style={{ background: "#fafafa" }}>
          <Steps
            direction="vertical"
            size="small"
            current={-1}
            items={[
              {
                title: "Go to Slack Admin",
                description: (
                  <span>
                    Open{" "}
                    <a href="https://wlth-wlks.slack.com/admin" target="_blank" rel="noopener noreferrer">
                      wlth-wlks.slack.com/admin
                    </a>
                  </span>
                ),
              },
              {
                title: "Export cancelled members CSV",
                description: "Select a date range below, click Search, then click Export CSV to download the list.",
              },
              {
                title: "Upload CSV to Bulk Slack Deactivation Extension",
                description: (
                  <span>
                    Using the Bulk Slack User Deactivation Chrome Extension, upload your CSV file by clicking the
                    &ldquo;Submit CSV File&rdquo; button. If you don&rsquo;t have the extension, see step 4.
                  </span>
                ),
              },
              {
                title: "Install the Chrome Extension (if needed)",
                description: (
                  <span>
                    Install{" "}
                    <a
                      href="https://chromewebstore.google.com/detail/bulk-slack-user-deactivat/bbklkhjijobpamjeemohloddompcehkc?hl=en&utm_source=chatgpt.com"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Bulk Slack User Deactivation Extension
                    </a>
                    , then paste in this license key: <Text code copyable>EA3C50CF-8C3A-42B6-95F4-BFA275D207EF</Text>
                  </span>
                ),
              },
            ]}
          />
        </Card>

        <Space>
          <RangePicker
            value={dateRange}
            onChange={handleDateChange}
            presets={presets}
            disabledDate={(current) => current && current.isAfter(dayjs(), "day")}
            allowClear={false}
          />
          <Button
            type="primary"
            icon={<SearchOutlined />}
            onClick={() => fetchData(dateRange)}
            loading={loading}
          >
            Search
          </Button>
          <Button
            icon={<CopyOutlined />}
            onClick={copyEmails}
            disabled={loading || !response?.data.length}
          >
            Copy Emails
          </Button>
          <Button
            icon={<ExportOutlined />}
            onClick={exportCsv}
            disabled={loading || !response?.data.length}
          >
            Export CSV
          </Button>
        </Space>
      </Space>

      {error && (
        <Card style={{ marginBottom: 16 }}>
          <Text type="danger">{error}</Text>
        </Card>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : !response?.data.length ? (
        <Empty description="No cancelled members found for this period" />
      ) : (
        <>
          <Card style={{ marginBottom: 16 }}>
            <Text strong>{response.total} cancelled member(s)</Text>
            <Text type="secondary"> from {response.startDate} to {response.endDate}</Text>
          </Card>
          <Table
            dataSource={response.data}
            columns={columns}
            rowKey="id"
            pagination={false}
            size="middle"
          />
        </>
      )}
    </div>
  );
}
