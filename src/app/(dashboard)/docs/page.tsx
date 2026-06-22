"use client";

import { Alert, Card, Flex, List, Tag, Typography } from "antd";
import { LinkOutlined, LockOutlined } from "@ant-design/icons";

const { Title, Text, Paragraph } = Typography;

interface ServiceLink {
  name: string;
  description: string;
  url: string;
  tag?: string;
  note?: string;
}

interface ServiceGroup {
  title: string;
  items: ServiceLink[];
}

const groups: ServiceGroup[] = [
  {
    title: "WLTH WLKS workspaces & docs",
    items: [
      {
        name: "Airtable — WLTH WLKS",
        description: "Members source of truth (Active/Paid roster, city, profile fields)",
        url: "https://airtable.com/app61iqFshdS0a5Ys/tblMfhQQm6XeHsHe7/viwWNsEXjlaoDFLcQ",
      },
      {
        name: "Notion — Accesses",
        description: "Product Ops access matrix (who has access to what)",
        url: "https://app.notion.com/p/Accesses-3428c0a31eb480bea5a3e08eae2deb56",
      },
      {
        name: "Notion — WLTH WLKS Product SOPs",
        description: "Product Ops standard operating procedures",
        url: "https://app.notion.com/p/WLTH-WLKS-Product-SOPs-3648c0a31eb48000a4d6dc51e83959d5",
      },
      {
        name: "Miro — Product research",
        description: "Product research board (user flows, discovery notes, ideation)",
        url: "https://miro.com/app/board/uXjVGCNcr3k=/",
      },
    ],
  },
  {
    title: "Matching, intros & reporting",
    items: [
      {
        name: "Donut — Admin",
        description: "Donut workspace admin (channels, schedules)",
        url: "https://app.donut.ai/home",
      },
      {
        name: "Donut — Intros reporting",
        description: "Intros sent, accepted, met-up reporting",
        url: "https://app.donut.ai/reporting/intros",
      },
      {
        name: "Pinecone — WLTH WLKS org",
        description: "Vector index used for member-to-member matching · billing",
        url: "https://app.pinecone.io/organizations/-OsuHaplDcDkJVTr7cK_/settings/billing",
      },
    ],
  },
  {
    title: "Hosting, data & infra",
    items: [
      {
        name: "Vercel",
        description: "Production hosting, preview deploys, environment variables",
        url: "https://vercel.com/wlth-wlks-apps",
      },
      {
        name: "GitHub — wlthwlks/ops",
        description: "Source repo · pushes to main auto-deploy via Vercel",
        url: "https://github.com/wlthwlks/ops",
      },
    ],
  },
  {
    title: "AI & geocoding",
    items: [
      {
        name: "OpenAI",
        description: "Embeddings for member profiles (powers Pinecone search)",
        url: "https://platform.openai.com/api-keys",
      },
      {
        name: "Google Maps Platform",
        description: "Geocoding postcodes → lat/lng for nearby matching",
        url: "https://console.cloud.google.com/google/maps-apis/credentials",
        tag: "org admin only",
        note: "Google Cloud APIs belong to organisation admins — the demo@wlthwlks account does NOT have access. Request separate access via the Notion Accesses page before changes.",
      },
    ],
  },
  {
    title: "Messaging & delivery",
    items: [
      {
        name: "Resend",
        description: "Transactional email (match intros, oversight BCC)",
        url: "https://resend.com/overview",
      },
      {
        name: "Slack admin — wlth-wlks",
        description: "Workspace admin (members, channels, settings)",
        url: "https://wlth-wlks.slack.com/admin",
      },
      {
        name: "Slack app config",
        description: "Bot tokens, scopes, event subscriptions",
        url: "https://api.slack.com/apps",
      },
      {
        name: "Slack bulk operations — LemonSqueezy",
        description: "License & orders for the Bulk Slack User Deactivation Chrome extension (used on /remove-members)",
        url: "https://app.lemonsqueezy.com/my-orders/login",
      },
    ],
  },
];

export default function DocsPage() {
  return (
    <div style={{ maxWidth: 1100 }}>
      <Flex vertical gap="middle">
        <div>
          <Title level={3} style={{ margin: 0 }}>
            Docs &amp; Service Access
          </Title>
          <Text type="secondary">
            Logins for every third-party service this app integrates with, plus
            internal Product Ops docs.
          </Text>
        </div>

        <Alert
          type="info"
          showIcon
          icon={<LockOutlined />}
          message="Credentials live in LastPass"
          description={
            <Paragraph style={{ margin: 0 }}>
              <Text strong>demo@wlthwlks.com</Text> has access to all of the
              accounts below via the shared LastPass vault —{" "}
              <a
                href="https://lastpass.com/vault/"
                target="_blank"
                rel="noopener noreferrer"
              >
                lastpass.com/vault
              </a>
              . If a login isn&rsquo;t in the vault, ping the Product Ops owner
              listed in the Notion <em>Accesses</em> page below.
            </Paragraph>
          }
        />

        {groups.map((group) => (
          <Card key={group.title} title={group.title} size="small">
            <List
              itemLayout="horizontal"
              dataSource={group.items}
              renderItem={(item) => (
                <List.Item
                  actions={[
                    <a
                      key="open"
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <LinkOutlined /> Open
                    </a>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Flex gap="small" align="center" wrap="wrap">
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {item.name}
                        </a>
                        {item.tag && <Tag>{item.tag}</Tag>}
                      </Flex>
                    }
                    description={
                      <Flex vertical gap={4}>
                        <Text type="secondary">{item.description}</Text>
                        {item.note && (
                          <Text
                            type="warning"
                            style={{ fontSize: 12 }}
                          >
                            ⚠ {item.note}
                          </Text>
                        )}
                        <Text
                          type="secondary"
                          style={{ fontSize: 12, wordBreak: "break-all" }}
                        >
                          {item.url}
                        </Text>
                      </Flex>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        ))}
      </Flex>
    </div>
  );
}
