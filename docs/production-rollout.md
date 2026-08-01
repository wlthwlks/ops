# Production rollout

1. Confirm MEMBERS single-select **Membership** includes option **`Pending Payment`**
2. Confirm COUNTRIES.`Active` and ALL CITIES.`Form enabled` checkboxes are set for live cities
3. `npm run db:migrate` if schema pending
4. Deploy API + rebuilt widgets (`npm run widgets:build`)
5. Preview: test Stripe → poll payment-status → Matching (no client Paid write)
6. Enable `NEW_SIGNUP_WIDGET_ENABLED` / update-details flags on preview
7. `MAKE_SHADOW_MODE=false` only when ready for real Airtable writes
8. Point Stripe webhook at this app for `invoice.paid` (always-on billing authority)
9. Staging Webflow embeds → production cutover
10. Monitor `/ops/webhook-errors` and Membership=`Pending Payment` until invoice.paid
