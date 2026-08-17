"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Flex,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { PlusOutlined, ReloadOutlined, SyncOutlined } from "@ant-design/icons";

const { Title, Text } = Typography;

interface ProfileRow {
  profile: { id: string; name: string; description: string | null; isDefault: boolean; status: string };
  latestVersion: { version: number; weightsJson: string; constraintsJson: string } | null;
}

interface CityRow {
  cityCode: string;
  cityName: string | null;
  enabled: boolean;
  schedulingMode: string;
  scheduleJson: string | null;
  nextRunAt: string | null;
  targetGroupSize: number | null;
  minGroupSize: number | null;
  maxGroupSize: number | null;
  strictGroupSize: boolean | null;
  requireSameCity: boolean | null;
  maxDistanceKm: number | null;
  allowUnknownPostcode: boolean | null;
  repeatPairDays: number | null;
  memberCooldownDays: number | null;
  minEligibleMembers: number | null;
  autoApprove: boolean;
  autoApproveDeliveryMode: string;
  meetupTime: string;
}

const COMPONENT_LABELS: Record<string, string> = {
  proximity: "Geographic proximity",
  ai_correlation: "AI semantic correlation",
  help_expertise: "Help ↔ Expertise",
  goal_relevance: "90-day goal relevance",
  connection_type: "Connection type",
  industry: "Industry",
  business_stage: "Business stage",
};

const DEFAULT_WEIGHT_VALUES: Record<string, number> = {
  proximity: 30,
  ai_correlation: 25,
  help_expertise: 20,
  goal_relevance: 10,
  connection_type: 5,
  industry: 5,
  business_stage: 5,
};

export default function IntroductionsSettingsPage() {
  const { message } = App.useApp();
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [cities, setCities] = useState<CityRow[]>([]);
  const [config, setConfig] = useState<{
    senderFrom?: string;
    canaryEmails?: string[];
    providerTestEmails?: string[];
    defaultProfileId?: string | null;
    defaultTemplateId?: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileIsDefault, setProfileIsDefault] = useState(false);

  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [weights, setWeights] = useState<Record<string, number>>({ ...DEFAULT_WEIGHT_VALUES });
  const [constraints, setConstraints] = useState({
    requireSameCity: true,
    maxDistanceKm: null as number | null,
    allowUnknownPostcode: true,
    repeatPairDays: 60,
    memberCooldownDays: 14,
    minEligibleMembers: 0,
    targetGroupSize: 3,
    minGroupSize: 2,
    maxGroupSize: 6,
    strictGroupSize: false,
  });
  const [versionLoading, setVersionLoading] = useState(false);

  const [cityEdit, setCityEdit] = useState<CityRow | null>(null);
  const [configSaving, setConfigSaving] = useState(false);
  const [syncingCities, setSyncingCities] = useState(false);

  const syncCities = async () => {
    setSyncingCities(true);
    try {
      const res = await fetch("/api/introductions/cities/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        message.error(body.message ?? "City sync failed");
        return;
      }
      message.success(
        `City sync: ${body.created} added, ${body.nameUpdated} renamed, ${body.unchanged} unchanged, ${body.stale} stale`
      );
      await load();
    } catch {
      message.error("City sync request failed");
    } finally {
      setSyncingCities(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [profilesRes, citiesRes, configRes] = await Promise.all([
        fetch("/api/introductions/profiles", { cache: "no-store" }),
        fetch("/api/introductions/cities", { cache: "no-store" }),
        fetch("/api/introductions/config", { cache: "no-store" }),
      ]);
      const profilesBody = await profilesRes.json();
      const citiesBody = await citiesRes.json();
      const configBody = await configRes.json();
      setProfiles(profilesBody.profiles ?? []);
      setCities(citiesBody.cities ?? []);
      setConfig((configBody.config ?? {}) as typeof config);
    } catch {
      message.error("Could not load settings");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const normalized = useMemo(() => {
    const total = Object.values(weights).reduce((acc, value) => acc + (Number(value) || 0), 0);
    const normalizedWeights: Record<string, number> = {};
    for (const [key, value] of Object.entries(weights)) {
      normalizedWeights[key] = total > 0 ? Math.round(((Number(value) || 0) / total) * 1000) / 10 : 0;
    }
    return { total, normalizedWeights };
  }, [weights]);

  const createProfile = async () => {
    try {
      const res = await fetch("/api/introductions/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: profileName, isDefault: profileIsDefault }),
      });
      const body = await res.json();
      if (!res.ok) {
        message.error(body.message ?? "Could not create profile");
        return;
      }
      message.success("Profile created");
      setProfileOpen(false);
      setProfileName("");
      setProfileIsDefault(false);
      await load();
    } catch {
      message.error("Create profile failed");
    }
  };

  const loadProfileIntoEditor = (profile: ProfileRow) => {
    setSelectedProfileId(profile.profile.id);
    if (profile.latestVersion) {
      try {
        const storedWeights = JSON.parse(profile.latestVersion.weightsJson) as Record<string, number>;
        setWeights({ ...DEFAULT_WEIGHT_VALUES, ...storedWeights });
        const storedConstraints = JSON.parse(profile.latestVersion.constraintsJson) as typeof constraints;
        setConstraints({ ...constraints, ...storedConstraints });
      } catch {
        setWeights({ ...DEFAULT_WEIGHT_VALUES });
      }
    } else {
      setWeights({ ...DEFAULT_WEIGHT_VALUES });
    }
  };

  const createVersion = async () => {
    if (!selectedProfileId) return;
    setVersionLoading(true);
    try {
      const res = await fetch(`/api/introductions/profiles/${selectedProfileId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weights,
          constraints: {
            ...constraints,
            maxDistanceKm: constraints.maxDistanceKm ?? null,
          },
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        message.error(body.message ?? body.details?.[0]?.message ?? "Could not create version");
        return;
      }
      message.success(`Version ${body.version.version} created`);
      await load();
    } catch {
      message.error("Create version failed");
    } finally {
      setVersionLoading(false);
    }
  };

  const saveCity = async () => {
    if (!cityEdit) return;
    try {
      const res = await fetch(`/api/introductions/cities/${cityEdit.cityCode}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: cityEdit.enabled,
          schedulingMode: cityEdit.schedulingMode,
          scheduleJson: cityEdit.scheduleJson,
          repeatPairDays: cityEdit.repeatPairDays,
          memberCooldownDays: cityEdit.memberCooldownDays,
          minEligibleMembers: cityEdit.minEligibleMembers,
          targetGroupSize: cityEdit.targetGroupSize,
          minGroupSize: cityEdit.minGroupSize,
          maxGroupSize: cityEdit.maxGroupSize,
          strictGroupSize: cityEdit.strictGroupSize,
          requireSameCity: cityEdit.requireSameCity,
          maxDistanceKm: cityEdit.maxDistanceKm,
          allowUnknownPostcode: cityEdit.allowUnknownPostcode,
          autoApprove: cityEdit.autoApprove,
          autoApproveDeliveryMode: cityEdit.autoApproveDeliveryMode,
          meetupTime: cityEdit.meetupTime,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        message.error(body.message ?? body.details?.[0]?.message ?? "Could not save city");
        return;
      }
      message.success("City settings saved");
      setCityEdit(null);
      await load();
    } catch {
      message.error("Save city failed");
    }
  };

  const saveGlobalConfig = async (patch: Record<string, unknown>) => {
    setConfigSaving(true);
    try {
      const res = await fetch("/api/introductions/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!res.ok) {
        message.error(body.message ?? "Could not save config");
        return;
      }
      message.success("Global config saved");
      setConfig(body.config);
    } catch {
      message.error("Save config failed");
    } finally {
      setConfigSaving(false);
    }
  };

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Title level={4} style={{ margin: 0 }}>
          Matching Settings
        </Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            Refresh
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setProfileOpen(true)}>
            New profile
          </Button>
        </Space>
      </Flex>

      <Card size="small" title="Matching profiles (versioned)">
        <Table<ProfileRow>
          rowKey={(row) => row.profile.id}
          loading={loading}
          size="small"
          pagination={false}
          dataSource={profiles}
          onRow={(row) => ({ onClick: () => loadProfileIntoEditor(row), style: { cursor: "pointer" } })}
          rowClassName={(row) => (row.profile.id === selectedProfileId ? "ant-table-row-selected" : "")}
          columns={[
            {
              title: "Name",
              render: (_, row) => (
                <Space>
                  <Text strong>{row.profile.name}</Text>
                  {row.profile.isDefault && <Tag color="blue">Default</Tag>}
                  <Tag>{row.profile.status}</Tag>
                </Space>
              ),
            },
            {
              title: "Latest version",
              render: (_, row) => (row.latestVersion ? `v${row.latestVersion.version}` : "—"),
            },
            { title: "Description", render: (_, row) => row.profile.description ?? "—" },
          ]}
        />
      </Card>

      {selectedProfileId && (
        <Card size="small" title={`Edit profile ${profiles.find((p) => p.profile.id === selectedProfileId)?.profile.name ?? ""}`}>
          <Flex vertical gap={16}>
            <Flex gap={16} wrap>
              <Card size="small" title="Score weights (auto-normalized)" style={{ flex: 1, minWidth: 360 }}>
                <Flex vertical gap={8}>
                  {Object.entries(COMPONENT_LABELS).map(([key, label]) => (
                    <Flex key={key} justify="space-between" align="center" gap={12}>
                      <Text style={{ minWidth: 200 }}>{label}</Text>
                      <InputNumber
                        min={0}
                        max={100000}
                        value={weights[key] ?? 0}
                        onChange={(value) => setWeights((w) => ({ ...w, [key]: Number(value) || 0 }))}
                        style={{ width: 110 }}
                      />
                      <Text type="secondary" style={{ minWidth: 60 }}>
                        {normalized.normalizedWeights[key] ?? 0}%
                      </Text>
                    </Flex>
                  ))}
                  <Alert
                    type={normalized.total > 0 ? "success" : "error"}
                    showIcon
                    message={`Raw total ${normalized.total} — normalized to 100% at scoring time`}
                  />
                </Flex>
              </Card>

              <Card size="small" title="Hard constraints" style={{ flex: 1, minWidth: 360 }}>
                <Flex vertical gap={8}>
                  <Flex justify="space-between" align="center">
                    <Text>Require same city</Text>
                    <Switch
                      checked={constraints.requireSameCity}
                      onChange={(v) => setConstraints((c) => ({ ...c, requireSameCity: v }))}
                    />
                  </Flex>
                  <Flex justify="space-between" align="center">
                    <Text>Allow unknown postcode</Text>
                    <Switch
                      checked={constraints.allowUnknownPostcode}
                      onChange={(v) => setConstraints((c) => ({ ...c, allowUnknownPostcode: v }))}
                    />
                  </Flex>
                  <Flex justify="space-between" align="center">
                    <Text>Strict group size</Text>
                    <Switch
                      checked={constraints.strictGroupSize}
                      onChange={(v) => setConstraints((c) => ({ ...c, strictGroupSize: v }))}
                    />
                  </Flex>
                  <Flex justify="space-between" align="center">
                    <Text>Max distance (km, empty = none)</Text>
                    <InputNumber
                      min={0}
                      value={constraints.maxDistanceKm ?? undefined}
                      onChange={(v) => setConstraints((c) => ({ ...c, maxDistanceKm: v == null ? null : Number(v) }))}
                      style={{ width: 110 }}
                    />
                  </Flex>
                  <Flex justify="space-between" align="center">
                    <Text>Repeat-pair window (days)</Text>
                    <InputNumber
                      min={1}
                      value={constraints.repeatPairDays}
                      onChange={(v) => setConstraints((c) => ({ ...c, repeatPairDays: Number(v) || 60 }))}
                      style={{ width: 110 }}
                    />
                  </Flex>
                  <Flex justify="space-between" align="center">
                    <Text>Member cooldown (days)</Text>
                    <InputNumber
                      min={0}
                      value={constraints.memberCooldownDays}
                      onChange={(v) => setConstraints((c) => ({ ...c, memberCooldownDays: Number(v) || 14 }))}
                      style={{ width: 110 }}
                    />
                  </Flex>
                  <Flex justify="space-between" align="center">
                    <Text>Min eligible members (city gate, 0 = off)</Text>
                    <InputNumber
                      min={0}
                      max={1000}
                      value={constraints.minEligibleMembers}
                      onChange={(v) => setConstraints((c) => ({ ...c, minEligibleMembers: Number(v) || 0 }))}
                      style={{ width: 110 }}
                    />
                  </Flex>
                  <Flex justify="space-between" align="center">
                    <Text>Target / min / max group size</Text>
                    <Space>
                      <InputNumber
                        min={2}
                        max={12}
                        value={constraints.targetGroupSize}
                        onChange={(v) => setConstraints((c) => ({ ...c, targetGroupSize: Number(v) || 3 }))}
                        style={{ width: 70 }}
                      />
                      <InputNumber
                        min={2}
                        max={12}
                        value={constraints.minGroupSize}
                        onChange={(v) => setConstraints((c) => ({ ...c, minGroupSize: Number(v) || 2 }))}
                        style={{ width: 70 }}
                      />
                      <InputNumber
                        min={2}
                        max={12}
                        value={constraints.maxGroupSize}
                        onChange={(v) => setConstraints((c) => ({ ...c, maxGroupSize: Number(v) || 6 }))}
                        style={{ width: 70 }}
                      />
                    </Space>
                  </Flex>
                </Flex>
              </Card>
            </Flex>
            <Button type="primary" onClick={() => void createVersion()} loading={versionLoading}>
              Create version
            </Button>
          </Flex>
        </Card>
      )}

      <Card
        size="small"
        title="City settings"
        extra={
          <Button
            size="small"
            icon={<SyncOutlined />}
            loading={syncingCities}
            onClick={() => void syncCities()}
          >
            Sync cities from Airtable
          </Button>
        }
      >
        <Table<CityRow>
          rowKey="cityCode"
          loading={loading}
          size="small"
          dataSource={cities}
          pagination={{ pageSize: 10 }}
          onRow={(row) => ({ onClick: () => setCityEdit({ ...row }), style: { cursor: "pointer" } })}
          columns={[
            { title: "City", render: (_, row) => row.cityName ?? row.cityCode },
            {
              title: "Enabled",
              render: (_, row) => <Tag color={row.enabled ? "green" : "default"}>{row.enabled ? "Yes" : "No"}</Tag>,
            },
            { title: "Schedule", render: (_, row) => row.schedulingMode },
            { title: "Repeat window", render: (_, row) => `${row.repeatPairDays ?? "default"}d` },
            { title: "Group sizes", render: (_, row) => `${row.targetGroupSize ?? 3} (${row.minGroupSize ?? 2}–${row.maxGroupSize ?? 6})` },
          ]}
        />
      </Card>

      <Card size="small" title="Global config">
        <Flex vertical gap={12}>
          <Flex gap={12} align="center" wrap>
            <Text style={{ minWidth: 100 }}>Sender</Text>
            <Input
              style={{ width: 320 }}
              value={config?.senderFrom ?? ""}
              onChange={(event) => setConfig((c) => ({ ...(c ?? {}), senderFrom: event.target.value }))}
            />
          </Flex>
          <Flex gap={12} align="center" wrap>
            <Text style={{ minWidth: 100 }}>Canary emails</Text>
            <Select
              mode="tags"
              style={{ minWidth: 320 }}
              value={config?.canaryEmails ?? []}
              onChange={(value: string[]) => setConfig((c) => ({ ...(c ?? {}), canaryEmails: value }))}
              placeholder="Enter email addresses"
            />
          </Flex>
          <Flex gap={12} align="center" wrap>
            <Text style={{ minWidth: 100 }}>Provider-test emails</Text>
            <Select
              mode="tags"
              style={{ minWidth: 320 }}
              value={config?.providerTestEmails ?? []}
              onChange={(value: string[]) => setConfig((c) => ({ ...(c ?? {}), providerTestEmails: value }))}
              placeholder="Enter email addresses"
            />
          </Flex>
          <Button
            type="primary"
            loading={configSaving}
            onClick={() =>
              void saveGlobalConfig({
                senderFrom: config?.senderFrom,
                canaryEmails: config?.canaryEmails,
                providerTestEmails: config?.providerTestEmails,
              })
            }
            style={{ alignSelf: "flex-start" }}
          >
            Save global config
          </Button>
        </Flex>
      </Card>

      <Modal
        title="New matching profile"
        open={profileOpen}
        onCancel={() => setProfileOpen(false)}
        onOk={() => void createProfile()}
      >
        <Flex vertical gap={12}>
          <Input
            placeholder="Profile name"
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
          />
          <Checkbox checked={profileIsDefault} onChange={(e) => setProfileIsDefault(e.target.checked)}>
            Make this the default profile
          </Checkbox>
        </Flex>
      </Modal>

      <Modal
        title={`City settings — ${cityEdit?.cityName ?? cityEdit?.cityCode ?? ""}`}
        open={cityEdit !== null}
        onCancel={() => setCityEdit(null)}
        onOk={() => void saveCity()}
        okText="Save"
        width={640}
      >
        {cityEdit && (
          <Flex vertical gap={12}>
            <Flex justify="space-between" align="center">
              <Text>Introductions enabled</Text>
              <Switch
                checked={cityEdit.enabled}
                onChange={(v) => setCityEdit({ ...cityEdit, enabled: v })}
              />
            </Flex>
            <Flex justify="space-between" align="center">
              <Text>Scheduling mode</Text>
              <Select
                style={{ width: 160 }}
                value={cityEdit.schedulingMode}
                onChange={(v) => setCityEdit({ ...cityEdit, schedulingMode: v })}
                options={[
                  { value: "manual", label: "Manual" },
                  { value: "scheduled", label: "Scheduled (monthly)" },
                ]}
              />
            </Flex>
            <Flex justify="space-between" align="center">
              <Text>Monthly schedule JSON</Text>
              <Input
                style={{ width: 320 }}
                placeholder='{"dayOfMonth":1,"localTime":"09:00","timezone":"Europe/London"}'
                value={cityEdit.scheduleJson ?? ""}
                onChange={(event) => setCityEdit({ ...cityEdit, scheduleJson: event.target.value || null })}
              />
            </Flex>
            <Flex justify="space-between" align="center">
              <Text>{"Meetup time ({{meetup_suggestion}})"}</Text>
              <Input
                style={{ width: 120 }}
                placeholder="10:00"
                value={cityEdit.meetupTime ?? "10:00"}
                onChange={(event) => setCityEdit({ ...cityEdit, meetupTime: event.target.value })}
              />
            </Flex>
            <Flex justify="space-between" align="center">
              <Text>Auto-approve scheduled runs</Text>
              <Switch
                checked={cityEdit.autoApprove}
                onChange={(v) => setCityEdit({ ...cityEdit, autoApprove: v })}
              />
            </Flex>
            <Flex justify="space-between" align="center">
              <Text>Auto-approve delivery mode</Text>
              <Select
                style={{ width: 160 }}
                value={cityEdit.autoApproveDeliveryMode ?? "simulation"}
                onChange={(v) => setCityEdit({ ...cityEdit, autoApproveDeliveryMode: v })}
                options={[
                  { value: "simulation", label: "Simulation" },
                  { value: "provider_test", label: "Provider test" },
                  { value: "canary", label: "Canary" },
                  { value: "production", label: "Production" },
                ]}
              />
            </Flex>
            <Flex justify="space-between" align="center">
              <Text>Repeat-pair window (days)</Text>
              <InputNumber
                min={1}
                value={cityEdit.repeatPairDays ?? undefined}
                onChange={(v) => setCityEdit({ ...cityEdit, repeatPairDays: v == null ? null : Number(v) })}
              />
            </Flex>
            <Flex justify="space-between" align="center">
              <Text>Member cooldown (days)</Text>
              <InputNumber
                min={0}
                value={cityEdit.memberCooldownDays ?? undefined}
                onChange={(v) => setCityEdit({ ...cityEdit, memberCooldownDays: v == null ? null : Number(v) })}
              />
            </Flex>
            <Flex justify="space-between" align="center">
              <Text>Min eligible members (override)</Text>
              <InputNumber
                min={0}
                max={1000}
                value={cityEdit.minEligibleMembers ?? undefined}
                onChange={(v) => setCityEdit({ ...cityEdit, minEligibleMembers: v == null ? null : Number(v) })}
              />
            </Flex>
            <Flex justify="space-between" align="center">
              <Text>Group sizes (target / min / max)</Text>
              <Space>
                <InputNumber min={2} max={12} value={cityEdit.targetGroupSize ?? undefined} onChange={(v) => setCityEdit({ ...cityEdit, targetGroupSize: v == null ? null : Number(v) })} />
                <InputNumber min={2} max={12} value={cityEdit.minGroupSize ?? undefined} onChange={(v) => setCityEdit({ ...cityEdit, minGroupSize: v == null ? null : Number(v) })} />
                <InputNumber min={2} max={12} value={cityEdit.maxGroupSize ?? undefined} onChange={(v) => setCityEdit({ ...cityEdit, maxGroupSize: v == null ? null : Number(v) })} />
              </Space>
            </Flex>
            <Flex justify="space-between" align="center">
              <Text>Strict group size</Text>
              <Switch
                checked={cityEdit.strictGroupSize ?? false}
                onChange={(v) => setCityEdit({ ...cityEdit, strictGroupSize: v })}
              />
            </Flex>
            <Flex justify="space-between" align="center">
              <Text>Require same city</Text>
              <Switch
                checked={cityEdit.requireSameCity ?? true}
                onChange={(v) => setCityEdit({ ...cityEdit, requireSameCity: v })}
              />
            </Flex>
            <Flex justify="space-between" align="center">
              <Text>Max distance (km, empty = profile default)</Text>
              <InputNumber
                min={0}
                value={cityEdit.maxDistanceKm ?? undefined}
                onChange={(v) => setCityEdit({ ...cityEdit, maxDistanceKm: v == null ? null : Number(v) })}
              />
            </Flex>
            <Flex justify="space-between" align="center">
              <Text>Allow unknown postcode</Text>
              <Switch
                checked={cityEdit.allowUnknownPostcode ?? true}
                onChange={(v) => setCityEdit({ ...cityEdit, allowUnknownPostcode: v })}
              />
            </Flex>
          </Flex>
        )}
      </Modal>
    </Flex>
  );
}
