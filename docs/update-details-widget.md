# Update Details widget

Build: `npm run widgets:build` (or `widgets:build:update`) → `public/widgets/update-details/v1/`.

Deploy full folder: JS + CSS + `assets/animations/*.lottie`.

## Flows

### Profile refresh (once per login session)

Existing members who land on this page after login see a short **Location → Business → Matching** refresh before the full form.

- Saves via `PATCH /api/member/profile` only (never `/api/onboarding/step`)
- Does not change billing or onboarding progress fields
- Completion marker: `sessionStorage` key scoped to member id + login session fingerprint (JWT `jti` or `sub`+`iat`) — never stores the raw access token
- Page refresh in the same login session does not restart the flow
- A different member in the same tab cannot reuse the marker
- Successful full signup sets the same marker so new members are not forced through refresh immediately

**Webflow / Memberstack configuration (required for enforcement):**

Memberstack’s post-login redirect for existing members must send them to the Webflow page that hosts the Update Details widget (`#wlth-update-details-root`). This repository can only enforce the refresh on pages where the widget is embedded — it is not a global Memberstack gate.

### Full Update Details form

Prefills from `GET /api/member/profile`. Saves via `PATCH /api/member/profile`.

Email changes: Memberstack first (`POST /api/member/email`), then Airtable.

Billing: `launchStripeCustomerPortal()` + `GET /api/member/billing-status`.
Reactivate (lapsed + saved card): `POST /api/member/reactivate`.

### UI

| Feature | Behaviour |
|---|---|
| Sticky save bar | Shows unsaved / saved state; submits the same form |
| Full-page loader | `PageBlockingLoader` portalled to `document.body` |
| Phone | Prefix + national number (`Phone prefix` + `phone number`) |
| Help / Expertise | Multi-select dropdowns → linked fields + separate context text |
| Industry | Includes Coaching; Other reveals free-text → stored in `Industry` |
| Disabled previous city | Message + require a currently form-enabled city |

Loaders (`AnimatedLoader` — see `docs/walking-loader-asset.md`):

| State | Variant |
|---|---|
| Initial profile load | `profile-loading` |
| Save / refresh | `profile-updating` |
| Reactivate / payment confirm | `payment-verification` |

City changes do not auto-modify Slack channels or introductions.
