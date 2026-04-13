export interface StrapiConfig {
  baseUrl: string;
  token: string;
}

export function createStrapiClient(config: StrapiConfig) {
  const apiUrl = `${config.baseUrl}/api`;

  async function request(path: string, options?: RequestInit): Promise<any> {
    const res = await fetch(`${apiUrl}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", ...options?.headers },
    });
    if (!res.ok) throw new Error(`Strapi API error: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function find(contentType: string, params?: Record<string, string>): Promise<any> {
    const qs = params ? `?${new URLSearchParams(params)}` : "";
    return request(`/${contentType}${qs}`);
  }

  async function findOne(contentType: string, id: number | string): Promise<any> {
    return request(`/${contentType}/${id}`);
  }

  async function create(contentType: string, data: Record<string, unknown>): Promise<any> {
    return request(`/${contentType}`, { method: "POST", body: JSON.stringify({ data }) });
  }

  async function update(contentType: string, id: number | string, data: Record<string, unknown>): Promise<any> {
    return request(`/${contentType}/${id}`, { method: "PUT", body: JSON.stringify({ data }) });
  }

  async function remove(contentType: string, id: number | string): Promise<any> {
    return request(`/${contentType}/${id}`, { method: "DELETE" });
  }

  return { find, findOne, create, update, remove };
}

export type StrapiClient = ReturnType<typeof createStrapiClient>;
