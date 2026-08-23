"use client";

import { Button, Card, Col, DatePicker, Input, Row, Select, Typography } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { SearchOutlined } from "@ant-design/icons";

const { RangePicker } = DatePicker;

export type SlackFilterState = {
  q?: string;
  city?: string;
  membership?: string;
  payment?: string;
  dateFrom?: string;
  dateTo?: string;
};

export type SlackFilterOptions = {
  cities: string[];
  memberships: string[];
  payments: string[];
};

export function filterBySearch<T>(
  rows: T[],
  q: string,
  pick: (r: T) => string[]
): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) =>
    pick(r).some((v) => v.toLowerCase().includes(needle))
  );
}

export function filterByDateRange<T>(
  rows: T[],
  from: string | undefined,
  to: string | undefined,
  getDate: (r: T) => string
): T[] {
  const fromMs = from ? new Date(from).getTime() : null;
  const toMs = to ? new Date(to).getTime() : null;
  if (fromMs === null && toMs === null) return rows;
  return rows.filter((r) => {
    const t = new Date(getDate(r)).getTime();
    if (Number.isNaN(t)) return false;
    if (fromMs !== null && t < fromMs) return false;
    if (toMs !== null && t > toMs) return false;
    return true;
  });
}

/**
 * Shared filter card for the Slack community tabs: search, city, membership,
 * payment and a Date joined range, plus a per-tab `extra` slot (segmented
 * status filters). No loose checkboxes — real labelled controls.
 */
export function SlackCommunityFilters(props: {
  value: SlackFilterState;
  options: SlackFilterOptions;
  onChange: (next: SlackFilterState) => void;
  onClear: () => void;
  extra?: React.ReactNode;
}) {
  const { value, options } = props;
  const active =
    Boolean(value.q) ||
    Boolean(value.city) ||
    Boolean(value.membership) ||
    Boolean(value.payment) ||
    Boolean(value.dateFrom) ||
    Boolean(value.dateTo);

  const set = <K extends keyof SlackFilterState>(key: K, v: SlackFilterState[K]) =>
    props.onChange({ ...value, [key]: v });

  const rangeValue: [Dayjs, Dayjs] | null =
    value.dateFrom || value.dateTo
      ? [
          value.dateFrom ? dayjs(value.dateFrom) : (null as unknown as Dayjs),
          value.dateTo ? dayjs(value.dateTo) : (null as unknown as Dayjs),
        ]
      : null;

  const label = (text: string) => (
    <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>
      {text}
    </Typography.Text>
  );

  return (
    <Card size="small" style={{ marginBottom: 12 }}>
      <Row gutter={[12, 12]} align="bottom">
        <Col xs={24} md={10} lg={7}>
          {label("Search")}
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="Name or email"
            value={value.q || ""}
            onChange={(e) => set("q", e.target.value || undefined)}
          />
        </Col>
        <Col xs={12} md={7} lg={4}>
          {label("City")}
          <Select
            allowClear
            showSearch
            placeholder="All cities"
            style={{ width: "100%" }}
            value={value.city || undefined}
            onChange={(v) => set("city", v || undefined)}
            options={options.cities.map((c) => ({ value: c, label: c }))}
          />
        </Col>
        <Col xs={12} md={7} lg={4}>
          {label("Membership")}
          <Select
            allowClear
            placeholder="All"
            style={{ width: "100%" }}
            value={value.membership || undefined}
            onChange={(v) => set("membership", v || undefined)}
            options={options.memberships.map((m) => ({ value: m, label: m }))}
          />
        </Col>
        <Col xs={12} md={7} lg={4}>
          {label("Payment")}
          <Select
            allowClear
            placeholder="All"
            style={{ width: "100%" }}
            value={value.payment || undefined}
            onChange={(v) => set("payment", v || undefined)}
            options={options.payments.map((p) => ({ value: p, label: p }))}
          />
        </Col>
        <Col xs={12} md={7} lg={5}>
          {label("Date joined")}
          <RangePicker
            style={{ width: "100%" }}
            value={rangeValue}
            onChange={(dates) => {
              const [from, to] = dates || [null, null];
              props.onChange({
                ...value,
                dateFrom: from ? from.format("YYYY-MM-DD") : undefined,
                dateTo: to ? to.format("YYYY-MM-DD") : undefined,
              });
            }}
          />
        </Col>
        {props.extra ? (
          <Col xs={24} lg={8}>
            {props.extra}
          </Col>
        ) : null}
        {active && (
          <Col flex="auto" style={{ textAlign: "right" }}>
            <Button size="small" type="link" onClick={props.onClear}>
              Clear filters
            </Button>
          </Col>
        )}
      </Row>
    </Card>
  );
}
