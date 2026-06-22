"use client";

import { Alert, Card, Flex, List, Table, Tag, Typography } from "antd";
import { DatabaseOutlined, LinkOutlined, LockOutlined } from "@ant-design/icons";

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
        name: "Slack — match-maker bot",
        description: "Collaborators & settings for the match-maker bot app",
        url: "https://app.slack.com/app-settings/T0ASD0GD8E4/A0B7861TNM9/collaborators",
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

        <MatchmakingDataModel />
      </Flex>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Matchmaking data model — Neon Postgres tables written by the matchmake flow
// (src/db/schema/* + src/lib/matchmake/record.ts).
// ---------------------------------------------------------------------------

interface ColumnRow {
  column: string;
  type: string;
  notes: string;
}

interface DbTable {
  name: string;
  purpose: string;
  written: string;
  columns: ColumnRow[];
}

const dbTables: DbTable[] = [
  {
    name: "match_events",
    purpose: "One row per matchmake request — the parent record for a single run.",
    written: "On every POST to /api/matchmake (one row per request).",
    columns: [
      { column: "id", type: "text PK", notes: "Internal ULID/UUID for the event." },
      { column: "request_id", type: "text · unique", notes: "Client-supplied idempotency key; deduplicates retries." },
      { column: "created_at", type: "timestamptz", notes: "When the event was recorded." },
      { column: "initiated_by", type: "text", notes: "User/email that triggered the run (nullable for cron)." },
      { column: "mode", type: "text", notes: "e.g. 'manual', 'preview', 'send-all'." },
      { column: "dry_run", type: "boolean", notes: "True for preview-only runs that did not send." },
      { column: "new_member_id", type: "text FK → members.id", notes: "Local member row for the new joiner (nullable)." },
      { column: "new_member_email", type: "text", notes: "Email of the new joiner being matched." },
      { column: "new_member_postcode", type: "text", notes: "Postcode used for nearby filtering." },
      { column: "new_member_city", type: "text", notes: "Resolved canonical city label." },
      { column: "new_member_industry", type: "text", notes: "Industry / tag (nullable)." },
      { column: "summary", type: "text", notes: "Free-text run summary for the UI." },
      { column: "error", type: "text", notes: "Error message if the run failed (nullable)." },
      { column: "slack_channel_id", type: "text", notes: "Slack channel/DM the match card was posted to." },
      { column: "slack_message_ts", type: "text", notes: "Slack message timestamp for the posted card." },
      { column: "slack_sent_at", type: "timestamptz", notes: "When the Slack post was delivered." },
      { column: "slack_recipient_count", type: "integer", notes: "How many people the Slack group DM reached." },
      { column: "deleted_at", type: "timestamptz", notes: "Soft-delete marker (nullable)." },
    ],
  },
  {
    name: "match_event_matches",
    purpose: "Suggested matches for an event — one row per ranked candidate.",
    written: "After Pinecone search returns candidates for a match_events row.",
    columns: [
      { column: "id", type: "text PK", notes: "Internal ULID/UUID for the match row." },
      { column: "match_event_id", type: "text FK → match_events.id (cascade)", notes: "Parent event." },
      { column: "rank", type: "integer", notes: "1-based rank (1 = best similarity)." },
      { column: "match_member_id", type: "text FK → members.id", notes: "Local member row for the match (nullable)." },
      { column: "match_email", type: "text", notes: "Email of the suggested match." },
      { column: "match_postcode", type: "text", notes: "Postcode of the match (nullable)." },
      { column: "match_city", type: "text", notes: "Canonical city of the match." },
      { column: "match_industry", type: "text", notes: "Industry / tag of the match (nullable)." },
      { column: "similarity_score", type: "real", notes: "Pinecone cosine similarity (0–1, higher = closer)." },
      { column: "was_on_slack", type: "boolean", notes: "Whether the match was already in the Slack workspace at send time." },
    ],
  },
  {
    name: "email_deliveries",
    purpose: "One row per email actually sent (or attempted) for a match event.",
    written: "After each Resend send call — including oversight BCC recipients.",
    columns: [
      { column: "id", type: "text PK", notes: "Internal ULID/UUID for the delivery." },
      { column: "match_event_id", type: "text FK → match_events.id (cascade)", notes: "Parent event." },
      { column: "chaser_id", type: "text", notes: "Reserved for Phase 2 chaser FK (no constraint yet)." },
      { column: "recipient_email", type: "text", notes: "Address the email was sent to." },
      { column: "recipient_role", type: "text", notes: "'new_member' · 'match' · 'oversight'." },
      { column: "resend_message_id", type: "text", notes: "Resend's message ID — joinable to webhook events." },
      { column: "status", type: "text", notes: "'sent' or 'failed'." },
      { column: "error", type: "text", notes: "Resend error message if status='failed' (nullable)." },
      { column: "sent_at", type: "timestamptz", notes: "When we attempted the send." },
      { column: "last_event_at", type: "timestamptz", notes: "Most recent Resend webhook event (delivered/opened/bounced)." },
    ],
  },
  {
    name: "members",
    purpose: "Local mirror of the small set of member fields the matchmake flow needs (joins on email).",
    written: "Lazily, the first time we record a match event involving a given email.",
    columns: [
      { column: "id", type: "text PK", notes: "Internal ULID/UUID." },
      { column: "email", type: "text · unique", notes: "Member email — the join key with Airtable." },
      { column: "airtable_record_id", type: "text", notes: "Pointer back to the Airtable Members row." },
      { column: "pinecone_id", type: "text", notes: "Pointer to the Pinecone vector ID for this member." },
      { column: "first_seen_at", type: "timestamptz", notes: "When we first persisted this email locally." },
    ],
  },
];

function MatchmakingDataModel() {
  return (
    <Flex vertical gap="middle">
      <div>
        <Title level={4} style={{ margin: 0 }}>
          <DatabaseOutlined /> Matchmaking data model
        </Title>
        <Text type="secondary">
          Postgres tables written by the custom-matching flow (
          <code>src/db/schema/*</code> via{" "}
          <code>src/lib/matchmake/record.ts</code>). Hosted on Neon —{" "}
          <code>POSTGRES_URL</code> in env. All tables use soft delete where
          applicable and cascade child rows on event deletion.
        </Text>
      </div>

      {dbTables.map((t) => (
        <Card
          key={t.name}
          size="small"
          title={
            <Flex gap="small" align="center" wrap="wrap">
              <code style={{ fontSize: 14 }}>{t.name}</code>
              <Tag>{t.columns.length} columns</Tag>
            </Flex>
          }
        >
          <Flex vertical gap="small">
            <Text type="secondary">{t.purpose}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              <strong>Written:</strong> {t.written}
            </Text>
            <Table<ColumnRow>
              size="small"
              pagination={false}
              rowKey="column"
              dataSource={t.columns}
              columns={[
                {
                  title: "Column",
                  dataIndex: "column",
                  key: "column",
                  width: 220,
                  render: (v: string) => <code>{v}</code>,
                },
                {
                  title: "Type",
                  dataIndex: "type",
                  key: "type",
                  width: 240,
                  render: (v: string) => (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {v}
                    </Text>
                  ),
                },
                {
                  title: "Notes",
                  dataIndex: "notes",
                  key: "notes",
                },
              ]}
            />
          </Flex>
        </Card>
      ))}
    </Flex>
  );
}
