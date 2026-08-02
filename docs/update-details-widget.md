# Update Details widget

Build: `npm run widgets:build` (or `widgets:build:update`) → `public/widgets/update-details/v1/`.

Deploy full folder: JS + CSS + `assets/animations/*.lottie`.

Prefills from `GET /api/member/profile`. Saves via `PATCH /api/member/profile`.

Email changes: Memberstack first (`POST /api/member/email`), then Airtable.

Billing: `launchStripeCustomerPortal()` + `GET /api/member/billing-status`.
Reactivate (lapsed + saved card): `POST /api/member/reactivate`.

Loaders (`AnimatedLoader` — see `docs/walking-loader-asset.md`):

| State | Variant |
|---|---|
| Initial profile load | `profile-loading` |
| Save | `profile-updating` (CSS fallback until asset added) |
| Reactivate / payment confirm | `payment-verification` |

City changes do not auto-modify Slack channels or introductions.
