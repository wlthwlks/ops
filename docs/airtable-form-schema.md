# Airtable form schema

Canonical MEMBERS field names used by signup/onboarding/update-details. Exact names only — see `src/lib/airtable/schema.ts`.

## Writable (forms / billing)

- `email`, `First Name`, `Last Name`, `phone number`
- `Memberstack ID`, `Stripe Customer ID`, `Stripe Subscription ID`, `Stripe Price ID`, `Memberstack Plan ID`
- `Membership`, `Payment`, `Date joined`, `Cancellation date`, `Service access until`
- `City`, `City relation`, `Timezone`, `Availability`, `Availability v2`, `Location data version`
- `Industry`, `Revenue`, `Business stage`, `Business description`, `Connection type`
- `Current 90-day goal`, `Goal updated at`
- `Help wanted context`, `Expertise context` (no code-list columns)
- `Onboarding status`, `Last completed signup step`, `Profile schema version`, `Onboarding completed at`, `Profile last updated at`
- `UTM Source`, `UTM Medium`, `UTM Campaign`, `UTM Content`, `UTM Term`
- `Google Click ID`, `Facebook Click ID`, `Initial landing page`, `Initial referrer`, `First attribution captured at`
- Stripe lifecycle: `Stripe subscription status`, `Cancel at period end`, `Cancellation requested at`, `Cancellation effective at`, invoice/failure/billing sync fields
- Matching-related (ops, not forms): `Recurring intro status`, `Recurring pause until`, first-intro fields, etc.

## Read-only — never write

- `Name` (computed formula)
- `Record ID`, `Last Modified Date`

## Does not exist on MEMBERS — never write / never create

- `Last form source`
- `Country code`, `City code` (city lives on ALL CITIES as `City Code`; members store `City` text + `Timezone`)
- `Help wanted`, `Expertise offered` (context columns only)
- `Business name`, `Business website`
- `Primary industry`, `Annual revenue` (use `Industry`, `Revenue`)
- `90-day goal` (use `Current 90-day goal`)
- `utm_source` style keys (use `UTM Source`, …)
- `First attribution at` (use `First attribution captured at`)

## ALL CITIES / SLACK CHANNELS (reference)

- ALL CITIES: `City`, `City Code`, `Slack channels`, `intros`, `Form enabled`, …
- SLACK CHANNELS: `group size`, `Channel status/donut`, `Slack Channel ID`, …

Do **not** map new form fields into matching or Pinecone without an explicit ops change.
