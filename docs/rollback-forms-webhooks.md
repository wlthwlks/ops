# Rollback

1. Set all `NEW_*` flags to false
2. Set `MAKE_SHADOW_MODE=true` if needed
3. Re-enable Make scenarios
4. Revert Webflow embeds to Tally / prior forms
5. Keep `invoice.paid` path (always on) — do not remove Stripe endpoint

Database tables can remain; unused is fine.
