"use client";

import { useEffect, useState, useCallback } from "react";
import { Button, Card, DatePicker, Empty, Spin, Table, Tag, Typography, Space, message } from "antd";
import { DownloadOutlined, CopyOutlined, SearchOutlined } from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

interface SublocationBreakdown {
  sublocation: string;
  emails: string[];
}

interface CityData {
  city: string;
  filename: string;
  count: number;
  emails: string[];
  csv: string;
  breakdown: SublocationBreakdown[];
}

interface ApiResponse {
  success: boolean;
  startDate: string;
  endDate: string;
  data: CityData[];
}

type RangePreset = {
  label: string;
  value: [Dayjs, Dayjs];
};

const presets: RangePreset[] = [
  { label: "Today", value: [dayjs(), dayjs()] },
  { label: "Last 3 Days", value: [dayjs().subtract(2, "day"), dayjs()] },
  { label: "Last 7 Days", value: [dayjs().subtract(6, "day"), dayjs()] },
  { label: "Last 10 Days", value: [dayjs().subtract(9, "day"), dayjs()] },
];

export default function DailyNewCustomersPage() {
  const [loading, setLoading] = useState(true);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>([dayjs(), dayjs()]);

  const fetchData = useCallback(async (range: [Dayjs, Dayjs]) => {
    setLoading(true);
    setError(null);
    try {
      const startDate = range[0].format("YYYY-MM-DD");
      const endDate = range[1].format("YYYY-MM-DD");
      const params = new URLSearchParams({ startDate, endDate });
      const res = await fetch(`/api/get-daily-new-customers-for-cities?${params}`);
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

  function downloadCsv(item: CityData) {
    const blob = new Blob([item.csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = item.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyEmails(item: CityData) {
    navigator.clipboard.writeText(item.csv);
    message.success(`Copied ${item.count} email(s) for ${item.city}`);
  }

  const totalNew = response?.data.reduce((sum, d) => sum + d.count, 0) ?? 0;

  const dateLabel =
    response?.startDate === response?.endDate
      ? response?.startDate
      : `${response?.startDate} to ${response?.endDate}`;

  const columns = [
    {
      title: "City",
      dataIndex: "city",
      key: "city",
      render: (city: string) => <Text strong>{city}</Text>,
    },
    {
      title: "New Customers",
      dataIndex: "count",
      key: "count",
      render: (count: number) =>
        count > 0 ? <Tag color="green">{count}</Tag> : <Tag>{count}</Tag>,
    },
    {
      title: "File",
      dataIndex: "filename",
      key: "filename",
      render: (filename: string) => <Text code>{filename}</Text>,
    },
    {
      title: "Actions",
      key: "actions",
      render: (_: unknown, record: CityData) => (
        <Space>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            disabled={record.count === 0}
            onClick={() => downloadCsv(record)}
          >
            CSV
          </Button>
          <Button
            size="small"
            icon={<CopyOutlined />}
            disabled={record.count === 0}
            onClick={() => copyEmails(record)}
          >
            Copy
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: 1100 }}>
      <Space direction="vertical" size="middle" style={{ width: "100%", marginBottom: 16 }}>
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <div>
            <Title level={3} style={{ margin: 0 }}>
              Get New Customers by City
            </Title>
            <Text type="secondary">
              Pick start and end date to get Get New Members in target cities
            </Text>
          </div>
        </Space>

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
            Get New Customers
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
      ) : response?.data.length === 0 ? (
        <Empty description="No data" />
      ) : (
        <Table
          dataSource={response?.data}
          columns={columns}
          rowKey="city"
          pagination={false}
          size="middle"
          expandable={{
            expandedRowRender: (record: CityData) => (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {(record.breakdown ?? []).map((sub) => (
                  <div key={sub.sublocation}>
                    <Text strong>{sub.sublocation}</Text>
                    <Tag style={{ marginLeft: 8 }}>{sub.emails.length}</Tag>
                    <div style={{ marginTop: 4 }}>
                      <Text type="secondary" style={{ wordBreak: "break-all" }}>
                        {sub.emails.join(", ")}
                      </Text>
                    </div>
                  </div>
                ))}
              </div>
            ),
            rowExpandable: (record: CityData) => record.count > 0,
          }}
        />
      )}
    </div>
  );
}
