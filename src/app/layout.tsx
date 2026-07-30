import { AntdRegistry } from "@ant-design/nextjs-registry";
import { App, ConfigProvider } from "antd";
import { ClerkProvider } from "@clerk/nextjs";

export const metadata = {
  title: "WLTH WLKS Ops",
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
        <ClerkProvider>
          <AntdRegistry>
            <ConfigProvider
              theme={{
                token: {
                  colorPrimary: "#1677ff",
                },
              }}
            >
              <App>{children}</App>
            </ConfigProvider>
          </AntdRegistry>
        </ClerkProvider>
      </body>
    </html>
  );
}
