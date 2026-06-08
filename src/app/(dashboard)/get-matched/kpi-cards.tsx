"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Col, Row, Statistic, Tooltip, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

const { Text, Title } = Typography;

const CARD_MIN_HEIGHT = 130;
const CARD_STYLE = { height: "100%", minHeight: CARD_MIN_HEIGHT } as const;

const RED = "#cf1322";
const SUCCESS_RATE_RED_THRESHOLD_PCT = 95;
const SUCCESS_RATE_MIN_VOLUME_FOR_RED = 5;
const STALE_LAST_SEND_HOURS = 24;

interface EmailSuccessRate {
  sent: number;
  failed: number;
  pct: number | null;
}

interface KpisResponse {
  matchesSentToday: number;
  membersReachedToday: number;
  emailSuccessRate: EmailSuccessRate;
  lastSendAt: string | null;
  generatedAt: string;
}

interface FetchState {
  data: KpisResponse | null;
  loading: boolean;
  error: string | null;
  fetchedAt: Date | null;
}

const INITIAL_STATE: FetchState = {
  data: null,
  loading: false,
  error: null,
  fetchedAt: null,
};

function emailRateColor(rate: EmailSuccessRate): string | undefined {
  const total = rate.sent + rate.failed;
  if (rate.pct === null) return undefined;
  if (
    rate.pct < SUCCESS_RATE_RED_THRESHOLD_PCT &&
    total >= SUCCESS_RATE_MIN_VOLUME_FOR_RED
  ) {
    return RED;
  }
  return undefined;
}

function lastSendColor(lastSendAt: string | null): string | undefined {
  if (!lastSendAt) return RED;
  const ageHours = dayjs().diff(dayjs(lastSendAt), "hour", true);
  return ageHours > STALE_LAST_SEND_HOURS ? RED : undefined;
}

export function KpiCards() {
  const [state, setState] = useState<FetchState>(INITIAL_STATE);

  const fetchKpis = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetch("/api/matchmake/kpis", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Request failed: ${res.status}`);
      }
      const data = (await res.json()) as KpisResponse;
      setState({
        data,
        loading: false,
        error: null,
        fetchedAt: new Date(),
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Network error",
      }));
    }
  }, []);

  useEffect(() => {
    void fetchKpis();
  }, [fetchKpis]);

  const data = state.data;
  const rate = data?.emailSuccessRate;
  const rateColor = rate ? emailRateColor(rate) : undefined;
  const sendColor = lastSendColor(data?.lastSendAt ?? null);

  const lastSendDisplay = (() => {
    if (!data) return "—";
    if (!data.lastSendAt) return "Never";
    return dayjs(data.lastSendAt).fromNow();
  })();

  const lastSendTooltip = data?.lastSendAt
    ? dayjs(data.lastSendAt).format("YYYY-MM-DD HH:mm:ss Z")
    : "No sends recorded";

  const fetchedAtCaption = state.fetchedAt
    ? `Updated ${dayjs(state.fetchedAt).fromNow()}`
    : state.loading
      ? "Loading…"
      : "";

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <div>
          <Title level={4} style={{ margin: 0 }}>
            Match-making activity today
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {fetchedAtCaption}
          </Text>
        </div>
        <Tooltip title="Refresh KPIs">
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => void fetchKpis()}
            loading={state.loading}
            aria-label="Refresh KPIs"
          />
        </Tooltip>
      </div>

      {state.error && (
        <Card
          size="small"
          style={{
            marginBottom: 12,
            background: "#fff2f0",
            borderColor: "#ffccc7",
          }}
        >
          <Text type="danger">Failed to load KPIs: {state.error}</Text>
        </Card>
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small" style={CARD_STYLE}>
            <Statistic
              title="Matches sent today"
              value={data?.matchesSentToday ?? 0}
              loading={state.loading && !data}
            />
          </Card>
        </Col>

        <Col xs={24} sm={12} lg={6}>
          <Card size="small" style={CARD_STYLE}>
            <Statistic
              title="Members reached today"
              value={data?.membersReachedToday ?? 0}
              loading={state.loading && !data}
            />
          </Card>
        </Col>

        <Col xs={24} sm={12} lg={6}>
          <Card size="small" style={CARD_STYLE}>
            <Statistic
              title="Email success rate"
              value={rate?.pct ?? "—"}
              suffix={rate?.pct !== null && rate?.pct !== undefined ? "%" : ""}
              precision={rate?.pct !== null && rate?.pct !== undefined ? 2 : undefined}
              valueStyle={rateColor ? { color: rateColor } : undefined}
              loading={state.loading && !data}
            />
            {rate && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {rate.sent}/{rate.sent + rate.failed}
              </Text>
            )}
          </Card>
        </Col>

        <Col xs={24} sm={12} lg={6}>
          <Card size="small" style={CARD_STYLE}>
            <Tooltip title={lastSendTooltip}>
              <Statistic
                title="Last send"
                value={lastSendDisplay}
                valueStyle={sendColor ? { color: sendColor } : undefined}
                loading={state.loading && !data}
              />
            </Tooltip>
          </Card>
        </Col>
      </Row>
    </div>
  );
}

export default KpiCards;
