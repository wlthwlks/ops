/**
 * Server-only Neon Management API client (https://console.neon.tech/api/v2).
 * Powers the ops dashboard Billing tab: plan info, per-project usage and
 * consumption history. Lazy like stripe.ts so the Next.js build can import
 * modules without requiring NEON_API_KEY at module evaluation time.
 */

export const NEON_API_BASE = "https://console.neon.tech/api/v2";

export class NeonApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "NeonApiError";
    this.status = status;
  }
}

export function getNeonApiKey(): string {
  const key = process.env.NEON_API_KEY;
  if (!key) {
    throw new Error("NEON_API_KEY is not set");
  }
  return key;
}

async function neonFetch<T>(
  path: string,
  query?: Record<string, string | string[] | number | undefined>
): Promise<T> {
  const url = new URL(`${NEON_API_BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getNeonApiKey()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      detail = body.message ? `: ${body.message}` : "";
    } catch {
      // Non-JSON error body — keep the status only
    }
    throw new NeonApiError(`Neon API ${res.status} ${path}${detail}`, res.status);
  }
  return (await res.json()) as T;
}

// —— Response types (only the fields the billing tab needs) ——

export type NeonOrg = {
  id: string;
  name: string;
  handle?: string;
  plan: string;
  created_at?: string;
};

export type NeonProject = {
  id: string;
  name: string;
  org_id?: string;
  region_id?: string;
  pg_version?: number;
  created_at?: string;
  owner?: {
    email?: string;
    name?: string;
    subscription_type?: string;
  };
};

export type NeonEndpoint = {
  id: string;
  host: string;
  branch_id: string;
  type: string;
};

export type NeonProjectDetails = {
  project: NeonProject & {
    compute_time_seconds?: number;
    active_time_seconds?: number;
    data_storage_bytes_hour?: number;
    data_transfer_bytes?: number;
    consumption_period_start?: string;
    consumption_period_end?: string;
    synthetic_storage_size?: number;
  };
};

export type NeonMetricPoint = {
  metric_name: string;
  value: number;
};

export type NeonConsumptionTimeframe = {
  timeframe_start: string;
  timeframe_end: string;
  metrics: NeonMetricPoint[];
};

export type NeonConsumptionPeriod = {
  period_id: string;
  period_plan: string;
  period_start: string;
  period_end?: string;
  consumption: NeonConsumptionTimeframe[];
};

export type NeonConsumptionProject = {
  project_id: string;
  periods: NeonConsumptionPeriod[];
};

export type NeonConsumptionResponse = {
  projects: NeonConsumptionProject[];
  pagination?: { cursor?: string };
};

export const NEON_BILLING_METRICS = [
  "compute_unit_seconds",
  "root_branch_bytes_month",
  "child_branch_bytes_month",
  "instant_restore_bytes_month",
  "snapshot_storage_bytes_month",
  "public_network_transfer_bytes",
  "private_network_transfer_bytes",
  "extra_branches_month",
] as const;

// —— API calls ——

export async function getNeonOrgs(): Promise<NeonOrg[]> {
  const data = await neonFetch<{ organizations?: NeonOrg[] }>("/users/me/organizations");
  return data.organizations ?? [];
}

export async function getNeonOrg(orgId: string): Promise<NeonOrg> {
  return neonFetch<NeonOrg>(`/organizations/${orgId}`);
}

export async function listNeonProjects(orgId: string): Promise<NeonProject[]> {
  const projects: NeonProject[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const data = await neonFetch<{
      projects?: NeonProject[];
      pagination?: { cursor?: string };
    }>("/projects", {
      org_id: orgId,
      limit: 100,
      cursor,
    });
    for (const project of data.projects ?? []) {
      if (!seen.has(project.id)) {
        seen.add(project.id);
        projects.push(project);
      }
    }
    const next = data.pagination?.cursor;
    // Neon sometimes echoes a cursor on the final page — stop to avoid looping.
    if (!next || next === cursor) break;
    cursor = next;
  } while (true);
  return projects;
}

export async function getNeonProject(projectId: string): Promise<NeonProjectDetails> {
  return neonFetch<NeonProjectDetails>(`/projects/${projectId}`);
}

export async function listNeonEndpoints(projectId: string): Promise<NeonEndpoint[]> {
  const data = await neonFetch<{ endpoints?: NeonEndpoint[] }>(
    `/projects/${projectId}/endpoints`
  );
  return data.endpoints ?? [];
}

export async function getNeonConsumption(args: {
  orgId: string;
  projectIds: string[];
  from: string;
  to: string;
  granularity: "hourly" | "daily" | "monthly";
  metrics?: readonly string[];
}): Promise<NeonConsumptionProject[]> {
  const all: NeonConsumptionProject[] = [];
  let cursor: string | undefined;
  do {
    const data = await neonFetch<NeonConsumptionResponse>(
      "/consumption_history/v2/projects",
      {
        org_id: args.orgId,
        project_ids: args.projectIds,
        from: args.from,
        to: args.to,
        granularity: args.granularity,
        metrics: [...(args.metrics ?? NEON_BILLING_METRICS)],
        limit: 100,
        cursor,
      }
    );
    all.push(...data.projects);
    const next = data.pagination?.cursor;
    // Neon sometimes echoes a cursor on the final page — stop to avoid looping.
    if (!next || next === cursor) break;
    cursor = next;
  } while (true);
  return all;
}

// —— Billing context resolution ——

export type NeonBillingProject = {
  id: string;
  name: string;
  endpoints: NeonEndpoint[];
  envLabel: string;
  isCurrentEnv: boolean;
};

export type NeonBillingContext = {
  org: NeonOrg;
  projects: NeonBillingProject[];
  currentProjectId: string | null;
};

/**
 * First label of a connection-string host with any `-pooler` suffix removed,
 * e.g. `postgresql://user:pass@ep-falling-lake-apadhwhn-pooler.c-7.us-east-1.aws.neon.tech/neondb`
 * → `ep-falling-lake-apadhwhn` (which matches the endpoint id from the API).
 */
function endpointIdFromConnectionUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const label = new URL(url).hostname.split(".")[0];
    if (!label) return null;
    return label.replace(/-pooler$/, "");
  } catch {
    return null;
  }
}

/** Connection-host endpoint ids for the current deployment (.env / .env.local). */
export function getCurrentEnvEndpointIds(): string[] {
  const hosts = [process.env.POSTGRES_URL, process.env.POSTGRES_URL_NON_POOLING];
  const ids = new Set<string>();
  for (const host of hosts) {
    const id = endpointIdFromConnectionUrl(host);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Label for the environment this deployment runs in. Falls back to
 * Production/Preview based on NODE_ENV because local dev points at the
 * preview database via .env.local.
 */
export function getCurrentEnvLabel(): "Production" | "Preview" {
  const vercelEnv = (process.env.VERCEL_ENV || "").trim();
  if (vercelEnv === "production") return "Production";
  if (vercelEnv === "preview") return "Preview";
  return process.env.NODE_ENV === "production" ? "Production" : "Preview";
}

/**
 * Discover the Neon org holding this deployment's databases (matched via
 * endpoint host against POSTGRES_URL) plus every project in that org so the
 * billing tab can show production + preview together in any environment.
 */
export async function resolveNeonBillingContext(): Promise<NeonBillingContext> {
  const currentEndpointIds = getCurrentEnvEndpointIds();

  let org: NeonOrg | undefined;
  const explicitOrgId = process.env.NEON_ORG_ID?.trim();

  if (explicitOrgId) {
    org = await getNeonOrg(explicitOrgId);
  } else {
    const orgs = await getNeonOrgs();
    for (const candidate of orgs) {
      const projects = await listNeonProjects(candidate.id);
      for (const project of projects) {
        const endpoints = await listNeonEndpoints(project.id);
        if (endpoints.some((e) => currentEndpointIds.includes(e.id))) {
          org = candidate;
          break;
        }
      }
      if (org) break;
    }
  }

  if (!org) {
    throw new Error(
      "Could not resolve the Neon organization: no project endpoint matches POSTGRES_URL and NEON_ORG_ID is not set"
    );
  }

  const projects = await listNeonProjects(org.id);
  if (projects.length === 0) {
    throw new Error(`Neon organization ${org.name} has no projects`);
  }

  const currentLabel = getCurrentEnvLabel();
  const otherLabel = currentLabel === "Production" ? "Preview" : "Production";

  const resolved: NeonBillingProject[] = [];
  let currentProjectId: string | null = null;
  for (const project of projects) {
    const endpoints = await listNeonEndpoints(project.id);
    const isCurrentEnv = endpoints.some((e) => currentEndpointIds.includes(e.id));
    if (isCurrentEnv) currentProjectId = project.id;
    resolved.push({
      id: project.id,
      name: project.name,
      endpoints,
      envLabel: isCurrentEnv ? currentLabel : otherLabel,
      isCurrentEnv,
    });
  }

  return { org, projects: resolved, currentProjectId };
}
