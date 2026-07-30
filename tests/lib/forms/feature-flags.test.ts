import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getFormFeatureFlags,
  canWriteAirtableFromForms,
  canApplyExpandedStripeWebhooks,
} from "@/lib/forms/feature-flags";

describe("form feature flags", () => {
  const keys = [
    "NEW_SIGNUP_WIDGET_ENABLED",
    "NEW_UPDATE_DETAILS_WIDGET_ENABLED",
    "NEW_STRIPE_WEBHOOKS_ENABLED",
    "MAKE_SHADOW_MODE",
  ];
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  it("defaults all write flags off", () => {
    const f = getFormFeatureFlags();
    expect(f.newSignupWidgetEnabled).toBe(false);
    expect(f.newStripeWebhooksEnabled).toBe(false);
    expect(canWriteAirtableFromForms()).toBe(false);
    expect(canApplyExpandedStripeWebhooks()).toBe(false);
  });

  it("shadow mode blocks writes even when signup enabled", () => {
    process.env.NEW_SIGNUP_WIDGET_ENABLED = "true";
    process.env.MAKE_SHADOW_MODE = "true";
    expect(canWriteAirtableFromForms()).toBe(false);
  });

  it("enables writes when signup on and shadow off", () => {
    process.env.NEW_SIGNUP_WIDGET_ENABLED = "true";
    process.env.MAKE_SHADOW_MODE = "false";
    expect(canWriteAirtableFromForms()).toBe(true);
  });
});
