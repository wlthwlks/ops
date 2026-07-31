# Shadow mode vs complete signup testing

## `MAKE_SHADOW_MODE=true`

Forms Airtable **writes are skipped** (bootstrap/step/profile return `shadowed: true`).

Useful for:

- Isolated API contract checks
- Confirming validation / auth without mutating Airtable

**Not** useful for a full multi-step signup: after bootstrap shadow, `PATCH /onboarding/step` looks up the Memberstack ID in Airtable and returns **404**.

## Complete new-member flow (test base only)

```text
MAKE_SHADOW_MODE=false
NEW_SIGNUP_WIDGET_ENABLED=true
NEW_UPDATE_DETAILS_WIDGET_ENABLED=true   # if testing profile
NEW_MEMBERSTACK_WEBHOOKS_ENABLED=true     # if testing MS webhooks
```

Point at a **duplicate test Airtable base** and Memberstack/Stripe **test** credentials.

## Stripe `invoice.paid`

Independent of shadow mode — see `docs/stripe-webhooks.md`. Always uses exact Stripe Customer ID only; never email-links.
