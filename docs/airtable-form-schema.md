# Airtable form schema

Verified against the live preview base via Airtable REST (Metadata API token lacks `schema.bases:read` — field types probed with read/write samples).

## MEMBERS — key columns

| Field | Type (probed) | Notes |
|---|---|---|
| `Name` | formula | **Never write** |
| `email` | text | |
| `First Name` / `Last Name` | text | |
| `phone number` | text | |
| `Membership` | single select | Options include `Active`, **`Pending Payment`** (required for signup) |
| `Payment` | single select | `Unpaid`, `Paid` |
| `City` | text | City label |
| `City relation` | linked → ALL CITIES | Write `[recordId]` |
| `Timezone` | text | |
| `Availability` | text | Legacy string |
| `Availability v2` | multi-select | Codes `mon_morning` … `sun_evening` as **string[]** |
| `Industry` / `Revenue` | single select | App codes; forms use `typecast: true` |
| `Business stage` / `Connection type` | single select | App codes |
| `Business description` | text | |
| `Current 90-day goal` / `Goal updated at` | text / date | |
| `Help wanted context` / `Expertise context` | text | No code-list columns |
| `Topics to Discuss` | text | |
| `Onboarding status` / `Last completed signup step` | text | Progress only — not billing |
| `Stripe Customer ID` | text | |
| `Service access until` | date | Monotonic |
| `Stripe Price ID` | text | Primary qualifying price |
| `Paid Plans (price ids)` | **text** | Comma-separated unique `price_…` ids (not multi-select) |
| `Stripe Subscription ID` | text | |
| `Stripe subscription status` | text | |
| `Last invoice ID` / `Last invoice status` | text | |
| `Billing last synced at` / `Last Stripe event ID` | date/text | |
| UTM / click / landing / referrer / first attribution | text/date | First-touch only |

### Does not exist / never write

- `Last form source`
- `Country code` / `City code` on MEMBERS
- `Business name` / `Business website`
- `Help wanted` / `Expertise offered` code columns

## COUNTRIES

| Field | Type |
|---|---|
| `Name` | text |
| `Active` | checkbox — **must be true** for forms |
| `ALL CITIES` | linked |

## ALL CITIES

| Field | Type |
|---|---|
| `City` | text |
| `Country` | linked → COUNTRIES |
| `Form enabled` | checkbox — **must be true** for forms |
| `Active` | number/rollup (not used for form eligibility) |
| `Slack channels` | linked |
| `City Tier` | text |

## Membership state machine

| Event | Membership | Payment |
|---|---|---|
| Account created (bootstrap) | `Pending Payment` | `Unpaid` |
| Client checkout return | *unchanged* | *unchanged* |
| Trusted `invoice.paid` (qualifying price) | `Active` | `Paid` |
| Trusted Memberstack plan.added (flag on) | `Active` | `Paid` |

**Clients cannot set Paid/Active.** `PAYMENT_CONFIRMED` step is a navigation checkpoint only.

## Location catalogue rules

1. Country: `Active === true` (boolean, not string `"true"`)
2. City: `Form enabled === true`
3. City must link to an eligible country via `Country`
4. Countries with zero eligible cities are omitted
5. Form codes = Airtable record ids
