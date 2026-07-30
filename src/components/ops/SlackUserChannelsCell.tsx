"use client";

import { Popover, Space, Tag, Typography } from "antd";

export function SlackUserChannelsCell(props: {
  channels: Array<{ id: string; name: string; membership: string }>;
  maxVisible?: number;
}) {
  const max = props.maxVisible ?? 3;
  const members = props.channels.filter((c) => c.membership === "member");
  const notVisible = props.channels.filter((c) => c.membership === "not_visible");
  const visible = members.slice(0, max);
  const rest = members.slice(max);

  const fullList = (
    <div style={{ maxWidth: 320, maxHeight: 280, overflow: "auto" }}>
      {members.map((c) => (
        <div key={c.id}>
          <Tag>{c.name}</Tag>
        </div>
      ))}
      {notVisible.length > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {notVisible.length} channel(s) not visible to bot (membership not checked)
        </Typography.Text>
      )}
      {members.length === 0 && notVisible.length === 0 && (
        <Typography.Text type="secondary">No configured channels</Typography.Text>
      )}
    </div>
  );

  return (
    <Space size={4} wrap>
      {visible.map((c) => (
        <Tag key={c.id}>{c.name}</Tag>
      ))}
      {rest.length > 0 && (
        <Popover content={fullList} title="Channels">
          <Tag style={{ cursor: "pointer" }}>+{rest.length} more</Tag>
        </Popover>
      )}
      {members.length === 0 && notVisible.length > 0 && (
        <Tag color="orange">Not checked</Tag>
      )}
      {members.length === 0 && notVisible.length === 0 && (
        <Typography.Text type="secondary">—</Typography.Text>
      )}
    </Space>
  );
}
