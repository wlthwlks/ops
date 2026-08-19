# Memberstack webhooks

Endpoint: `POST /api/webhooks/memberstack`

Verify: Svix (`MEMBERSTACK_WEBHOOK_SECRET`) on raw body.

Enable apply: `NEW_MEMBERSTACK_WEBHOOKS_ENABLED=true` and `MAKE_SHADOW_MODE=false`.

Handlers (normalized type contains):

- `member.created` — minimal Airtable ensure
- `member.updated` — identity reconcile (no blank overwrite)
- `plan.added` / plan created — plan/customer id reconciliation ONLY on existing member. Never writes Payment=Paid or Membership=Active (Memberstack can attach a plan connection without any payment, e.g. around Stripe Customer Portal interactions with an unpaid subscription). Paid/Active are owned by real payment evidence: Stripe `invoice.paid` webhooks and trusted confirm-checkout.
- `plan.canceled` — cancel-at-period-end note
- `member.deleted` — soft mark; history preserved

### Payload envelopes

`pickMember` accepts all of:

```ts
payload.data
payload.payload   // documented Memberstack member.created shape
payload           // root
```

Nested `member` objects and `auth.email` / `customFields` are supported. Confirm against live Svix logs after first delivery.
