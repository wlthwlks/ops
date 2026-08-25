import { Resend } from "resend";
import { createHash } from "node:crypto";

export interface ResendConfig {
  apiKey: string;
  fromEmail: string;
}

/** One logical group introduction email (multiple visible recipients). */
export interface ResendBatchMessage {
  to: string[];
  from: string;
  subject: string;
  html: string;
  cc?: string[];
  replyTo?: string[];
  idempotencyKey?: string;
}

export interface ResendBatchResultItem {
  ok: boolean;
  /** Permanent failures must never be retried. */
  permanent: boolean;
  id: string | null;
  error: string | null;
}

/**
 * Classify provider errors: permanent (invalid addresses, suppression,
 * validation) vs transient (rate limits, provider hiccups).
 */
export function isPermanentResendError(message: string): boolean {
  if (/rate limit|quota|too many|internal|application error|timeout|connection|retry/i.test(message)) {
    return false;
  }
  return /validation|invalid|rejected|suppressed|not allowed|required|restricted|malformed|missing/i.test(
    message
  );
}

export function createResendClient(config: ResendConfig) {
  const client = new Resend(config.apiKey);

  async function sendEmail(
    to: string,
    subject: string,
    html: string,
    options?: { cc?: string | string[]; bcc?: string | string[]; replyTo?: string | string[] }
  ): Promise<{ id: string } | null> {
    try {
      const result = await client.emails.send({
        from: config.fromEmail,
        to,
        subject,
        html,
        ...(options?.cc ? { cc: options.cc } : {}),
        ...(options?.bcc ? { bcc: options.bcc } : {}),
        ...(options?.replyTo ? { replyTo: options.replyTo } : {}),
      });
      if (result.error) {
        console.error(`Resend error for ${to}:`, result.error);
        return null;
      }
      return result.data ? { id: result.data.id } : null;
    } catch (err) {
      console.error(`Failed to send email to ${to}:`, err);
      return null;
    }
  }

  /**
   * Send one logical email to multiple visible recipients (one message id).
   * Uses an idempotency key so provider-side retries never duplicate sends.
   */
  async function sendEmailToMany(message: ResendBatchMessage): Promise<{ id: string } | null> {
    try {
      const result = await client.emails.send(
        {
          from: message.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          replyTo: message.replyTo,
        },
        message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : undefined
      );
      if (result.error) {
        console.error("Resend error:", result.error);
        return null;
      }
      return result.data ? { id: result.data.id } : null;
    } catch (err) {
      console.error("Failed to send batch email:", err);
      return null;
    }
  }

  const RESEND_BATCH_MAX = 100;

  /**
   * Send many group emails through the Resend batch API (permissive
   * validation so valid emails still go out), with a deterministic
   * batch-level idempotency key derived from the per-message keys.
   * Chunks at the provider's 100-email batch limit.
   */
  async function sendBatch(messages: ResendBatchMessage[]): Promise<ResendBatchResultItem[]> {
    if (messages.length === 0) return [];
    const results: ResendBatchResultItem[] = [];
    for (let i = 0; i < messages.length; i += RESEND_BATCH_MAX) {
      results.push(...(await sendBatchChunk(messages.slice(i, i + RESEND_BATCH_MAX))));
    }
    return results;
  }

  async function sendBatchChunk(messages: ResendBatchMessage[]): Promise<ResendBatchResultItem[]> {
    if (messages.length === 0) return [];
    const batchKey = `intro-batch-${createHash("sha256")
      .update(messages.map((m) => m.idempotencyKey ?? "").join("|"))
      .digest("hex")}`;
    try {
      const response = await client.batch.send(
        messages.map((m) => ({
          from: m.from,
          to: m.to,
          ...(m.cc && m.cc.length > 0 ? { cc: m.cc } : {}),
          subject: m.subject,
          html: m.html,
          ...(m.replyTo && m.replyTo.length > 0 ? { replyTo: m.replyTo } : {}),
        })),
        { batchValidation: "permissive", idempotencyKey: batchKey }
      );
      if (response.error) {
        // Whole-batch rejections (auth, rate limits, provider errors) are
        // environmental, not recipient problems — retryable with backoff.
        const message = response.error.message ?? response.error.name;
        console.error("Resend batch rejected:", message);
        return messages.map(() => ({ ok: false, permanent: false, id: null, error: message }));
      }
      // The Resend SDK wraps the batch response one level deeper than its
      // own types suggest: runtime shape is
      //   { data: { data: [{ id }], errors: [{ index, message }] } }
      // while the SDK types claim a flat `{ data: [{ id }] }`. Accept both.
      const success = response as unknown as {
        data?:
          | Array<{ id: string }>
          | { data?: Array<{ id: string }>; errors?: Array<{ index: number; message: string }> };
        errors?: Array<{ index: number; message: string }>;
      };
      const payload = Array.isArray(success.data)
        ? { data: success.data, errors: success.errors ?? [] }
        : { data: success.data?.data ?? [], errors: success.data?.errors ?? [] };
      const errors = new Map(
        (payload.errors ?? []).map((e: { index: number; message: string }) => [e.index, e.message])
      );
      return messages.map((_, index) => {
        const error = errors.get(index);
        if (error) {
          return { ok: false, permanent: isPermanentResendError(error), id: null, error };
        }
        const id = payload.data[index]?.id;
        if (id) return { ok: true, permanent: false, id, error: null };
        return { ok: false, permanent: false, id: null, error: "No message id returned" };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { statusCode?: number }).statusCode ?? 0;
      const permanent = !(status === 429 || status >= 500);
      console.error("Resend batch failed:", message);
      return messages.map(() => ({ ok: false, permanent, id: null, error: message }));
    }
  }

  return { sendEmail, sendEmailToMany, sendBatch };
}

export type ResendClient = ReturnType<typeof createResendClient>;
