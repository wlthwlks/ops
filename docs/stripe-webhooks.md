# Stripe webhooks

Endpoint: `POST /api/webhooks/stripe` (existing).

## Always on

`invoice.paid` → `syncInvoicePaidToAirtable` (never creates members).

## Flagged (`NEW_STRIPE_WEBHOOKS_ENABLED`)

- checkout.session.completed
- customer.subscription.created/updated/deleted
- invoice.payment_failed
- invoice.payment_action_required
- charge.refunded

Missing Airtable member → `STRIPE_MEMBER_NOT_FOUND` / pending dependency — **no create, no email search**.
