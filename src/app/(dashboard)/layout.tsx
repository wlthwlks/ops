"use client";

import { useState } from "react";
import { Layout, Menu } from "antd";
import { TeamOutlined, RiseOutlined, UserDeleteOutlined, UsergroupAddOutlined } from "@ant-design/icons";
import { useRouter, usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";

const { Sider, Content, Header } = Layout;

const menuItems = [
  { key: "/get-daily-new-customers-for-cities", icon: <TeamOutlined />, label: "Get New Members" },
  { key: "/growing-cities", icon: <RiseOutlined />, label: "See Growing Cities" },
  { key: "/remove-members", icon: <UserDeleteOutlined />, label: "Remove Members" },
  { key: "/get-matched", icon: <UsergroupAddOutlined />, label: "Custom Matching" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} theme="light" style={{ borderRight: "1px solid #f0f0f0" }}>
        <div style={{ height: 48, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600, fontSize: collapsed ? 14 : 16, borderBottom: "1px solid #f0f0f0" }}>
          {collapsed ? "Ops" : "WLTH WLKS Ops"}
        </div>
        <Menu mode="inline" selectedKeys={[pathname]} items={menuItems} onClick={({ key }) => router.push(key)} style={{ borderRight: 0 }} />
      </Sider>
      <Layout>
        <Header style={{ background: "#fff", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "flex-end", borderBottom: "1px solid #f0f0f0", height: 48, lineHeight: "48px" }}>
          <UserButton />
        </Header>
        <Content style={{ padding: 24, background: "#fafafa" }}>{children}</Content>
      </Layout>
    </Layout>
  );
}
