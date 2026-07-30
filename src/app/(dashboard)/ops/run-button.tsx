"use client";

import { App, Button, Tooltip } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function RunButton(props: {
  slug: string;
  disabled?: boolean;
  cliOnly?: boolean;
  commandEquivalent?: string;
}) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  if (props.cliOnly || props.disabled) {
    return (
      <Tooltip
        title={
          props.commandEquivalent
            ? `CLI only: ${props.commandEquivalent}`
            : "Not runnable from dashboard"
        }
      >
        <Button size="small" disabled>
          CLI only
        </Button>
      </Tooltip>
    );
  }

  const handleRun = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ops/${props.slug}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.success) {
        message.success(data.summary || "Completed");
      } else {
        message.error(data.message || data.summary || "Op failed");
      }
      router.refresh();
    } catch {
      message.error("Failed to trigger op");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      type="primary"
      size="small"
      icon={<PlayCircleOutlined />}
      loading={loading}
      onClick={handleRun}
    >
      Run
    </Button>
  );
}
