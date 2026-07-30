"use client";

import { Alert, Button } from "antd";

export function ErrorState(props: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Alert
      type="error"
      showIcon
      title={props.title || "Something went wrong"}
      description={props.message}
      action={
        props.onRetry ? (
          <Button size="small" danger onClick={props.onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    />
  );
}
