"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, DatePicker, Empty, Space, Spin, Table, Typography, message } from "antd";
import { DownloadOutlined, SearchOutlined } from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";
import { OpsPageHeader } from "@/components/ops/OpsPageHeader";
import { ErrorState } from "@/components/ops/ErrorState";

const { Text } = Typography;
const { RangePicker } = DatePicker;

interface NewMemberRow {
  id: string;
  name: string;
  email: string;
  dateJoined: string;
  country: string;
  city: string;
  postCode: string;
  stripeCustomerId: string;
}

interface ApiResponse {
  success: boolean;
  error?: string;
  startDate: string;
  endDate: string;
  total: number;
  members: NewMemberRow[];
}

const PAGE_SIZE_OPTIONS = [30, 50, 100, 200];

const presets: Array<{ label: string; value: [Dayjs, Dayjs] }> = [
  { label: "Today", value: [dayjs(), dayjs()] },
  { label: "Last 3 Days", value: [dayjs().subtract(2, "day"), dayjs()] },
  { label: "Last 7 Days", value: [dayjs().subtract(6, "day"), dayjs()] },
  { label: "Last 10 Days", value: [dayjs().subtract(9, "day"), dayjs()] },
  { label: "Last 30 Days", value: [dayjs().subtract(29, "day"), dayjs()] },
];

function copyableCell(value: string | undefined) {
  if (!value) return <Text type="secondary">—</Text>;
  return (
    <Text copyable style={{ wordBreak: "break-all" }}>
      {value}
    </Text>
  );
}

export default function DailyNewCustomersPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<NewMemberRow[]>([]);
  const [rangeLabel, setRangeLabel] = useState<string>("");
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>([
    dayjs().subtract(6, "day"),
    dayjs(),
  ]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);

  const fetchData = useCallback(async (range: [Dayjs, Dayjs]) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        startDate: range[0].format("YYYY-MM-DD"),
        endDate: range[1].format("YYYY-MM-DD"),
      });
      const res = await fetch(`/api/get-daily-new-customers-for-cities?${params}`);
      const json: ApiResponse = await res.json();
      if (!res.ok || json.success === false) {
        throw new Error(json.error || `API error: ${res.status}`);
      }
      setMembers(json.members || []);
      setPage(1);
      setRangeLabel(
        json.startDate === json.endDate
          ? json.startDate
          : `${json.startDate} to ${json.endDate}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(dateRange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleDateChange(dates: [Dayjs | null, Dayjs | null] | null) {
    if (dates && dates[0] && dates[1]) {
      setDateRange([dates[0], dates[1]]);
    }
  }

  function exportCsv() {
    if (members.length === 0) {
      message.warning("No members to export");
      return;
    }
    const start = (page - 1) * pageSize;
    const slice = members.slice(start, start + pageSize);
    const escapeField = (val: string) => {
      if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };
    const header = "Name,Email,Date joined,Country,City,Post code,Stripe Customer ID";
    const rows = slice.map((m) =>
      [m.name, m.email, m.dateJoined, m.country, m.city, m.postCode, m.stripeCustomerId]
        .map(escapeField)
        .join(",")
    );
    const csvContent = [header, ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `new-members-${rangeLabel.replace(/\s+/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    message.success("CSV exported (current page)");
  }

  const columns = [
    { title: "Name", dataIndex: "name", key: "name", width: 180, render: copyableCell },
    { title: "Email", dataIndex: "email", key: "email", width: 240, render: copyableCell },
    {
      title: "Date joined",
      dataIndex: "dateJoined",
      key: "dateJoined",
      width: 130,
      render: copyableCell,
    },
    { title: "Country", dataIndex: "country", key: "country", width: 130, render: copyableCell },
    { title: "City", dataIndex: "city", key: "city", width: 150, render: copyableCell },
    {
      title: "Post code",
      dataIndex: "postCode",
      key: "postCode",
      width: 120,
      render: copyableCell,
    },
    {
      title: "Stripe Customer ID",
      dataIndex: "stripeCustomerId",
      key: "stripeCustomerId",
      width: 200,
      render: copyableCell,
    },
  ];

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <OpsPageHeader
        title="New Members"
        description="New active members (current service access) ordered by Date joined, newest first."
        breadcrumbs={[
          { title: "Members", href: "/members" },
          { title: "New Members" },
        ]}
        onRefresh={() => fetchData(dateRange)}
        refreshing={loading}
        extra={
          <Button
            icon={<DownloadOutlined />}
            onClick={exportCsv}
            disabled={loading || members.length === 0}
          >
            Export CSV
          </Button>
        }
      />

      <Space wrap style={{ marginBottom: 12 }}>
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
          Get New Members
        </Button>
        <Text type="secondary">{members.length} member(s)</Text>
      </Space>

      {error && <ErrorState message={error} onRetry={() => fetchData(dateRange)} />}

      {loading ? (
        <div style={{ textAlign: "center", padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : members.length === 0 && !error ? (
        <Empty description="No new members in this range" />
      ) : (
        <Table
          size="small"
          rowKey={(r) => r.id || r.email}
          dataSource={members}
          columns={columns}
          scroll={{ x: 1150 }}
          pagination={{
            current: page,
            pageSize,
            showSizeChanger: true,
            pageSizeOptions: PAGE_SIZE_OPTIONS.map(String),
            showTotal: (t, range) => `${range[0]}–${range[1]} of ${t} members`,
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps || pageSize);
            },
          }}
        />
      )}
    </div>
  );
}
