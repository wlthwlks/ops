"use client";

import { useEffect, useMemo, useState } from "react";
import { Layout, Menu, theme } from "antd";
import {
  TeamOutlined,
  RiseOutlined,
  UsergroupAddOutlined,
  BookOutlined,
  SwapOutlined,
  DashboardOutlined,
  AlertOutlined,
  SlackOutlined,
  DollarOutlined,
  ToolOutlined,
  UnorderedListOutlined,
  WarningOutlined,
  BarChartOutlined,
  ApartmentOutlined,
  EnvironmentOutlined,
  SettingOutlined,
  MailOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { useRouter, usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { RuntimeModeBadge } from "@/components/ops/RuntimeModeBadge";

const { Sider, Content, Header } = Layout;

type NavItem = {
  key: string;
  icon?: React.ReactNode;
  label: string;
  children?: NavItem[];
};

const NAV: NavItem[] = [
  {
    key: "overview",
    label: "Overview",
    children: [
      { key: "/overview", icon: <DashboardOutlined />, label: "Operations Overview" },
    ],
  },
  {
    key: "member-mgmt",
    label: "Member Management",
    children: [
      { key: "/members", icon: <UnorderedListOutlined />, label: "Member Directory" },
      { key: "/members/issues", icon: <AlertOutlined />, label: "Data Issues" },
      { key: "/members/slack-access", icon: <SlackOutlined />, label: "Slack Community" },
      { key: "/members/billing", icon: <DollarOutlined />, label: "Billing Integrity" },
      {
        key: "/get-daily-new-customers-for-cities",
        icon: <TeamOutlined />,
        label: "New Members",
      },
    ],
  },
  {
    key: "communities",
    label: "Communities",
    children: [
      { key: "/growing-cities", icon: <RiseOutlined />, label: "City Growth" },
    ],
  },
  {
    key: "intros",
    label: "Introductions",
    children: [
      { key: "/introductions", icon: <ApartmentOutlined />, label: "Introductions Overview" },
      { key: "/introductions/city-runs", icon: <EnvironmentOutlined />, label: "City Runs" },
      { key: "/introductions/settings", icon: <SettingOutlined />, label: "Matching Settings" },
      { key: "/introductions/templates", icon: <MailOutlined />, label: "Email Templates" },
      { key: "/introductions/deliveries", icon: <SendOutlined />, label: "Delivery History" },
    ],
  },
  {
    key: "intros-legacy",
    label: "Introductions (legacy)",
    children: [
      { key: "/get-matched", icon: <UsergroupAddOutlined />, label: "Custom Matching" },
      { key: "/recurring-intros", icon: <SwapOutlined />, label: "Recurring Introductions" },
    ],
  },
  {
    key: "system",
    label: "System",
    children: [
      { key: "/ops", icon: <ToolOutlined />, label: "Operations" },
      {
        key: "/ops/webhook-errors",
        icon: <WarningOutlined />,
        label: "Webhook errors",
      },
      {
        key: "/ops/form-analytics",
        icon: <BarChartOutlined />,
        label: "Form analytics",
      },
      { key: "/docs", icon: <BookOutlined />, label: "Docs & Access" },
    ],
  },
];

function selectedKey(pathname: string): string {
  if (pathname.startsWith("/members/issues")) return "/members/issues";
  if (pathname.startsWith("/members/slack-access")) return "/members/slack-access";
  if (pathname.startsWith("/members/billing")) return "/members/billing";
  if (pathname.startsWith("/members")) return "/members";
  if (pathname.startsWith("/ops/webhook-errors")) return "/ops/webhook-errors";
  if (pathname.startsWith("/ops/form-analytics")) return "/ops/form-analytics";
  if (pathname.startsWith("/ops")) return "/ops";
  if (pathname.startsWith("/introductions/city-runs")) return "/introductions/city-runs";
  if (pathname.startsWith("/introductions/settings")) return "/introductions/settings";
  if (pathname.startsWith("/introductions/templates")) return "/introductions/templates";
  if (pathname.startsWith("/introductions/deliveries")) return "/introductions/deliveries";
  if (pathname.startsWith("/introductions")) return "/introductions";
  if (pathname.startsWith("/recurring-intros")) return "/recurring-intros";
  if (pathname.startsWith("/get-matched")) return "/get-matched";
  if (pathname.startsWith("/overview")) return "/overview";
  return pathname;
}

function openKeysFor(pathname: string): string[] {
  const key = selectedKey(pathname);
  for (const group of NAV) {
    if (group.children?.some((c) => c.key === key || key.startsWith(c.key))) {
      return [group.key];
    }
  }
  return ["overview"];
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mode, setMode] = useState<string>("read_only");
  const [role, setRole] = useState<string>("");
  const router = useRouter();
  const pathname = usePathname();
  const { token } = theme.useToken();

  useEffect(() => {
    fetch("/api/ops-dashboard/config")
      .then((r) => r.json())
      .then((d) => {
        if (d.mode) setMode(d.mode);
        if (d.role) setRole(d.role);
      })
      .catch(() => {});
  }, []);

  const selected = selectedKey(pathname);
  const defaultOpen = useMemo(() => openKeysFor(pathname), [pathname]);

  const items = NAV.map((group) => ({
    key: group.key,
    label: group.label,
    type: "group" as const,
    children: group.children?.map((c) => ({
      key: c.key,
      icon: c.icon,
      label: c.label,
    })),
  }));

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="light"
        width={240}
        style={{ borderRight: `1px solid ${token.colorBorderSecondary}` }}
      >
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <div
            style={{
              height: 48,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 600,
              fontSize: collapsed ? 14 : 15,
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              flexShrink: 0,
            }}
          >
            {collapsed ? "Ops" : "WLTH WLKS Ops"}
          </div>
          <Menu
            mode="inline"
            selectedKeys={[selected]}
            defaultOpenKeys={defaultOpen}
            items={items}
            onClick={({ key }) => {
              if (key.startsWith("/")) router.push(key);
            }}
            style={{ borderRight: 0, flex: 1, overflow: "auto" }}
          />
        </div>
      </Sider>
      <Layout>
        <Header
          style={{
            background: token.colorBgContainer,
            padding: "0 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            height: 48,
            lineHeight: "48px",
            position: "sticky",
            top: 0,
            zIndex: 20,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <RuntimeModeBadge mode={mode} />
            {role && (
              <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
                Role: {role}
              </span>
            )}
          </div>
          <UserButton />
        </Header>
        <Content style={{ padding: 24, background: token.colorBgLayout, minHeight: 280 }}>
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}
