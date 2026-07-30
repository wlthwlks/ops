# Memberstack webhooks

Endpoint: `POST /api/webhooks/memberstack`

Verify: Svix (`MEMBERSTACK_WEBHOOK_SECRET`) on raw body.

Enable apply: `NEW_MEMBERSTACK_WEBHOOKS_ENABLED=true` and `MAKE_SHADOW_MODE=false`.

Handlers (normalized type contains):

- `member.created` — minimal Airtable ensure
- `member.updated` — identity reconcile (no blank overwrite)
- `plan.added` / plan created — billing fields on existing member only
- `plan.canceled` — cancel-at-period-end note
- `member.deleted` — soft mark; history preserved

Inspect Memberstack Event Catalog and adjust `memberstack-handlers.ts` if names differ.
