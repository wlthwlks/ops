# Update Details widget

Build: `npm run widgets:build:update` → `public/widgets/update-details/v1/`.

Prefills from `GET /api/member/profile`. Saves via `PATCH /api/member/profile`.

Email changes: Memberstack first (`POST /api/member/email`), then Airtable.

Billing: `launchStripeCustomerPortal()` + `GET /api/member/billing-status`.

City changes do not auto-modify Slack channels or introductions.
