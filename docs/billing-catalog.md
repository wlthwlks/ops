# Billing Catalog & Offer Resolver

Centralized, typed price/offer configuration replacing the previous
single-price architecture. One source of truth for signup checkout,
reactivation, Stripe entitlement/webhook qualification, and promo codes.

## Where it lives

- Module: `src/lib/billing/catalog.ts`
- Config: `BILLING_CATALOG_JSON` env var (one JSON string per environment)
- Endpoint: `POST /api/onboarding/billing-offer` (promo-code resolution)
- Legacy fallback: the old env vars still work when `BILLING_CATALOG_JSON` is unset.

## Catalog schema

```json
{
  "version": 1,
  "defaultTierKey": "standard",
  "defaultPriceKey": "standard_quarterly_default",
  "prices": [
    {
      "priceKey": "standard_quarterly_default",
      "tierKey": "standard",
      "cadence": "quarterly",
      "intervalCount": 3,
      "stripePriceId": "price_...",
      "memberstackPriceId": "prc_...",
      "sellable": true,
      "legacy": false,
      "eligibleForSignup": true,
      "eligibleForReactivation": true,
      "label": "$87 every 3 months",
      "description": null,
      "trialDays": null,
      "amountUsd": 87
    }
  ],
  "offers": [
    {
      "offerKey": "founders45",
      "code": "FOUNDERS45",
      "targetPriceKey": "standard_quarterly_founders45",
      "enabled": true,
      "startDate": null,
      "endDate": null,
      "newCustomersOnly": true,
      "redemptionLimits": null
    }
  ]
}
```

### Price fields

| Field | Type | Notes |
| --- | --- | --- |
| `priceKey` | string | Stable internal key, shared across Test/Preview/Production. |
| `tierKey` | string | `standard`, `basic`, `gold`, `platinum`, … — never hardcoded in code. |
| `cadence` | enum | `monthly` \| `quarterly` \| `yearly` \| `custom` (metadata only — no special-case code). |
| `intervalCount` | number? | e.g. `3` for quarterly. |
| `stripePriceId` | string? | Native Stripe `price_…` id for this environment. |
| `memberstackPriceId` | string? | Memberstack `prc_…` id for this environment. |
| `sellable` | boolean | Can be purchased today. Legacy prices must be `false`. |
| `legacy` | boolean | Grandfathered retention entry — stays in the qualification allowlist but is never sold. |
| `eligibleForSignup` | boolean | May be selected for new signups (default price or via offer). |
| `eligibleForReactivation` | boolean | May be used when creating a NEW subscription on rejoin. |
| `label` / `description` | string? | Customer-facing display text. |
| `trialDays` / `amountUsd` | number? | Reference metadata (trial is configured in Stripe/Memberstack). |

### Offer fields

| Field | Type | Notes |
| --- | --- | --- |
| `offerKey` | string | Internal key. |
| `code` | string | Customer-facing code; normalized (trim + uppercase) on both sides. |
| `targetPriceKey` | string | Must match a catalog `priceKey`. |
| `enabled` | boolean | Disabled codes never resolve. |
| `startDate` / `endDate` | string? | ISO dates; enforced by the resolver. |
| `newCustomersOnly` | boolean? | Enforced by the endpoint (member not already Paid+Active). |
| `redemptionLimits` | object? | Reserved for future limits (`maxRedemptions`, `maxPerMember`). |

## Offer resolution rules

- `resolveOffer(code)` normalizes the input (trim + uppercase) and matches
  against `offers[].code`.
- Failure statuses: `unknown`, `disabled`, `expired`, `not_started`,
  `new_customers_only`, `unavailable`.
- Invalid/disabled codes NEVER resolve to the default price. Widgets block
  checkout while a typed-but-unapplied code is present.

## The first offer: FOUNDERS45

Maps to priceKey `standard_quarterly_founders45` — a special Standard
quarterly price configured externally in Memberstack/Stripe as
**3 months free, then $45 every 3 months indefinitely**
(`trialDays: 90`, trial configured in the Stripe/Memberstack product).
The catalog entry carries `eligibleForReactivation: false`, so rejoin flows
never create subscriptions at this price.

## Env vars

### New

| Var | Purpose |
| --- | --- |
| `BILLING_CATALOG_JSON` | Full catalog (prices + offers). Per-environment. |

### Retained for migration compatibility (fallback when catalog unset)

| Var | Legacy role |
| --- | --- |
| `STRIPE_MEMBERSHIP_PRICE_IDS` | Native `price_` allowlist (legacy + current). Becomes legacy-retention entries. |
| `STRIPE_REACTIVATION_PRICE_ID` | Current rejoin price. Becomes the default catalog entry. |
| `MEMBERSTACK_MEMBERSHIP_PRICE_ID` | Default signup `prc_`. Attached to the default entry. |
| `MEMBERSTACK_PLAN_ID` | Extra commerce id. Becomes a legacy entry. |

Migration mapping: the reactivation price becomes the default sellable entry
(`eligibleForSignup`/`eligibleForReactivation` true); all other native prices
become `legacy: true, sellable: false` entries (so grandfathering keeps
working); the `prc_` id is attached to the default entry. Behavior is
equivalent to the previous single-price configuration — production is not
broken during migration.

## Behavior changes (intentional)

- Stripe entitlement/webhook/confirm-checkout qualification comes from the
  catalog allowlist (all entries incl. legacy retention) + explicit legacy
  prices only. The old mid-signup "any live `price_` can pass" fallback
  (`mid_signup_live_sub`, `mid_signup_price_passthrough`) is removed —
  unknown/unrelated Stripe prices fail closed in every environment.
- "Memberstack Plan ID" is now resolved from the ACTUAL Stripe price via the
  catalog instead of one global `getConfiguredMemberstackPlanId()`. Unknown
  prices leave the existing Airtable value untouched (never overwritten with
  an unrelated default).
- Reactivation rules are unchanged: active → no charge; scheduled cancel in
  paid period → reverse only (keeps grandfathered price); expired → new sub at
  the current default reactivation price; fully refunded → loses grandfathering
  and rejoins at the current price; never duplicate subscriptions.

## API: POST /api/onboarding/billing-offer

Memberstack token auth + public write rate limit. Body: `{ "code": "FOUNDERS45" }`.

Success (200):

```json
{
  "success": true,
  "applied": true,
  "offerCode": "FOUNDERS45",
  "priceKey": "standard_quarterly_founders45",
  "memberstackPriceId": "prc_...",
  "label": "$45 every 3 months",
  "description": "3 months free, then $45 every 3 months indefinitely",
  "trialDays": 90
}
```

Failure (400): `{ "success": false, "applied": false, "code": "INVALID_OFFER_CODE", "status": "unknown|disabled|expired|not_started|new_customers_only|unavailable", "message": "..." }`.

Client-supplied Stripe/Memberstack price ids are never accepted — only the
code is validated.

## Manual steps when adding a future Memberstack/Stripe price

1. **Stripe**: create the new recurring Price (`price_…`) for the membership
   product. If the price should trial, configure the trial on the product/price
   (Stripe Checkout / Memberstack settings).
2. **Memberstack**: create (or map) the corresponding plan so a `prc_…`
   commerce id exists for checkout via `purchasePlansWithCheckout()`.
3. **Pick a stable `priceKey`** (e.g. `standard_quarterly_new`, `basic_monthly`)
   and a `tierKey` (`standard`, `basic`, `gold`, `platinum`). These must be
   identical in every environment.
4. **Add a catalog entry** to `BILLING_CATALOG_JSON` in each Vercel
   environment (Production, Preview, Test) with that env's `price_…`/`prc_…`
   ids and the right flags:
   - new current default: `sellable: true, legacy: false, eligibleForSignup: true, eligibleForReactivation: true`, then update `defaultPriceKey`.
   - add-on cadence (monthly/yearly): `sellable: true, eligibleForSignup: true, eligibleForReactivation: false`.
   - replacement price: mark the old price `sellable: false, legacy: true` so existing members keep qualifying (grandfathering); keep it in `prices`, never delete it.
5. **Optional offer**: add an `offers` entry mapping a normalized code to the
   new `priceKey` (`enabled: true`, optional `startDate`/`endDate`/`newCustomersOnly`).
6. **Add a fixture test** in `tests/lib/billing/catalog.test.ts` (or the
   generic second-tier fixture) proving the new entry resolves without any
   billing-flow code changes.
7. **Update `.env.example`** if the shape changes; redeploy each environment.
8. **Verify**: signup checkout with no code uses the default `prc_`; checkout
   with the new offer code uses the new `prc_`; an unknown `price_` from
   Stripe is rejected by confirm-checkout; an old member's legacy invoice still
   qualifies for service access.
