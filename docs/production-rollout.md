# Production rollout

1. `npm run db:migrate` (0004)
2. Add Airtable fields
3. Deploy with all NEW_* flags false
4. Configure MS + Stripe test webhooks
5. Staging Webflow embeds
6. MAKE_SHADOW_MODE=true for comparison
7. Controlled test accounts with writes on
8. Replace `/apply` then `/update-details`
9. Disable Make scenarios one at a time
10. Monitor `/ops/webhook-errors`
