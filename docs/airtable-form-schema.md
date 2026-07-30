# Airtable form schema

Create these Members fields before enabling write flags (names overridable via env — see `MEMBER_FIELDS` in `airtable-fields.ts`):

- Memberstack ID
- First Name, Last Name
- Onboarding status, Profile schema version, Onboarding completed at
- Country code, City code, Availability codes (+ keep legacy Availability / City)
- Primary industry, Business stage, Annual revenue, Business description
- 90-day goal, Goal updated at
- Help wanted, Help wanted context
- Expertise offered, Expertise context
- Connection type
- Stripe Subscription ID, Cancel at period end, Cancellation requested/effective at
- utm_*, First attribution at, Initial landing page, Initial referrer
- Last form source

Do **not** map new fields into matching or Pinecone in this phase.
