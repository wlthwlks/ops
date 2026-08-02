# Signup widget

Embed: `#wlth-signup-root` + `public/widgets/signup/v1/signup.js`.

## Visual structure

- Max width ~1000px; two-column grids on desktop for short fields
- Top phases: Account → Location → Business → Payment → **Matching**
- Matching covers Goal / Help / Expertise / Connection with sub-progress `N of 4`
- `AnimatedLoader` variants for config load, step saves, Stripe verify/confirm (local DotLottie — see `docs/walking-loader-asset.md`)
- Deploy full `public/widgets/signup/v1/` (JS + CSS + `assets/animations/*.lottie`)

## Payment

- Customer-facing copy mentions **Stripe only** (not Memberstack)
- Checkout still uses Memberstack `purchasePlansWithCheckout` internally
- After return (`?payment=success` or in-place resolve): poll `GET /api/onboarding/payment-status`
- **Client never sets Payment=Paid or Membership=Active**
- Billing authority: signed Stripe `invoice.paid` (qualifying price) or Memberstack plan webhook

## Location

- Live catalogue: `COUNTRIES.Active` + `ALL CITIES.Form enabled` + Country link
- Codes = Airtable record ids

## Attribution

- First-touch in `localStorage` key `wlth_attribution_v1`
- Allowlist: utm_*, gclid, fbclid, wbraid, gbraid, landing, referrer, timestamp
- Bootstrap fills blank Airtable first-touch fields only

## Account create

- `Membership = Pending Payment`
- `Payment = Unpaid`
