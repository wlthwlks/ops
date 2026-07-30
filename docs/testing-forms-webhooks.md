# Testing forms & webhooks

```bash
npm test
npm run widgets:build
npm run db:migrate
npm run forms:city-alias-dry-run   # report only, no writes

# E2E (requires `npm run build` then server, or running dev server):
npm run build && PLAYWRIGHT_SKIP_WEBSERVER= npm run test:e2e
# Or against already-running server:
PLAYWRIGHT_SKIP_WEBSERVER=1 npm run test:e2e
```

Dev Memberstack bypass (local only):

```text
ALLOW_MEMBERSTACK_TEST_AUTH=true
```

Headers: `X-Test-Memberstack-Id`, `X-Test-Memberstack-Email`, optional first/last name.

Stripe: use Stripe CLI `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.

Matching regression: `tests/lib/forms/matching-untouched.test.ts`.
