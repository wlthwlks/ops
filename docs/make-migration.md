# Make migration

Keep Make live until shadow comparison succeeds.

Suggested disable order (manual):

1. Profile update scenario (after Update Details live)
2. New paid plan → Airtable create (after onboarding creates pre-payment)
3. Payment status scenario (after expanded Stripe webhooks validated)
4. Cancellation scenario (after subscription lifecycle validated)

Never disable all four at once. Keep rollback: re-enable Make + set write flags false.
