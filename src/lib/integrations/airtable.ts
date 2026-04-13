export interface AirtableConfig {
  apiKey: string;
  baseId: string;
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
  createdTime?: string;
}

export interface ListOptions {
  filterByFormula?: string;
  fields?: string[];
  sort?: Array<{ field: string; direction?: "asc" | "desc" }>;
  maxRecords?: number;
}

interface AirtableListResponse {
  records: AirtableRecord[];
  offset?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAirtableClient(config: AirtableConfig) {
  const baseUrl = `https://api.airtable.com/v0/${config.baseId}`;

  async function request(url: string, options?: RequestInit, retries = 3): Promise<Response> {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (res.status === 429 && retries > 0) {
      const delay = Math.pow(2, 3 - retries) * 1000;
      await sleep(delay);
      return request(url, options, retries - 1);
    }

    if (!res.ok) {
      throw new Error(`Airtable API error: ${res.status} ${res.statusText}`);
    }

    return res;
  }

  async function listRecords(table: string, options?: ListOptions): Promise<AirtableRecord[]> {
    const allRecords: AirtableRecord[] = [];
    let offset: string | undefined;

    do {
      const params = new URLSearchParams();
      if (options?.filterByFormula) params.set("filterByFormula", options.filterByFormula);
      if (options?.fields) options.fields.forEach((f) => params.append("fields[]", f));
      if (options?.maxRecords) params.set("maxRecords", String(options.maxRecords));
      if (offset) params.set("offset", offset);

      const url = `${baseUrl}/${encodeURIComponent(table)}?${params}`;
      const res = await request(url);
      const data: AirtableListResponse = await res.json();

      allRecords.push(...data.records);
      offset = data.offset;
    } while (offset);

    return allRecords;
  }

  async function getRecord(table: string, recordId: string): Promise<AirtableRecord> {
    const url = `${baseUrl}/${encodeURIComponent(table)}/${recordId}`;
    const res = await request(url);
    return res.json();
  }

  async function createRecords(table: string, records: Array<{ fields: Record<string, unknown> }>): Promise<AirtableRecord[]> {
    const url = `${baseUrl}/${encodeURIComponent(table)}`;
    const res = await request(url, { method: "POST", body: JSON.stringify({ records }) });
    const data = await res.json();
    return data.records;
  }

  async function updateRecords(table: string, records: Array<{ id: string; fields: Record<string, unknown> }>): Promise<AirtableRecord[]> {
    const url = `${baseUrl}/${encodeURIComponent(table)}`;
    const res = await request(url, { method: "PATCH", body: JSON.stringify({ records }) });
    const data = await res.json();
    return data.records;
  }

  return { listRecords, getRecord, createRecords, updateRecords };
}

export type AirtableClient = ReturnType<typeof createAirtableClient>;
