"use client";

import { Button, message } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function RunButton({ slug }: { slug: string }) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleRun = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ops/${slug}/run`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        message.success(data.summary);
      } else {
        message.error(data.summary || "Op failed");
      }
      router.refresh();
    } catch {
      message.error("Failed to trigger op");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button type="primary" size="small" icon={<PlayCircleOutlined />} loading={loading} onClick={handleRun}>
      Run Now
    </Button>
  );
}
