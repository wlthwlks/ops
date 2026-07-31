# Stripe webhooks

Endpoint: `POST /api/webhooks/stripe` (existing).

## Always on: `invoice.paid`

**This path is not disabled by form feature flags.**

These do **not** stop `invoice.paid` Airtable writes:

- `MAKE_SHADOW_MODE=true`
- `NEW_STRIPE_WEBHOOKS_ENABLED=false`
- `INTRODUCTIONS_MODE=read_only`

`invoice.paid` always calls `syncInvoicePaidToAirtable` with `dryRun: false` when signature verification succeeds.

### Exact Stripe Customer ID only

Matching rule:

1. Find Airtable Members where `Stripe Customer ID` **exactly** equals the invoice customer.
2. If found → update `Service access until` (and related billing fields via existing helper).
3. If **not** found:
   - **Do not** search by email.
   - **Do not** write or link Stripe Customer ID.
   - Within `STRIPE_MEMBER_REGISTRATION_RETRY_HOURS` (default 24) → `member_registration_pending` + HTTP **503** (Stripe retries).
   - After window → `stripe_member_not_found` + HTTP **200** (stop retrying).

Historical linking of missing Stripe Customer IDs is **CLI-only**:

```bash
npm run airtable:historical-stripe-repair
npm run airtable:reconcile-stripe-customers
```

### Preview / staging safety

Because `invoice.paid` always writes when configured, any environment that receives live Stripe events **must** use:

| Use | Never use in preview |
|-----|----------------------|
| Stripe **test** secret + webhook secret | Live `sk_live_` / live webhook |
| Test membership price IDs | Production price IDs |
| **Test Airtable base** (`AIRTABLE_BASE_ID`) | Production Airtable base |

Do not point a preview deploy at production Airtable while Stripe webhooks are connected.

## Flagged expanded events (`NEW_STRIPE_WEBHOOKS_ENABLED=true`)

Only when flag is on and shadow mode is off:

- checkout.session.completed
- customer.subscription.created/updated/deleted
- invoice.payment_failed
- invoice.payment_action_required
- charge.refunded

Still: no Airtable member creation; no email fallback for Stripe identity.
