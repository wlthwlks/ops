# Stripe webhooks

Endpoint: `POST /api/webhooks/stripe` (existing).

## Always on: pause collection (`customer.subscription.updated`)

**This path is not disabled by form feature flags.**

Stripe pause collection does NOT change the subscription status — it stays
`active` and the pause is only visible as `pause_collection` on the
subscription object (`resumes_at: null` = indefinite). The dedicated
`customer.subscription.paused` / `customer.subscription.resumed` events belong
to other flows (e.g. subscription schedules that DO set status `paused`) and
are NOT required for this integration — `customer.subscription.updated`
alone is sufficient.

Detected transitions (`src/lib/billing/pause-sync.ts`):

- Pause: `pause_collection` set on the subscription (or status `paused`)
- Resume: `pause_collection` cleared (visible via `previous_attributes.pause_collection`),
  status transition `paused → active`, or the `customer.subscription.resumed` event

On pause, Airtable is updated: `Stripe subscription status = "paused"` (our
marker column — Stripe's own status stays active), `Billing pause until` =
resume date or blank, `Service access until` = now, `Membership = "Paused"`.
On resume the fields are restored (`Membership = "Active"`, access until from
the Stripe period end when still in the future). Missed events can be repaired
with `npm run billing:backfill-pauses`.

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
2. If found → update (authoritative):
   - `Payment = Paid`, `Membership = Active`
   - `Service access until` (monotonic — never moves backwards)
   - `Stripe Customer ID`, `Stripe Price ID`, `Paid Plans (price ids)` (text, comma-separated)
   - `Stripe Subscription ID` / status when present on the invoice
   - `Last invoice ID` / status, `Billing last synced at`, `Last Stripe event ID`
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

- checkout.session.completed — only a session with `payment_status: paid` (or `no_payment_required`) marks Payment=Paid / Membership=Active. Unpaid sessions only link customer/subscription ids (`ignored_unpaid`).
- customer.subscription.created/updated — identity/cancel-flag reconciliation ONLY. Never writes Payment=Paid, Membership=Active or Service access until: Memberstack updates the subscription while preparing checkout (before any payment), which fires `subscription.updated` with the old status and previously re-marked members as paid without payment. Payment evidence is owned by `invoice.paid` and trusted confirm-checkout.
- customer.subscription.deleted
- invoice.payment_failed
- invoice.payment_action_required
- charge.refunded

Still: no Airtable member creation; no email fallback for Stripe identity.
