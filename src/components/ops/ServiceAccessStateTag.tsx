"use client";

import { Tag } from "antd";

export function ServiceAccessStateTag(props: { state: string }) {
  const s = props.state;
  if (s === "current") return <Tag color="success">Current</Tag>;
  if (s === "grace") return <Tag color="processing">Grace</Tag>;
  if (s === "expired") return <Tag color="error">Expired</Tag>;
  if (s === "invalid_date") return <Tag color="warning">Invalid date</Tag>;
  if (s === "no_member") return <Tag>No Airtable</Tag>;
  return <Tag>{s}</Tag>;
}
