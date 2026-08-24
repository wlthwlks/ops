# Unified Introduction Engine — Runbook

The unified introduction engine replaces both the legacy "Get Matched"
first-introduction flow and the Slack-based recurring-introductions flow
with a single, email-only, city-based system: Airtable members → eligibility
+ geo cache + semantic Pinecone profiles → configurable scoring → deterministic
city grouping → preview → freeze → durable delivery queue → Resend → verified
webhook tracking.

Slack plays no part in eligibility, matching, delivery or scheduling.
Legacy systems run untouched until the cutover steps below.

---

## 1. Files created

### Schema (`src/db/schema/`)
- `matching-profiles.ts`, `matching-profile-versions.ts`
- `city-introduction-settings.ts`
- `introduction-email-templates.ts`, `introduction-email-template-versions.ts`
- `introduction-config.ts`, `member-geo-cache.ts`, `introduction-member-profiles.ts`
- `introduction-pair-scores.ts`, `introduction-deliveries.ts`, `introduction-delivery-events.ts`

### Engine (`src/lib/introduction/`)
- `profiles.ts` (versioned matching profiles, normalized weights, constraints)
- `settings.ts` (city settings + global config + effective resolution)
- `member-eligibility.ts` (hard constraints; consumes `service-access.ts`)
- `pair-history.ts` (repeat history: new ledger + legacy match_events union)
- `geo-cache.ts` (cached Google geocoding, haversine)
- `semantic-profile.ts` (semantic-only embedding texts + hashes)
- `member-profile-sync.ts` (write-behind single-member sync for payment/profile-update hooks; pause deletion)
- `preplan-sync.ts` (blocking pre-match sync — previews and the city scheduler abort when it fails)
- `scoring.ts` (7 normalized 0–1 components + weighted combination)
- `grouping.ts` (deterministic seeded city grouping with locks)
- `plan.ts` (preview orchestration + plan edits)
- `freeze.ts` (plan hash, email snapshots, delivery jobs)
- `templates.ts` (email template versions, publish validation)
- `render-email.ts` (controlled placeholder rendering, escaping)
- `delivery-queue.ts` (claim/batch/retry worker)
- `delivery-webhook.ts` (Svix-verified, idempotent, out-of-order safe)
- `simulation.ts` (simulation reporting, delivery listing)
- `scheduler.ts` (monthly city scheduler + auto-approve)
- `api-errors.ts`

### Sync op + scripts
- `src/lib/ops/sync-intro-profiles.ts` (op `sync-intro-profiles`)
- `scripts/backfill-intro-embeddings.ts` (npm `intro:backfill-embeddings`; local env via `intro:backfill-embeddings:local` or `--env-file=.env.local`)

### API routes (`src/app/api/introductions/`)
- `config`, `profiles`, `profiles/[profileId]`, `profiles/[profileId]/versions`
- `cities`, `cities/[cityCode]`
- `preview`, `runs`, `runs/[runId]`, `runs/[runId]/approve`, `runs/[runId]/simulation`
- `deliveries`, `sync-profiles`
- `templates`, `templates/[templateId]`, `templates/[templateId]/versions`,
  `templates/[templateId]/publish`, `templates/[templateId]/restore`,
  `templates/preview`, `templates/[templateId]/test-send`
- Cron: `src/app/api/cron/intro-deliveries` (worker), `src/app/api/cron/intro-city-scheduler`
- Cron: `src/app/api/cron/pinecone-semantic-cleanup` (hourly self-healing `intro_v2` sync, env-gated `INTRO_PINECONE_CLEANUP_CRON_ENABLED`)
- Webhook: `src/app/api/webhooks/resend`

### Ops UI (`src/app/(dashboard)/introductions/`)
- `page.tsx` (Overview), `city-runs/page.tsx`, `settings/page.tsx`,
  `templates/page.tsx`, `deliveries/page.tsx`

## 2. Files modified

- `src/db/schema/index.ts`, `introduction-runs.ts`, `introduction-groups.ts`,
  `introduction-group-members.ts` (additive columns)
- `src/lib/integrations/pinecone.ts` (additive: namespaces, `fetchByIds`)
- `src/lib/integrations/resend.ts` (additive: `sendEmailToMany`, `sendBatch`)
- `src/lib/introduction/member-eligibility.ts` is new; `api-errors.ts` new
- `src/lib/ops/registered-operations.ts` (registered `sync-intro-profiles`)
- `src/app/(dashboard)/layout.tsx` (nav: "Introductions" + "Introductions (legacy)")
- `src/middleware.ts` (public `/api/webhooks/resend`)
- `src/app/api/cron/recurring-intros/route.ts` (additive `LEGACY_RECURRING_INTROS_ENABLED=false` gate)
- `vercel.json` (crons: `intro-deliveries` every 5 min, `intro-city-scheduler` hourly)
- `tests/helpers/test-db.ts`, `.env.example`, `package.json`

## 2b. Behavioural defaults

- Matching profile defaults: proximity 30, AI correlation 25,
  help/expertise 20, 90-day goal 10, connection type 5, industry 5,
  business stage 5 (weights are stored raw and auto-normalized to 100%).
- Group sizes: target 3, min 2, max 6, non-strict (per-city overridable).
- Repeat-pair window 60 days, member cooldown 14 days (profile default +
  per-city override, env vars as fallback).
- Same-city required by default.
- **Minimum eligible members (city gate)**: cities need at least
  `minEligibleMembers` eligible members to run (profile default 0 = off,
  per-city override). Below the minimum, the preview creates a blocked run
  (visible in City Runs) and scheduled cities skip the month.
- **Unknown postcode is allowed by default**: members with a missing or
  ungeocodable postcode stay eligible (proximity scores 0 for them, the
  max-distance check is skipped). Set `allowUnknownPostcode=false` on a
  profile version or per city to enforce strict postcodes.
- Meetup time: per-city `meetup_time` (HH:mm) feeds the
  `{{meetup_suggestion}}` email placeholder (second Wednesday of the cycle
  month, e.g. "January 14th at 10 am"); defaults to `10:00`.
- Email placeholders: `{{first_name}}`, `{{city}}`, `{{introduction_date}}`,
  `{{members}}`, `{{why_you_matched}}`, `{{coordination_text}}` (optional),
  `{{meetup_suggestion}}`, `{{group_size_word}}`. Publishing requires
  `{{members}}` only.
- Member email cards include name, headline, city/industry/stage,
  phone number, social media, website (safe links) and help/expertise.
- City list synchronization: the city list comes from Airtable ALL CITIES
  (city code = Airtable record id — no "City Code" field needed). The
  cities endpoints sync on read (5-minute TTL), the scheduler syncs hourly,
  previews auto-create rows, and Matching Settings has a manual
  "Sync cities from Airtable" button. Sync only adds cities and refreshes
  names — admin configuration is never overwritten, and stale rows are
  reported but kept.

## 3. DB migrations

- `drizzle/0007_unified_introductions.sql` — 11 new tables + additive columns on
  runs/groups/group_members (generated via drizzle-kit; re-emitted
  `signup_member_creations` statements pruned because the 0006 snapshot was
  missing — do not re-add them).
- `drizzle/0008_auto_approve_delivery_mode.sql` — one new column.

Apply with `npm run db:migrate:preview` then `npm run db:migrate:prod`
(custom migrator, hash-ledger in `public.__drizzle_migrations` /
`drizzle.__drizzle_migrations`; requires `POSTGRES_URL_NON_POOLING`).
Migrations are additive only — nothing destructive.

## 4. Environment variables

New:
- `RESEND_WEBHOOK_SECRET` (required for delivery-event tracking)
- `INTRO_SENDER_EMAIL` (default `WLTH WLKS <noreply@wlthwlks.com>`)
- `INTRO_DELIVERY_WORKER_BATCH_SIZE` (default 20 groups/tick)
- `INTRO_SEMANTIC_NAMESPACE` (default `intro_v2`)
- `LEGACY_RECURRING_INTROS_ENABLED` (set `false` at cutover)

Reused: `POSTGRES_URL`, `AIRTABLE_GET_DATA_TOKEN`, `AIRTABLE_BASE_ID`,
`PINECONE_API_KEY`, `PINECONE_INDEX_NAME`, `OPENAI_API_KEY`,
`GOOGLE_MAPS_API_KEY`, `RESEND_API_KEY`, `CRON_SECRET`,
`INTRODUCTIONS_MODE`, `INTRO_PAIR_COOLDOWN_DAYS`,
`INTRO_MEMBER_COOLDOWN_DAYS` (fallback defaults only).

## 5. Manual Resend / DNS steps

1. In Resend, verify the `wlthwlks.com` domain and publish DKIM/SPF records
   for `noreply@wlthwlks.com`.
2. Resend → Webhooks → Add endpoint: `https://<prod-domain>/api/webhooks/resend`,
   events: sent, delivered, delivery_delayed, bounced, complained, failed,
   suppressed, opened, clicked. Copy the signing secret.
3. Set `RESEND_WEBHOOK_SECRET` in Vercel.
4. Verify: freeze a provider-test plan, let the worker send, confirm
   `delivered` events appear in Delivery History.

## 6. Migration / backfill commands

```bash
npm run db:migrate:preview          # preview DB
npm run db:migrate:prod             # production (after review)
npx tsx scripts/backfill-intro-embeddings.ts --dry-run        # .env (default)
npm run intro:backfill-embeddings   # all cities (idempotent, hash-skipped)
npx tsx scripts/backfill-intro-embeddings.ts --city=London
npm run intro:backfill-embeddings:local                       # .env.local (e.g. preview)
npx tsx scripts/backfill-intro-embeddings.ts --env-file=.env.local --dry-run
```

Repeat-pair avoidance already includes legacy data: the new ledger (with the
previously imported Airtable match-group history via
`npm run airtable:import-history`) plus `match_events`/`match_event_matches`.

## 7. Preview / simulation procedure

1. Ops → Introductions → City Runs → "Preview a city" (city, cycle date,
   delivery mode). Previews **never** send email and write only the plan.
2. Review the simulation report (eligible/matched/unmatched/duplicates/
   invalid emails/queue sizes) and each group's score breakdown.
3. Edit: remove members, replace via alternatives, lock groups, regenerate a
   group or the whole city. All edits are deterministic and rejected once a
   plan is frozen.
4. "Approve & freeze": choose delivery mode —
   - **Simulation** — delivery jobs exist but the worker never sends them.
   - **Provider test / Canary** — redirected to internal addresses; original
     recipients preserved in `original_to_json` and shown in the UI.
   - **Production** — requires `INTRODUCTIONS_MODE=live` **and** typing
     `SEND` in the confirmation field.
5. The 5-minute worker (`/api/cron/intro-deliveries`) claims groups in small
   chunks; never send more than the batch size per tick. Delivery History
   shows per-recipient status and provider events.

## 8. Production rollout procedure

1. Apply migrations (preview → prod), set env vars, verify webhook (step 5).
2. Backfill embeddings; run `sync-intro-profiles` in preview mode first.
3. Pilot: enable 1–2 small cities; build previews; approve in **canary**
   then **provider_test**; verify webhooks in Delivery History.
4. Approve pilot cities in production (live mode + typed confirmation).
5. Configure matching profiles, per-city settings (monthly schedule,
   timezone, auto-approve mode) and email templates; publish the template.
6. Monitor one full monthly cycle.
7. Enable remaining cities. For scheduled cities, the hourly scheduler builds
   previews; set `auto_approve` + `auto_approve_delivery_mode` per city once
   confident. Production auto-approval only ever happens in live mode.
8. Cutover: set `LEGACY_RECURRING_INTROS_ENABLED=false` (legacy recurring
   cron short-circuits). Stop creating sends through `/get-matched`.
9. After ≥ 2 clean cycles, retire the legacy routes/UI
   (`/get-matched`, `/recurring-intros`, `/api/send-match-intros`,
   `/api/recurring-intros/*`, `/api/get-matched`, `/api/batch-match`,
   `daily-match-message` op, `donut-tracker` op) and remove the
   `/api/cron/recurring-intros` vercel.json entry. Keep the legacy tables
   (`match_events`, `email_deliveries`) for history/repeat avoidance.

## 9. Rollback procedure

1. `INTRODUCTIONS_MODE=read_only` — worker and scheduler stop all sends.
2. Disable cities (Ops → Matching Settings → per-city `enabled` off) or set
   `auto_approve` off.
3. Re-enable the legacy system: `LEGACY_RECURRING_INTROS_ENABLED=true` (or
   unset) and confirm `/api/cron/recurring-intros` is still in `vercel.json`.
4. Data changes are additive — no destructive migration exists, so no data
   rollback is required.

## 9b. Pause management

Two independent pause concepts exist and both block introductions:

**Intro pause** (Airtable `Recurring intro status` = `Paused` +
`Recurring pause until`; shared logic in `src/lib/introduction/pause-state.ts`):

- Managed from the ops dashboard: Member Directory → open a member → the
  Introductions section has Pause (optional resume date; blank = indefinite)
  and Resume buttons (`POST /api/ops-dashboard/members/pause`, live-mode
  admin only).
- `Paused` blocks introductions until the resume date (fail-closed when the
  date is missing). The nightly `/api/cron/intro-pause-expiry` cron
  (env-gated: `PAUSE_EXPIRY_CRON_ENABLED=true`) auto-switches expired pauses
  back to `Active`; missing-date rows are never auto-resumed and are flagged
  in the ops directory (`PAUSED_WITH_MISSING_DATE`).
- Billing reactivation (Reactivate button / confirm-checkout) clears an intro
  pause automatically; `Excluded` is never touched. `invoice.paid` renewals
  do NOT clear an ops-set pause.

**Billing pause** (Stripe pause collection, controlled from the Stripe
dashboard):

- Stripe pause collection does NOT change the subscription status (it stays
  `active`) — the pause is visible as `pause_collection` on the subscription.
  `customer.subscription.updated` webhooks are handled in the ALWAYS-ON path
  (independent of `NEW_STRIPE_WEBHOOKS_ENABLED` / `MAKE_SHADOW_MODE`) via
  `src/lib/billing/pause-sync.ts`; the dedicated `paused`/`resumed` events are
  not required.
- On pause the member becomes inactive in Airtable immediately:
  `Stripe subscription status` = "paused" (our marker column), `Billing pause
  until` = resume date (blank = indefinite), `Service access until` = now,
  `Membership` = "Paused". Payment stays "Paid" — pausing is not a payment
  failure.
- On resume (pause_collection cleared, status `paused → active`, or the
  `resumed` event): status restored, `Billing pause until` cleared,
  `Membership` = "Active", and `Service access until` restored from the
  Stripe period end when it is still in the future. A period that lapsed
  during a long pause is left to the resume charge's `invoice.paid`.
- The Reactivate API reports `billing_paused` (resume date or indefinitely)
  instead of creating a second subscription.
- Ops visibility: `STRIPE_SUBSCRIPTION_PAUSED` issue, `billingPaused` /
  `paused` / `pauseExpired` filters and quick views in the member directory.
- Missed webhooks can be repaired with
  `npm run billing:backfill-pauses` (Stripe→Airtable pause backfill) and
  `npm run billing:backfill-pauses -- --reconcile-resumes` (detects members
  whose subscription is no longer paused).
- When pausing in Stripe, use pause-collection behaviour `void`; leave the
  resume date blank for an indefinite pause.

## 10. Tests run and results

`npm test` (vitest, PGlite): **1090+ tests pass** including, for the engine:

- eligibility/service access, pause/excluded states, same-city constraints,
  geographic distance, missing/invalid postcodes
- scoring normalization, configurable weights, zero-weight dimensions,
  help/expertise complementarity, deterministic scoring
- recent-pair avoidance (ledger + legacy union), duplicate member prevention,
  group size balancing, seeded determinism, locked-group rebuilds
- frozen-plan immutability, delivery-key idempotency, retry backoff/permanent
  classes, batch behaviour, stale-claim recovery, read-only safety
- simulation never calling real delivery, canary redirection with original
  recipient audit, template rendering/escaping/publish validation
- webhook idempotency + out-of-order events, Svix verification, auth gates
- monthly scheduler: next-run computation (timezone-aware), due-city
  selection, duplicate-cycle skip, auto-approve mode rules, schedule advance

`npm run lint` and `npx tsc --noEmit` are clean for all engine files
(pre-existing warnings/errors in untouched files remain). `npm run build`
succeeds with the new `/introductions/*` pages and routes.
