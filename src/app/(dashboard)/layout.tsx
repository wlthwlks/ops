"use client";

import { useState } from "react";
import { Layout, Menu } from "antd";
import { TeamOutlined, RiseOutlined, UserDeleteOutlined } from "@ant-design/icons";
import { useRouter, usePathname } from "next/navigation";

const { Sider, Content } = Layout;

const menuItems = [
  { key: "/get-daily-new-customers-for-cities", icon: <TeamOutlined />, label: "Get New Members" },
  { key: "/growing-cities", icon: <RiseOutlined />, label: "See Growing Cities" },
  { key: "/remove-members", icon: <UserDeleteOutlined />, label: "Remove Members" },
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
      <Content style={{ padding: 24, background: "#fafafa" }}>{children}</Content>
    </Layout>
  );
}
