"use client";

import { Tooltip } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";

export function TabHelpLabel(props: {
  label: string;
  help: string;
  /** aria-label for the help control */
  helpAriaLabel?: string;
}) {
  const aria = props.helpAriaLabel || `About ${props.label}`;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span>{props.label}</span>
      <Tooltip title={props.help} placement="top">
        <button
          type="button"
          aria-label={aria}
          tabIndex={0}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") e.stopPropagation();
          }}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            cursor: "help",
            color: "rgba(0,0,0,0.45)",
            lineHeight: 1,
            display: "inline-flex",
          }}
        >
          <InfoCircleOutlined aria-hidden />
        </button>
      </Tooltip>
    </span>
  );
}
