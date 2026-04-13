import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider } from "antd";

export const metadata = {
  title: "Community Ops",
  description: "Internal ops platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AntdRegistry>
          <ConfigProvider
            theme={{
              token: {
                colorPrimary: "#1677ff",
              },
            }}
          >
            {children}
          </ConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
