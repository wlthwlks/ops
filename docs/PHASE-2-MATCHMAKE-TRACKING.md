# Phase 2 — Matchmake Tracking: Engagement & Follow-up

## Resume context

Phase 1 (provisioning + write path + KPIs) shipped 2026-06-08. Drizzle is now
Postgres-on-Neon, the send pipeline writes to `members`, `match_events`,
`match_event_matches`, and `email_deliveries`, and the `/get-matched` page
shows live KPI cards at the top.

Start here when resuming:

- Schema lives at `src/db/schema/*.ts` (Drizzle pg-core).
- Recorder helpers at `src/lib/matchmake/record.ts`.
- KPI queries at `src/lib/matchmake/kpis.ts`.
- Send pipeline at `src/lib/ops/daily-match-message.ts` — already calling the
  three recorder helpers in try/catch.
- Test harness: `tests/helpers/test-db.ts` with `{ matchmake: true }` opt-in
  spins up PGlite with all the Phase 1 tables.

Baseline before starting Phase 2: `npx vitest run` should report **86 passing
/ 1 pre-existing failure (87 total)**. The 1 failing test
(`tests/lib/integrations/airtable.test.ts`) is unrelated; see Side ticket A.

---

## Goal

Make every match-make event observable beyond "we sent it." Specifically:

1. Capture email engagement (delivered / opened / clicked / bounced / complained)
   from Resend webhooks.
2. Send scheduled follow-up emails ("chasers") and record their delivery.
3. Let an operator (or recipient) mark whether a match group actually met.

---

## Out of scope

- Reporting UI beyond the existing KPI cards. (That's Phase 3.)
- Slack reply tracking. Slack `message_ts` is captured-but-null because the
  current wrapper doesn't surface it; deferred to Side ticket B.
- Multi-tenant / per-team scoping. Still single-tenant.
- Re-sending failed emails automatically. Manual retry only.

---

## Work breakdown

### 2.1 — Resend webhook → `email_events`

**Tables already migrated**: none. Add `email_events` from the schema
designer's original Phase 2 design:

```ts
// src/db/schema/email-events.ts
id                  text PK (uuid)
email_delivery_id   text NULL  FK → email_deliveries.id (nullable because
                                webhooks can arrive before correlation)
resend_message_id   text NULL   (used to correlate late webhooks)
event_type          text NOT NULL  // 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained' | 'delivery_delayed' | 'failed'
occurred_at         timestamptz NOT NULL  // from webhook payload
received_at         timestamptz NOT NULL DEFAULT now()
payload             jsonb NOT NULL  // raw webhook for forensics
```

Indexes: `(resend_message_id)`, `(email_delivery_id, occurred_at)`,
`(event_type, occurred_at)`.

**New route**: `src/app/api/webhooks/resend/route.ts`

- `POST` handler, `dynamic = "force-dynamic"`.
- Verify the webhook signature with Resend's signing secret
  (`RESEND_WEBHOOK_SECRET` env var — add to Vercel + Neon docs).
  Resend uses Svix-style headers (`svix-id`, `svix-timestamp`, `svix-signature`).
- Insert into `email_events` (always — append-only audit).
- Look up matching `email_deliveries` row via `resend_message_id`. If found,
  update its `status` (map event_type → status: `delivered` → `delivered`,
  `bounced`/`complained` → `bounced`/`complained`, `opened`/`clicked` →
  leave status alone but bump `last_event_at`).

**Vercel/Resend wiring**:
- Add the webhook in Resend Dashboard → Webhooks → point at
  `https://<production-domain>/api/webhooks/resend`.
- Subscribe to events: `email.delivered`, `email.bounced`, `email.complained`,
  `email.opened`, `email.clicked`, `email.failed`, `email.delivery_delayed`.
- Save the signing secret as `RESEND_WEBHOOK_SECRET` env var (Production,
  Preview, Development).

**Tests** (new file `tests/api/resend-webhook.test.ts`):
1. Valid signature → 200, event inserted, delivery updated.
2. Invalid signature → 401, nothing written.
3. Late webhook (no matching delivery yet) → still inserts the event row with
   `email_delivery_id = NULL`; reconciler picks it up later (see 2.1.b).
4. Idempotency: same webhook delivered twice (Resend retries) → only one
   `email_events` row. Use `(resend_message_id, event_type, occurred_at)`
   uniqueness OR check Resend's `id` field if present.
5. Update happens for all five event types.
6. `payload jsonb` round-trips.

**2.1.b — Late-correlation reconciler** (optional but cheap):

A nightly cron that finds `email_events` rows with `email_delivery_id IS NULL`
and tries to correlate them by `resend_message_id`. One Drizzle UPDATE. Add
to `vercel.json` cron schedule.

---

### 2.2 — Chasers (scheduled follow-up emails)

**Table** `chasers`:

```ts
// src/db/schema/chasers.ts
id              text PK
match_event_id  text NOT NULL  FK → match_events.id ON DELETE CASCADE
sequence        integer NOT NULL  // 1, 2, 3…
scheduled_for   timestamptz NOT NULL
sent_at         timestamptz NULL
cancelled_at    timestamptz NULL
template_key    text NOT NULL  // 'day-3-checkin' | 'week-1-recap' etc.
```

Indexes: `(scheduled_for) WHERE sent_at IS NULL AND cancelled_at IS NULL`
(partial; safe in Postgres).

**Scheduler**: extend the existing `/api/cron` dispatcher. Add a new op
`chaser-dispatch` (registered in `src/lib/registry-instance.ts` or wherever
ops register). Op runs every hour, finds chasers due (`scheduled_for <= now()`
AND `sent_at IS NULL` AND `cancelled_at IS NULL`), generates the email per
`template_key`, sends via Resend, and writes a corresponding
`email_deliveries` row with `chaser_id` set.

**Templates**: factor out a small `src/lib/messaging/chaser-templates.ts` —
map `template_key` to a renderer that gets the parent `match_event` and its
matches as input. Mirror the `generate-match-message.ts` style.

**UI**: in the existing delivery card on `/get-matched`, add a "Schedule
chaser" select + button (one of: 3-day check-in / 7-day recap / 14-day
nudge). Posts to `/api/matchmake/schedule-chaser` → inserts a `chasers` row.

**Tests**:
- Dispatcher finds + sends due chasers.
- Cancelled chasers are skipped.
- Already-sent chasers (`sent_at` set) are skipped — idempotent re-runs.
- `email_deliveries.chaser_id` correctly populated.
- Template rendering snapshot tests for each `template_key`.

---

### 2.3 — Meeting outcome ("did they actually meet?")

**Table** `meeting_outcomes`:

```ts
// src/db/schema/meeting-outcomes.ts
id                      text PK
match_event_id          text NOT NULL  FK → match_events.id ON DELETE CASCADE
match_event_match_id    text NULL      FK → match_event_matches.id  // null = "the group met" without specifying who
met                     boolean NOT NULL
met_at                  timestamptz NULL  // when they met IRL
reported_at             timestamptz NOT NULL DEFAULT now()
reported_by             text NULL  // operator email OR 'self' for recipient self-report
notes                   text NULL
```

UNIQUE `(match_event_id, match_event_match_id)` — one outcome per pair.

**UI**: on the same delivery card, add a small "Did they meet?" Yes/No/Unknown
toggle plus an optional notes field. Mutates via `/api/matchmake/outcome`.

**Self-serve link (optional, stretch)**: include a one-click "We met!" link
in the chaser email containing a signed token. Hits `/api/matchmake/outcome/self?token=…`
to write a `reported_by = 'self'` row.

**KPI follow-up**: surface meeting rate per city on the KPI card row,
either as a 5th card or replacing one. Adds:

```sql
SELECT
  count(*) FILTER (WHERE met = true) * 100.0 / NULLIF(count(*), 0)
FROM meeting_outcomes o
JOIN match_events e ON e.id = o.match_event_id
WHERE e.created_at >= now() - interval '30 days';
```

**Tests**:
- Recording an outcome inserts one row.
- Re-recording for the same `(match_event_id, match_event_match_id)` updates,
  doesn't insert.
- Outcome roll-up matches manual sum.

---

## Migration plan

Single Drizzle migration: `npx drizzle-kit generate && npx drizzle-kit migrate`
after dropping all three new schema files in `src/db/schema/`. Then update
`src/db/schema/index.ts` to re-export them.

The existing test helper (`tests/helpers/test-db.ts`) needs three new
`CREATE TABLE` statements under the `{ matchmake: true }` branch — extend it,
don't fork.

---

## Acceptance criteria

- A Resend webhook into the production endpoint with a valid signature
  results in a new `email_events` row AND a status update on the matching
  `email_deliveries` row within 30 seconds.
- A chaser scheduled for "1 minute from now" via the UI gets sent by the
  next hourly dispatcher run AND lands in `email_deliveries.chaser_id =
  <chaser id>`.
- An operator clicking "We met" on a delivery card persists a
  `meeting_outcomes` row; refreshing the page shows that state.
- `npx vitest run` reports at least **86 + new tests passing**, 1 pre-existing
  failure unchanged.
- `npx tsc --noEmit` clean.

---

## Open questions to resolve when starting

1. Webhook signature library — Resend uses Svix under the hood. Their official
   verification snippet uses `svix` npm package. Confirm latest pattern in
   Resend docs at start.
2. Chaser cadence defaults — 3 / 7 / 14 days? Or single 7-day check-in only
   for v1? Recommend starting with one template + scaling out.
3. Self-serve "We met" link — included in v1 or deferred to v2.1? Token signing
   requires a `SELF_REPORT_SIGNING_KEY` env var; minor extra setup.
4. Privacy: do we surface "Bob hasn't responded to your matches" anywhere?
   Out of scope for v1; mention only if a stakeholder asks.

---

## Side tickets

All three side tickets that originally lived here (A — airtable test, B —
Slack `message_ts`, C — schema glob pattern) were resolved during the
Phase 1 close-out on 2026-06-08. Kept here as historical reference only.
