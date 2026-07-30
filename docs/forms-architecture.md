# Forms architecture (Tally / Make replacement)

## Goal

Replace Tally signup and four Make automations with Vercel-hosted widgets + verified webhooks, without changing introductions or matching.

## Flows

```text
Webflow /apply → public/widgets/signup/v1 → Memberstack + /api/onboarding/*
Webflow /update-details → public/widgets/update-details/v1 → /api/member/*
Memberstack Svix → /api/webhooks/memberstack
Stripe → /api/webhooks/stripe (invoice.paid always; expanded events flagged)
```

## Feature flags

All default **false**. See `.env.example`.

| Flag | Effect |
|------|--------|
| `NEW_SIGNUP_WIDGET_ENABLED` | Allows onboarding Airtable writes |
| `NEW_UPDATE_DETAILS_WIDGET_ENABLED` | Allows profile PATCH writes |
| `NEW_MEMBERSTACK_WEBHOOKS_ENABLED` | Applies MS webhook side effects |
| `NEW_STRIPE_WEBHOOKS_ENABLED` | Applies expanded Stripe lifecycle (not invoice.paid) |
| `NEW_FORM_ANALYTICS_ENABLED` | Persists funnel events |
| `MAKE_SHADOW_MODE` | Logs intended writes; never writes Airtable from forms |

## Identity

1. Memberstack ID (primary)
2. Stripe Customer ID (billing only)
3. Normalized email (signup recovery only — **never** Stripe)

Stripe **never** creates Airtable members.

## Read-only systems

Matching, matchmake, messaging, daily-match-message, recurring-city-intros, Pinecone, introduction ledger — not imported by `src/lib/forms/**`.

## OPS

- `/ops/webhook-errors` — integration_errors
- `/ops/form-analytics` — funnel KPIs
