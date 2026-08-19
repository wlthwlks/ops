# Signup widget

Embed: `#wlth-signup-root` + `public/widgets/signup/v1/signup.js`.

## Visual structure

- Max width ~1000px; two-column grids on desktop for short fields
- Top phases: Account → Location → Business → Payment → **Matching**
- Matching covers Goal / Help / Expertise / Connection with sub-progress `N of 4`
- `AnimatedLoader` variants for config load, step saves, Stripe verify/confirm (local DotLottie — see `docs/walking-loader-asset.md`)
- Deploy full `public/widgets/signup/v1/` (JS + CSS + `assets/animations/*.lottie`)

## Account

- Phone: country calling code selector + national number
- Written separately to Airtable `Phone prefix` and `phone number`
- Default prefix from browser locale when confidently resolved; otherwise member chooses
- Location country can sync the prefix unless the member overrode it

## Payment

- Customer-facing copy mentions **Stripe only** (not Memberstack)
- Community intention checkbox required before checkout (not stored in Airtable)
- Checkout still uses Memberstack `purchasePlansWithCheckout` internally
- **Outbound checkout** shows only `payment-verification` Lottie — never `payment-confirmed`
- **Return path only** (`?payment=success`, verified session id, or fresh checkout flags): `payment-confirmed` + server confirm + poll
- After return: poll `GET /api/onboarding/payment-status`
- **Client never sets Payment=Paid or Membership=Active**
- Billing authority: signed Stripe `invoice.paid` (qualifying price) or Memberstack plan webhook
- Checkout cancel / close restores Payment without the confirmed animation
- **Slack notification**: on the first successful payment of a mid-signup member
  (`confirm-checkout` write, previous `Payment` ≠ Paid), a message is posted to
  the `ww-new-members` channel on wlthwlks.slack.com via a dedicated bot
  (`SLACK_WW_BOT_TOKEN` / `SLACK_WW_NEW_MEMBERS_CHANNEL`), gated by
  `BILLING_ALERTS_TO_SLACK_ENABLED`. Failures never block checkout confirmation.

## Location

- Live catalogue: `COUNTRIES.Active` + `ALL CITIES.Form enabled` + Country link
- Codes = Airtable record ids
- Reference-data route is `no-store` / force-dynamic

## Business

- Industry includes **Coaching**
- **Other** requires free-text; custom value stored in `Industry`

## Matching

- Help / Expertise use accessible multi-select dropdowns (chips)
- Selected values → `Help wanted` / `Expertise` (linked record ids when catalogue is live)
- Optional context → context columns only (never concatenated codes)

## Attribution

- First-touch in `localStorage` key `wlth_attribution_v1`
- Allowlist: utm_*, gclid, fbclid, wbraid, gbraid, landing, referrer, timestamp
- Bootstrap fills blank Airtable first-touch fields only

## Account create

- `Membership = Pending Payment`
- `Payment = Unpaid`
- On complete, sets profile-refresh session marker so Update Details does not re-ask immediately
