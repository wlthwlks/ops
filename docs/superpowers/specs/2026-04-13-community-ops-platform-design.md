# Community Ops Platform — Design Spec

**Project:** wlth-wlks-ops
**Date:** 2026-04-13
**Status:** Approved

## Overview

Internal ops platform for a 1,000+ member community. Automates data flows between Airtable, Slack, Strapi, and other platforms. Used by a small ops team (2-5 people) including non-technical community managers.

## Tech Stack

- **Framework:** Next.js (App Router)
- **UI:** Ant Design
- **Runtime:** Node.js
- **Database:** SQLite (self-hosted) / Postgres (production)
- **Deployment:** Self-hosted (Docker) or Vercel

## Architecture

Single Next.js monolith. Each operation is a self-contained file with a standard interface. New ops are added by writing code — no plugin system or no-code layer.

### Project Structure

```
src/
  app/
    (dashboard)/          # Ant Design layout with sidebar
      ops/                # List all ops, status, logs
      ops/[slug]/         # Detail view for a single op
    api/
      ops/[slug]/run/     # POST — trigger an op manually
      cron/               # GET — endpoint hit by cron to run scheduled ops
      health/             # GET — health check
  lib/
    integrations/
      airtable.ts         # Airtable client with pagination & rate limiting
      slack.ts            # Slack Web API client
      strapi.ts           # Strapi REST client
    ops/
      sync-signups.ts     # Airtable → Slack channels → Strapi
      donut-tracker.ts    # Slack Donut channel → Strapi/Airtable
      member-export.ts    # Airtable → CSV download
    scheduler.ts          # Cron registry
    logger.ts             # Run history logging
    registry.ts           # Auto-discovers ops from lib/ops/
  db/
    schema.ts             # Op runs, logs
```

### Op Interface

Every op exports this shape:

```typescript
interface OpContext {
  log: (message: string) => void
  db: Database
}

interface OpResult {
  success: boolean
  summary: string
  recordsProcessed?: number
}

interface Op {
  slug: string
  name: string
  description: string
  schedule?: string          // cron expression
  run: (ctx: OpContext) => Promise<OpResult>
}
```

## Dashboard UI

- **Ops Overview:** Table with columns — Name, Status (idle/running/failed), Last Run, Next Run, Actions (Run Now)
- **Op Detail:** Run history table, log viewer, schedule info
- **Logs:** Global log viewer, filterable by op and status
- **No auth initially.** Internal tool. Basic auth can be added later.

## Integrations

### Airtable

- `airtable` npm package or direct REST API
- Built-in pagination handling
- Rate limiting: 5 req/sec with retry + exponential backoff
- Filter support: by date range, formula filters, field selection

### Slack

- `@slack/web-api` package
- Posting messages, reading channel history, managing channel members
- Token stored in env vars
- Rate limiting with retry

### Strapi

- REST client with auth token
- CRUD against content types
- Base URL + token in env vars

## Scheduling

### Self-hosted

`node-cron` runs in the Next.js server process. On startup, `scheduler.ts` reads all ops and registers those with a `schedule` field.

### Vercel

Single Vercel Cron entry hits `/api/cron` every 15 minutes. The endpoint checks each op's schedule against its last run time and executes any that are due.

```json
{
  "crons": [
    { "path": "/api/cron", "schedule": "*/15 * * * *" }
  ]
}
```

## Run History

Stored in database:

```
op_runs:
  id            - auto-increment
  op_slug       - string
  started_at    - timestamp
  finished_at   - timestamp
  status        - running | success | failed
  log           - text (stdout/error output)
  summary       - string (e.g., "Synced 12 new members")
```

Retention: 30 days, auto-pruned.

## Error Handling & Observability

- Each op runs in a try/catch wrapper
- Failures: status set to `failed`, error + stack trace saved to run log
- Slack webhook to `#ops-alerts` channel on failure (configurable per op)
- `/api/health` endpoint: app status, last successful run per op, any failed ops
- No external monitoring initially (Sentry can be added later)

## Credentials

All API keys/tokens as environment variables. `.env.example` documents required keys. App fails fast on startup if required keys are missing.

Required env vars:
- `AIRTABLE_API_KEY` — Airtable personal access token
- `AIRTABLE_BASE_ID` — Airtable base ID
- `SLACK_BOT_TOKEN` — Slack Bot OAuth token
- `SLACK_WEBHOOK_URL` — Alerts webhook (optional)
- `STRAPI_URL` — Strapi base URL
- `STRAPI_TOKEN` — Strapi API token
- `DATABASE_URL` — Database connection string (optional, defaults to SQLite)

## Initial Ops

1. **sync-signups** — Fetch new Airtable signups (by created date since last run) → add to Slack channels → update Strapi
2. **donut-tracker** — Read Donut channel history → extract pairing data → push to Strapi/Airtable
3. **member-export** — Export member list from Airtable to downloadable CSV (manual trigger)

## Testing Strategy

- Integration clients: mocked in unit tests
- Ops: integration tests verifying data transformation logic
- Scheduler + API routes: basic endpoint tests
- Target: 80% coverage
