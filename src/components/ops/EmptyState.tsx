"use client";

import { Empty, Button } from "antd";

export function EmptyState(props: {
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <div>
          <div style={{ fontWeight: 600 }}>{props.title || "Nothing here"}</div>
          {props.description && (
            <div style={{ color: "rgba(0,0,0,0.45)", marginTop: 4 }}>{props.description}</div>
          )}
        </div>
      }
    >
      {props.onAction && props.actionLabel && (
        <Button type="primary" onClick={props.onAction}>
          {props.actionLabel}
        </Button>
      )}
    </Empty>
  );
}
