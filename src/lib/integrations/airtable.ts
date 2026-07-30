export interface AirtableConfig {
  apiKey: string;
  baseId: string;
  /** Per-request timeout (default 30s). */
  requestTimeoutMs?: number;
  /** Minimum wait on 429 when Retry-After is absent (default 30s). */
  rateLimitMinWaitMs?: number;
  /** Max retries for 429 / 5xx / timeout (default 5). */
  maxRetries?: number;
  /** Gap between successful batch writes (default 250ms). */
  batchGapMs?: number;
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

export type AirtableBatchProgress = {
  batchIndex: number;
  totalBatches: number;
  batchSize: number;
  successTotal: number;
  failedTotal: number;
  retry: number;
  durationMs: number;
  status: "ok" | "retry" | "failed";
  error?: string;
};

export class AirtableHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly permanent: boolean;

  constructor(status: number, statusText: string, body: string) {
    super(`Airtable API error: ${status} ${statusText} — ${body}`);
    this.name = "AirtableHttpError";
    this.status = status;
    this.body = body;
    this.permanent = isPermanentAirtableStatus(status);
  }
}

export class AirtableTimeoutError extends Error {
  constructor(message = "Airtable request timed out") {
    super(message);
    this.name = "AirtableTimeoutError";
  }
}

export function isPermanentAirtableStatus(status: number): boolean {
  // Do not retry auth, not-found, validation, or other client errors except 429.
  if (status === 429) return false;
  if (status >= 400 && status < 500) return true;
  return false;
}

interface AirtableListResponse {
  records: AirtableRecord[];
  offset?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(res: Response, minWaitMs: number): number {
  const header = res.headers?.get?.("retry-after");
  if (header) {
    const asInt = parseInt(header, 10);
    if (Number.isFinite(asInt) && asInt >= 0) {
      return Math.max(asInt * 1000, minWaitMs);
    }
    const asDate = Date.parse(header);
    if (Number.isFinite(asDate)) {
      return Math.max(asDate - Date.now(), minWaitMs);
    }
  }
  return minWaitMs;
}

export function createAirtableClient(config: AirtableConfig) {
  const baseUrl = `https://api.airtable.com/v0/${config.baseId}`;
  const requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
  const rateLimitMinWaitMs = config.rateLimitMinWaitMs ?? 30_000;
  const maxRetries = config.maxRetries ?? 5;
  const defaultBatchGapMs = config.batchGapMs ?? 250;

  async function request(
    url: string,
    options?: RequestInit,
    attempt = 0
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          ...options?.headers,
        },
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const aborted =
        (err instanceof Error && err.name === "AbortError") ||
        (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError");
      if (aborted) {
        if (attempt < maxRetries) {
          const delay = Math.min(rateLimitMinWaitMs * Math.pow(2, attempt), 120_000);
          await sleep(delay);
          return request(url, options, attempt + 1);
        }
        throw new AirtableTimeoutError(
          `Airtable request timed out after ${requestTimeoutMs}ms (${maxRetries + 1} attempts)`
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    if (res.status === 429) {
      if (attempt >= maxRetries) {
        const body = await res.text().catch(() => "");
        throw new AirtableHttpError(429, res.statusText || "Too Many Requests", body);
      }
      const delay = parseRetryAfterMs(res, rateLimitMinWaitMs);
      await sleep(delay);
      return request(url, options, attempt + 1);
    }

    if (res.status >= 500 && res.status < 600) {
      if (attempt >= maxRetries) {
        const body = await res.text().catch(() => "");
        throw new AirtableHttpError(res.status, res.statusText, body);
      }
      const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
      await sleep(delay);
      return request(url, options, attempt + 1);
    }

    if (!res.ok) {
      const body = await res.text();
      console.error(`[Airtable] ${res.status} ${res.statusText}:`, body);
      throw new AirtableHttpError(res.status, res.statusText, body);
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
      if (options?.sort) {
        options.sort.forEach((s, i) => {
          params.set(`sort[${i}][field]`, s.field);
          if (s.direction) params.set(`sort[${i}][direction]`, s.direction);
        });
      }
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

  async function createRecords(
    table: string,
    records: Array<{ fields: Record<string, unknown> }>
  ): Promise<AirtableRecord[]> {
    const url = `${baseUrl}/${encodeURIComponent(table)}`;
    const res = await request(url, { method: "POST", body: JSON.stringify({ records }) });
    const data = await res.json();
    return data.records;
  }

  async function createRecordsBatched(
    table: string,
    records: Array<{ fields: Record<string, unknown> }>
  ): Promise<AirtableRecord[]> {
    const BATCH_SIZE = 10;
    const results: AirtableRecord[] = [];
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const batchResults = await createRecords(table, batch);
      results.push(...batchResults);
    }
    return results;
  }

  async function updateRecords(
    table: string,
    records: Array<{ id: string; fields: Record<string, unknown> }>
  ): Promise<AirtableRecord[]> {
    const url = `${baseUrl}/${encodeURIComponent(table)}`;
    const res = await request(url, { method: "PATCH", body: JSON.stringify({ records }) });
    const data = await res.json();
    return data.records;
  }

  async function updateRecordsBatchedDetailed(
    table: string,
    records: Array<{ id: string; fields: Record<string, unknown> }>,
    options?: {
      batchSize?: number;
      gapMs?: number;
      onBatch?: (info: AirtableBatchProgress) => void;
    }
  ): Promise<{
    results: AirtableRecord[];
    successIds: string[];
    failedBatchIndex: number | null;
    error: Error | null;
  }> {
    const BATCH_SIZE = options?.batchSize ?? 10;
    const gapMs = options?.gapMs ?? defaultBatchGapMs;
    const totalBatches = Math.ceil(records.length / BATCH_SIZE) || 0;
    const results: AirtableRecord[] = [];
    const successIds: string[] = [];
    let failedBatchIndex: number | null = null;
    let error: Error | null = null;

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
      const batch = records.slice(i, i + BATCH_SIZE);
      const started = Date.now();
      const retry = 0;

      try {
        const batchResults = await updateRecords(table, batch);
        results.push(...batchResults);
        for (const b of batch) {
          if (!successIds.includes(b.id)) successIds.push(b.id);
        }
        options?.onBatch?.({
          batchIndex,
          totalBatches,
          batchSize: batch.length,
          successTotal: successIds.length,
          failedTotal: 0,
          retry,
          durationMs: Date.now() - started,
          status: "ok",
        });
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
        failedBatchIndex = batchIndex;
        options?.onBatch?.({
          batchIndex,
          totalBatches,
          batchSize: batch.length,
          successTotal: successIds.length,
          failedTotal: batch.length,
          retry,
          durationMs: Date.now() - started,
          status: "failed",
          error: error.message,
        });
        break;
      }

      if (i + BATCH_SIZE < records.length && gapMs > 0) {
        await sleep(gapMs);
      }
    }

    return { results, successIds, failedBatchIndex, error };
  }

  /** Batched updates (size 10). Throws on first failed batch after recording progress via options. */
  async function updateRecordsBatched(
    table: string,
    records: Array<{ id: string; fields: Record<string, unknown> }>,
    options?: {
      batchSize?: number;
      gapMs?: number;
      onBatch?: (info: AirtableBatchProgress) => void;
    }
  ): Promise<AirtableRecord[]> {
    const detailed = await updateRecordsBatchedDetailed(table, records, options);
    if (detailed.error) throw detailed.error;
    return detailed.results;
  }

  return {
    listRecords,
    getRecord,
    createRecords,
    createRecordsBatched,
    updateRecords,
    updateRecordsBatched,
    updateRecordsBatchedDetailed,
  };
}

export type AirtableClient = ReturnType<typeof createAirtableClient>;
