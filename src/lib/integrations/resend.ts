import { Resend } from "resend";

export interface ResendConfig {
  apiKey: string;
  fromEmail: string;
}

export function createResendClient(config: ResendConfig) {
  const client = new Resend(config.apiKey);

  async function sendEmail(
    to: string,
    subject: string,
    html: string,
    options?: { cc?: string | string[]; replyTo?: string | string[] }
  ): Promise<{ id: string } | null> {
    try {
      const result = await client.emails.send({
        from: config.fromEmail,
        to,
        subject,
        html,
        ...(options?.cc ? { cc: options.cc } : {}),
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

  return { sendEmail };
}

export type ResendClient = ReturnType<typeof createResendClient>;
