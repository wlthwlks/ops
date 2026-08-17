"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Flex,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { PlusOutlined, ReloadOutlined, SendOutlined } from "@ant-design/icons";

const { Title, Text } = Typography;

interface TemplateRow {
  template: { id: string; name: string; status: string; updatedAt: string };
  latestVersion: { id: string; version: number; subject: string; bodyHtml: string } | null;
}

interface VersionRow {
  id: string;
  version: number;
  subject: string;
  bodyHtml: string;
  createdAt: string;
}

const PLACEHOLDER_HINTS = [
  "{{first_name}}",
  "{{city}}",
  "{{introduction_date}}",
  "{{members}}",
  "{{why_you_matched}}",
  "{{coordination_text}}",
  "{{meetup_suggestion}}",
  "{{group_size_word}}",
];

export default function IntroductionsTemplatesPage() {
  const { message } = App.useApp();
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [validation, setValidation] = useState<{ ok: boolean; issues: string[] } | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewSubject, setPreviewSubject] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createSubject, setCreateSubject] = useState("Meet your {{city}} introductions");
  const [createBody, setCreateBody] = useState(
    "<p>Hi {{first_name}},</p><p>Welcome to your {{city}} introductions for {{introduction_date}}.</p>{{members}}{{why_you_matched}}<p>{{coordination_text}}</p>"
  );

  const [testOpen, setTestOpen] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testSending, setTestSending] = useState(false);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/introductions/templates", { cache: "no-store" });
      const body = await res.json();
      setTemplates(body.templates ?? []);
    } catch {
      message.error("Could not load templates");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const loadTemplateDetail = async (templateId: string) => {
    setSelectedTemplateId(templateId);
    try {
      const res = await fetch(`/api/introductions/templates/${templateId}`, { cache: "no-store" });
      const body = await res.json();
      setVersions(body.versions ?? []);
      if (body.latestVersion) {
        setSubject(body.latestVersion.subject);
        setBodyHtml(body.latestVersion.bodyHtml);
      }
    } catch {
      message.error("Could not load template");
    }
  };

  const insertPlaceholder = (placeholder: string) => {
    setBodyHtml((html) => `${html}${placeholder}`);
  };

  const saveVersion = async () => {
    if (!selectedTemplateId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/introductions/templates/${selectedTemplateId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, bodyHtml }),
      });
      const body = await res.json();
      if (!res.ok) {
        message.error(body.message ?? "Could not save");
        return;
      }
      setValidation(body.validation ?? null);
      message.success(`Saved version ${body.version.version}`);
      await loadTemplateDetail(selectedTemplateId);
    } catch {
      message.error("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!selectedTemplateId) return;
    try {
      const res = await fetch(`/api/introductions/templates/${selectedTemplateId}/publish`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) {
        message.error(body.message ?? "Could not publish");
        return;
      }
      message.success(`Published version ${body.version.version}`);
      await Promise.all([loadTemplateDetail(selectedTemplateId), loadTemplates()]);
    } catch {
      message.error("Publish failed");
    }
  };

  const restore = async (versionId: string) => {
    if (!selectedTemplateId) return;
    try {
      const res = await fetch(`/api/introductions/templates/${selectedTemplateId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId }),
      });
      const body = await res.json();
      if (!res.ok) {
        message.error(body.message ?? "Could not restore");
        return;
      }
      message.success(`Restored as version ${body.version.version}`);
      await loadTemplateDetail(selectedTemplateId);
    } catch {
      message.error("Restore failed");
    }
  };

  const preview = async () => {
    try {
      const res = await fetch("/api/introductions/templates/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, bodyHtml }),
      });
      const body = await res.json();
      if (!res.ok) {
        message.error(body.message ?? "Preview failed");
        return;
      }
      setPreviewSubject(body.subject);
      setPreviewHtml(body.html);
    } catch {
      message.error("Preview failed");
    }
  };

  const testSend = async () => {
    if (!selectedTemplateId) return;
    setTestSending(true);
    try {
      const res = await fetch(`/api/introductions/templates/${selectedTemplateId}/test-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testTo }),
      });
      const body = await res.json();
      if (!res.ok) {
        message.error(body.message ?? "Test send failed");
        return;
      }
      message.success(`Test email sent (${body.resendMessageId})`);
      setTestOpen(false);
    } catch {
      message.error("Test send failed");
    } finally {
      setTestSending(false);
    }
  };

  const createTemplate = async () => {
    try {
      const res = await fetch("/api/introductions/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createName, subject: createSubject, bodyHtml: createBody }),
      });
      const body = await res.json();
      if (!res.ok) {
        message.error(body.message ?? "Could not create template");
        return;
      }
      message.success("Template created");
      setCreateOpen(false);
      setCreateName("");
      await loadTemplates();
    } catch {
      message.error("Create template failed");
    }
  };

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Title level={4} style={{ margin: 0 }}>
          Email Templates
        </Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void loadTemplates()} loading={loading}>
            Refresh
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            New template
          </Button>
        </Space>
      </Flex>

      <Card size="small" title="Templates">
        <Table<TemplateRow>
          rowKey={(row) => row.template.id}
          loading={loading}
          size="small"
          pagination={false}
          dataSource={templates}
          onRow={(row) => ({ onClick: () => void loadTemplateDetail(row.template.id), style: { cursor: "pointer" } })}
          rowClassName={(row) => (row.template.id === selectedTemplateId ? "ant-table-row-selected" : "")}
          columns={[
            {
              title: "Name",
              render: (_, row) => (
                <Space>
                  <Text strong>{row.template.name}</Text>
                  <Tag color={row.template.status === "published" ? "green" : "default"}>
                    {row.template.status}
                  </Tag>
                </Space>
              ),
            },
            {
              title: "Latest version",
              render: (_, row) => (row.latestVersion ? `v${row.latestVersion.version}` : "—"),
            },
          ]}
        />
      </Card>

      {selectedTemplateId && (
        <Flex gap={16} wrap>
          <Card size="small" title="Editor" style={{ flex: 2, minWidth: 420 }}>
            <Flex vertical gap={12}>
              <Flex gap={8} align="center">
                <Text strong style={{ minWidth: 60 }}>
                  Subject
                </Text>
                <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
              </Flex>
              <Flex gap={8} wrap>
                {PLACEHOLDER_HINTS.map((placeholder) => (
                  <Button key={placeholder} size="small" onClick={() => insertPlaceholder(placeholder)}>
                    {placeholder}
                  </Button>
                ))}
              </Flex>
              <Input.TextArea
                rows={14}
                value={bodyHtml}
                onChange={(event) => setBodyHtml(event.target.value)}
                placeholder="HTML body"
              />
              {validation && !validation.ok && (
                <Alert type="error" showIcon message={validation.issues.join(" · ")} />
              )}
              {validation?.ok && (
                <Alert type="success" showIcon message="Template passes publish validation" />
              )}
              <Space>
                <Button type="primary" loading={saving} onClick={() => void saveVersion()}>
                  Save as new version
                </Button>
                <Button onClick={() => void preview()}>Preview</Button>
                <Popconfirm title="Publish the latest version?" onConfirm={() => void publish()}>
                  <Button>Publish</Button>
                </Popconfirm>
                <Button icon={<SendOutlined />} onClick={() => setTestOpen(true)}>
                  Test send
                </Button>
              </Space>
            </Flex>
          </Card>

          <Card size="small" title="Version history" style={{ flex: 1, minWidth: 300 }}>
            <Table<VersionRow>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={versions}
              columns={[
                { title: "Version", dataIndex: "version", width: 80 },
                {
                  title: "Created",
                  dataIndex: "createdAt",
                  width: 140,
                  render: (value: string) => new Date(value).toLocaleDateString(),
                },
                {
                  title: "",
                  width: 90,
                  render: (_, row) => (
                    <Popconfirm title={`Restore v${row.version}?`} onConfirm={() => void restore(row.id)}>
                      <Button size="small">Restore</Button>
                    </Popconfirm>
                  ),
                },
              ]}
            />
          </Card>
        </Flex>
      )}

      <Modal title="Preview" open={previewHtml !== null} onCancel={() => setPreviewHtml(null)} footer={null} width={720}>
        <Text strong>{previewSubject ?? ""}</Text>
        <iframe
          title="preview"
          srcDoc={previewHtml ?? ""}
          style={{ width: "100%", height: 480, border: "1px solid #eee", marginTop: 8 }}
        />
      </Modal>

      <Modal
        title="Test send"
        open={testOpen}
        onCancel={() => setTestOpen(false)}
        onOk={() => void testSend()}
        confirmLoading={testSending}
        okText="Send test"
      >
        <Flex vertical gap={12}>
          <Alert
            type="warning"
            showIcon
            message="Test sends use the live Resend API to one admin-provided address. Requires live mode."
          />
          <Input
            placeholder="recipient@wlthwlks.com"
            value={testTo}
            onChange={(event) => setTestTo(event.target.value)}
          />
        </Flex>
      </Modal>

      <Modal
        title="New template"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void createTemplate()}
        width={720}
      >
        <Flex vertical gap={12}>
          <Input placeholder="Template name" value={createName} onChange={(event) => setCreateName(event.target.value)} />
          <Input placeholder="Subject" value={createSubject} onChange={(event) => setCreateSubject(event.target.value)} />
          <Input.TextArea
            rows={10}
            value={createBody}
            onChange={(event) => setCreateBody(event.target.value)}
          />
        </Flex>
      </Modal>
    </Flex>
  );
}
