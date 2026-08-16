import { NextRequest } from "next/server";
import { db } from "@/db";
import { z } from "zod";
import { requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk, jsonError } from "@/lib/ops/api-response";
import { createResendClient } from "@/lib/integrations/resend";
import { getLatestTemplateVersion, EmailTemplateError } from "@/lib/introduction/templates";
import { renderSampleEmail } from "@/lib/introduction/render-email";
import { getGlobalIntroductionConfig } from "@/lib/introduction/settings";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";

const testSendSchema = z.object({
  to: z.string().email(),
});

/** Send a rendered sample of the template's latest version to an admin-provided address. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  try {
    await requireLiveAdmin("introductions/templates/test-send");
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { templateId } = await params;
    const body = await request.json().catch(() => null);
    const input = testSendSchema.parse(body ?? {});

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return jsonError("RESEND_NOT_CONFIGURED", "RESEND_API_KEY is not configured", 500);

    const version = await getLatestTemplateVersion(db, templateId);
    if (!version) throw new EmailTemplateError("TEMPLATE_HAS_NO_VERSION", "Template has no version");

    const global = await getGlobalIntroductionConfig(db);
    const rendered = renderSampleEmail(version.subject, version.bodyHtml);
    const resend = createResendClient({ apiKey, fromEmail: global.senderFrom });
    const result = await resend.sendEmailToMany({
      to: [input.to],
      from: global.senderFrom,
      subject: `[Test] ${rendered.subject}`,
      html: rendered.html,
      replyTo: [input.to],
      idempotencyKey: `intro-test-${templateId}-${Date.now()}`,
    });
    if (!result) {
      return jsonError("TEST_SEND_FAILED", "The test email could not be sent", 502);
    }
    return jsonOk({ sent: true, resendMessageId: result.id, to: input.to });
  } catch (err) {
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
