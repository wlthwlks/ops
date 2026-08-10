/**
 * Feature flags for forms/webhooks replacement.
 * All write paths default OFF — production cutover is manual.
 */

function flag(name: string, defaultValue = false): boolean {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (!raw) return defaultValue;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return defaultValue;
}

export function getFormFeatureFlags() {
  return {
    newSignupWidgetEnabled: flag("NEW_SIGNUP_WIDGET_ENABLED"),
    newUpdateDetailsWidgetEnabled: flag("NEW_UPDATE_DETAILS_WIDGET_ENABLED"),
    newMemberstackWebhooksEnabled: flag("NEW_MEMBERSTACK_WEBHOOKS_ENABLED"),
    newStripeWebhooksEnabled: flag("NEW_STRIPE_WEBHOOKS_ENABLED"),
    newFormAnalyticsEnabled: flag("NEW_FORM_ANALYTICS_ENABLED"),
    makeShadowMode: flag("MAKE_SHADOW_MODE"),
    billingAlertsToSlackEnabled: flag("BILLING_ALERTS_TO_SLACK_ENABLED"),
    serviceAccessPolicyV2Enabled: flag("SERVICE_ACCESS_POLICY_V2_ENABLED"),
  } as const;
}

export type FormFeatureFlags = ReturnType<typeof getFormFeatureFlags>;

/** True when Airtable writes from new forms should actually apply. */
export function canWriteAirtableFromForms(): boolean {
  const f = getFormFeatureFlags();
  if (f.makeShadowMode) return false;
  return f.newSignupWidgetEnabled || f.newUpdateDetailsWidgetEnabled;
}

export function canApplyMemberstackWebhooks(): boolean {
  const f = getFormFeatureFlags();
  if (f.makeShadowMode) return false;
  return f.newMemberstackWebhooksEnabled;
}

export function canApplyExpandedStripeWebhooks(): boolean {
  const f = getFormFeatureFlags();
  if (f.makeShadowMode) return false;
  return f.newStripeWebhooksEnabled;
}
