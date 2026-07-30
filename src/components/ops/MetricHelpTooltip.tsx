"use client";

import { Tooltip } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";

export function MetricHelpTooltip(props: {
  title: string;
  /** Concise operational explanation */
  content: string;
}) {
  return (
    <Tooltip title={props.content} placement="top">
      <button
        type="button"
        aria-label={`About ${props.title}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          border: "none",
          background: "transparent",
          padding: 0,
          marginLeft: 6,
          cursor: "help",
          color: "rgba(0,0,0,0.45)",
          verticalAlign: "middle",
          lineHeight: 1,
        }}
      >
        <InfoCircleOutlined />
      </button>
    </Tooltip>
  );
}

export function SectionHelpTooltip(props: { title: string; content: string }) {
  return <MetricHelpTooltip title={props.title} content={props.content} />;
}
