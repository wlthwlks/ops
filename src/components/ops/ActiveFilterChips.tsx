"use client";

import { Button, Space, Tag } from "antd";

export type FilterChip = {
  key: string;
  label: string;
  onRemove: () => void;
};

export function ActiveFilterChips(props: {
  chips: FilterChip[];
  onClearAll: () => void;
}) {
  if (props.chips.length === 0) return null;
  return (
    <Space wrap style={{ marginBottom: 12 }}>
      {props.chips.map((c) => (
        <Tag key={c.key} closable onClose={c.onRemove} color="blue">
          {c.label}
        </Tag>
      ))}
      <Button size="small" type="link" onClick={props.onClearAll}>
        Clear all
      </Button>
    </Space>
  );
}
