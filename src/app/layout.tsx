import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider } from "antd";
import {
  ClerkProvider,
  SignInButton,
  SignUpButton,
  Show,
  UserButton,
} from "@clerk/nextjs";

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
              <header style={{ display: "flex", gap: 8, padding: "8px 16px", justifyContent: "flex-end" }}>
                <Show when="signed-out">
                  <SignInButton />
                  <SignUpButton />
                </Show>
                <Show when="signed-in">
                  <UserButton />
                </Show>
              </header>
              {children}
            </ConfigProvider>
          </AntdRegistry>
        </ClerkProvider>
      </body>
    </html>
  );
}
