# Phase 2 — Matchmake Tracking: Engagement & Follow-up

> **Status: NEXT-TICKET BACKLOG.** Not in flight. Plan finalised, decisions
> locked, dependencies & operator steps documented. Pick up when ready.

## Resume context

Phase 1 (provisioning, write path, KPIs) shipped 2026-06-08.
Today (2026-06-09) the team is on the new WealthWalks Vercel org with the
fresh Neon DB; matchmake events are being recorded; the send pipeline emits
one CC'd email (with Reply-To bypassing donotreply) + a Slack group DM
(with `slack_message_ts` captured).

Start here when resuming:

- Schema lives at `src/db/schema/*.ts` (Drizzle pg-core).
- Recorder helpers at `src/lib/matchmake/record.ts`.
- KPI queries at `src/lib/matchmake/kpis.ts`.
- Send pipeline at `src/lib/ops/daily-match-message.ts` — calling
  `recordMatchEvent`, `recordSlackDelivery`, `recordEmailDelivery` already.
- Test harness: `tests/helpers/test-db.ts` with `{ matchmake: true }` opt-in.

Baseline before starting Phase 2: `npx vitest run` reports **93 passed** and
`npx tsc --noEmit` is clean.

---

## Goal (Phase 2 scope — BUILD NOW)

Track engagement on both delivery channels and surface it for reporting:

1. **Email engagement** — capture delivered / opened / clicked / bounced /
   complained / failed events from Resend webhooks. Update
   `email_deliveries.status` and emit raw events into a new `email_events`
   table.
2. **Slack replies** — capture every message landing in a matchmake group
   DM and FK it to the originating `match_event` via `slack_channel_id`.
   Stored in a new `slack_replies` table.
3. **Operator visibility (Cc)** — every introduction email also Ccs the
   oversight list (`SLACK_OVERSIGHT_EMAILS`) so admins can see exactly what
   was sent without appearing on the visible recipient line. **(landed
   alongside this ticket — see Closed Tickets at bottom)**
4. **Member identity for replies** — add `slack_user_id` to `members`,
   populated lazily during sends. Lets the Slack-reply webhook attribute
   replies to a known member email without an extra API call.

---

## Out of scope for Phase 2 (deferred to Phase 3)

- **Email reply capture** — Resend Inbound Email + DNS MX changes. Captures
  replies as webhooks. Skipped because:
  - Replacing `Reply-To: [all-humans]` with a parser-mailbox address
    defeats the whole "natural group thread" UX we built around CC.
  - Slack replies (Phase 2) give us full reply observability for free —
    the group DM IS the engagement channel.
  - Revisit only if email replies become a critical signal that Slack
    can't surface.
- **Slack emoji reactions** as engagement signals (✅, 👍, etc.). Reactions
  are a softer signal; can be added later via a `reaction_added` event
  subscription + new `slack_reactions` table.
- **Chasers** — scheduled follow-up emails after N days. Already designed
  in this doc historically but not built; still future work.
- **Meeting outcomes** — operator-marked "did they actually meet?".
  Future work.
- **Per-recipient email open tracking** — Resend's tracking pixel is per
  message, not per recipient. Splitting into N personalised emails would
  kill the reply-all thread (which is the Phase 2 UX rationale). Accept
  message-level "did anyone open" for now.

---

## Schema deltas

### New table: `email_events`

```ts
// src/db/schema/email-events.ts
id                  text PK (uuid)
email_delivery_id   text NULL  FK → email_deliveries.id (nullable because
                                webhooks can arrive before correlation)
resend_message_id   text NULL  (used to correlate late webhooks)
event_type          text NOT NULL
                    // 'sent' | 'delivered' | 'delivery_delayed'
                    // | 'opened' | 'clicked'
                    // | 'bounced' | 'complained' | 'failed'
occurred_at         timestamptz NOT NULL  // from webhook payload
received_at         timestamptz NOT NULL DEFAULT now()
payload             jsonb NOT NULL        // full raw webhook for forensics
```

Indexes: `(resend_message_id)`, `(email_delivery_id, occurred_at)`,
`(event_type, occurred_at)`.
**Unique** `(resend_message_id, event_type, occurred_at)` — makes Resend
retries idempotent.

### New table: `slack_replies`

```ts
// src/db/schema/slack-replies.ts
id                text PK (uuid)
match_event_id    text NOT NULL  FK → match_events.id ON DELETE CASCADE
slack_channel_id  text NOT NULL
slack_user_id     text NOT NULL
replier_email     text NULL   (resolved via members table when possible)
text              text NOT NULL
ts                text NOT NULL                 // Slack message timestamp
thread_ts         text NULL                     // parent thread if any
subtype           text NULL                     // bot_message, channel_join, etc.
received_at       timestamptz NOT NULL DEFAULT now()
```

Indexes: `(match_event_id, ts)`, `(slack_user_id)`,
**unique** `(slack_channel_id, ts)` — dedupes Slack's automatic retries.

### Column delta: `members`

Add `slack_user_id text NULL` with a non-unique index. Populated
lazily during sends (we already call `slack.lookupByEmail` per recipient —
cache the returned ID into `members.slack_user_id` on first hit). Cheap,
unlocks instant reply-attribution.

### Status enum delta: `email_deliveries.status`

Was: `'sent' | 'failed'`.
Now: `'sent' | 'failed' | 'delivered' | 'bounced' | 'complained'`.
The Resend webhook handler transitions status forward; never regresses.

---

## New env vars

| Var | Source | Where to add |
|---|---|---|
| `RESEND_WEBHOOK_SECRET` | Resend Dashboard → Webhooks → "Add Webhook" → signing secret | Vercel (all 3 envs) + local `.env` |
| `SLACK_SIGNING_SECRET` | api.slack.com → your app → Basic Information → Signing Secret | Vercel (all 3 envs) + local `.env` |

---

## Operator setup (cannot be automated)

### Resend webhook

1. <https://resend.com/webhooks> → **Add Webhook**.
2. URL: `https://wlth-wlks-ops.vercel.app/api/webhooks/resend`
3. Tick events: `email.sent`, `email.delivered`, `email.delivery_delayed`,
   `email.opened`, `email.clicked`, `email.bounced`, `email.complained`,
   `email.failed`.
4. Save. Copy the signing secret into `RESEND_WEBHOOK_SECRET` on Vercel.

### Slack Events API

1. <https://api.slack.com/apps> → select the bot app.
2. **Event Subscriptions** → toggle ON.
3. **Request URL**:
   `https://wlth-wlks-ops.vercel.app/api/slack/events`
4. **Subscribe to bot events**: `message.mpim`.
5. **OAuth & Permissions** → add bot scopes: `mpim:history`, `mpim:read`.
   We already have `mpim:write`, `users:read.email`, `chat:write`,
   `conversations:open`, `conversations:history`.
6. **Reinstall to Workspace** so new scopes take effect. Bot stays in
   existing DMs.
7. **Basic Information → App Credentials → Signing Secret** → paste into
   `SLACK_SIGNING_SECRET` on Vercel.

---

## Build list

- `src/db/schema/email-events.ts` (new)
- `src/db/schema/slack-replies.ts` (new)
- `src/db/schema/members.ts` → add `slack_user_id` column
- `src/db/schema/email-deliveries.ts` → status enum already string text
  (no migration delta beyond docs)
- `drizzle/0001_*.sql` — `drizzle-kit generate`
- `src/app/api/webhooks/resend/route.ts` (new) — verify with
  `resend.webhooks.verify`, insert `email_events`, update matching
  `email_deliveries.status` + `last_event_at`. **No `svix` install
  needed** — the `resend` package already exposes the verifier.
- `src/app/api/slack/events/route.ts` (new) — Node runtime, HMAC SHA256
  verification with Slack signing secret, URL-verification handshake,
  filter `message.mpim` only, skip `bot_message`/`bot_id`, insert
  `slack_replies`.
- `src/lib/integrations/slack.ts` → add `verifySlackRequest` helper.
- `src/lib/ops/daily-match-message.ts` → pass `tags: { match_event_id }`
  to `resend.sendEmail` for cheap webhook→event correlation.
- `src/lib/matchmake/record.ts` → `recordMatchEvent` cache the new joiner's
  Slack ID into `members.slack_user_id` if known.
- `tests/api/webhooks/resend.test.ts` — valid sig / invalid sig / late
  webhook / idempotency / each event type's status mapping / jsonb
  roundtrip.
- `tests/api/slack/events.test.ts` — url_verification handshake / valid
  sig / invalid sig / threaded vs non-threaded reply / bot_message
  filter / oversight-user reply (still recorded).
- `tests/helpers/test-db.ts` → extend the `{ matchmake: true }` branch
  with `email_events` and `slack_replies`.

---

## Acceptance criteria

- A Resend webhook with a valid signature against the production endpoint
  results in:
  - A new `email_events` row (one per event).
  - `email_deliveries.status` advances to `delivered` (or `bounced` /
    `complained` / `failed`) for the matched `resend_message_id`.
  - `last_event_at` set to the webhook's `occurred_at`.
- Replays of the same webhook do not duplicate rows (unique constraint
  enforces idempotency).
- A Slack message in a known matchmake group DM:
  - Lands as a `slack_replies` row FK'd to the right `match_event`.
  - Bot's own messages (matching `bot_message` subtype OR `bot_id`
    present) are not recorded.
  - URL verification challenge returns the `challenge` value.
- `members.slack_user_id` is populated on the next sync after a member
  is first matched.
- Every introduction email Ccs the `SLACK_OVERSIGHT_EMAILS` users.
- `npx vitest run` still green: ≥ 93 + new tests.
- `npx tsc --noEmit` clean.

---

## Open questions / decisions captured

1. **Backfill of pre-existing Slack replies on first deploy?**
   Decision: **forward only.** Don't paginate `conversations.history`
   on deploy. Engagement starts when the webhook is live.
2. **Slack emoji reactions** as engagement signals?
   Decision: **defer to Phase 3.** Replies only for Phase 2.
3. **Extend `email_deliveries.status` enum?**
   Decision: **yes.** Adds `delivered / bounced / complained`. Required
   for accurate "email success rate" KPI.
4. **`members.slack_user_id` lazy populate?**
   Decision: **yes (Option A) — confirmed 2026-06-09.** Add the column,
   populate during existing sends (we already call `slack.lookupByEmail`
   per recipient). On Slack reply, instant attribution to a known member
   email; dashboard shows the member's name, not a cryptic Slack ID.
5. **Oversight list shared between Slack and email channels?**
   Default: **shared.** Same `SLACK_OVERSIGHT_EMAILS` env var drives both
   the Slack group-DM oversight and the email Cc list. If you want
   separate lists later, split into `OVERSIGHT_EMAIL_Cc` env var.

---

## How to start this ticket

When picking this up:

1. Confirm operator has Resend Dashboard access and `wlthwlks.com` Slack
   workspace admin access — both needed for the manual setup steps above.
2. Add the two new env vars (`RESEND_WEBHOOK_SECRET`, `SLACK_SIGNING_SECRET`)
   to Vercel before deploying so the webhook routes don't 401 on cold start.
3. Build order that minimises risk:
   - **Step 1:** Schema migration (new tables, `members.slack_user_id`
     column, `email_deliveries.status` enum widening). One Drizzle
     migration, one DB change, no behavioural impact.
   - **Step 2:** Resend webhook route + tests. Deploy. Register the
     Resend webhook URL — engagement events start landing.
   - **Step 3:** Slack reply route + tests. Deploy. Add scopes, reinstall
     app, register the events URL — replies start landing.
   - **Step 4:** Wire `members.slack_user_id` lazy-populate into the
     existing `recordMatchEvent` member-upsert path.
   - **Step 5:** Surface the new signals in KPI cards (open rate, reply
     rate — see task #15).
4. Each step ships independently — no big-bang deploy.

## Phase 3 backlog (NOT in Phase 2 scope)

Captured here as the next ticket queue so they don't get lost:

- **3.1 — Email reply capture via Resend Inbound.** Adds MX record on
  `wlthwlks.com`, registers `email.received` webhook, parses replies.
  Per-event plus-addressed Reply-To (`replies+<eventid>@wlthwlks.com`)
  pattern for clean attribution. Skipped in Phase 2 because it breaks the
  reply-all-thread UX. Revisit only if Slack replies prove insufficient.
- **3.2 — Slack emoji reactions** as engagement signals. Subscribe to
  `reaction_added`. New `slack_reactions` table or
  `slack_replies.reactions jsonb`. Captures "liked but didn't reply".
- **3.3 — Chasers.** Scheduled follow-up emails after N days. Designed
  in the historical version of this doc. Triggered via the
  existing cron dispatcher.
- **3.4 — Meeting outcomes.** Operator-marked "did they actually meet?".
  Schema sketched in `meeting_outcomes`; UI in the delivery card.
- **3.5 — Self-serve "We met" link** in chaser emails. Signed token. Adds
  `SELF_REPORT_SIGNING_KEY` env.
- **3.6 — Slack reply tracking in 1:1 IM** (`message.im`) — currently
  only group DM (`message.mpim`) is captured.
- **3.7 — Per-recipient email open tracking.** Would require splitting
  CC into N personalised sends. UX tradeoff; only do if engagement
  attribution per person becomes important.

---

## Closed side tickets

These were captured during Phase 1 close-out + the Phase 2 prep on
2026-06-08 and are already merged to main:

- **A — Airtable test fix.** `tests/lib/integrations/airtable.test.ts:49`
  — mock now exposes `text()` so the 401 path no longer throws "res.text
  is not a function". Suite is fully green.
- **B — Slack `message_ts` capture.** `slack.postMessage` now returns
  `{ ts }`; `daily-match-message.ts` threads it into
  `recordSlackDelivery`; `match_events.slack_message_ts` is populated.
  Unblocks Phase 2 reply tracking.
- **C — Drizzle schema glob convention.** `drizzle.config.ts` uses
  `./src/db/schema/*.ts` (not the dir) so non-`.ts` files like
  `README.md` don't trip the kit's importer.
- **D — Email oversight BCC.** Every introduction email BCCs the
  `SLACK_OVERSIGHT_EMAILS` users (same list that powers Slack DM
  oversight). Oversight is invisible to matched members — not in To,
  Cc, or Reply-To headers — but still receives a copy and can choose
  to reply manually. `email_deliveries.recipient_role` accepts a new
  `oversight` value to distinguish those audit rows.
  *(Landed alongside this ticket refinement.)*
