This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Services

This app integrates with the following third-party services. Each row lists the
env var(s) it reads, what the service is used for, and where to log in to manage
it.

After logging in at each link below, switch to the **wlth-wlks team / workspace**
to find the account this app uses. (Workspace-specific IDs and tokens are not
listed here because this repo is public — see `.env` locally for those.)

### Hosting, source control & auth

| Service | Used for | Account URL | Env vars |
|---|---|---|---|
| **Vercel** | Production hosting, preview deploys, env vars | https://vercel.com/dashboard | — |
| **GitHub** | Source repo, auto-deploy trigger | https://github.com/wlthwlks/ops | — |
| **Clerk** | Dashboard auth (`@clerk/nextjs`) | https://dashboard.clerk.com | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` |

### Data & storage

| Service | Used for | Account URL | Env vars |
|---|---|---|---|
| **Neon (Postgres)** | Match-event tracking, KPIs (`@neondatabase/serverless` + drizzle) | https://console.neon.tech/app/projects | `POSTGRES_URL` |
| **Airtable** | Members source of truth (Active/Paid roster, city, profile fields) | https://airtable.com/workspaces | `AIRTABLE_BASE_ID`, `AIRTABLE_GET_DATA_TOKEN` (manage tokens: https://airtable.com/create/tokens) |
| **Pinecone** | Vector index for member-to-member matching | https://app.pinecone.io/organizations | `PINECONE_API_KEY`, `PINECONE_INDEX_NAME` |
| **Strapi** | CMS for editorial content (self-hosted) | Whatever `STRAPI_URL` points to — `http://localhost:1337/admin` in local dev | `STRAPI_URL`, `STRAPI_TOKEN` |

### AI & matching

| Service | Used for | Account URL | Env vars |
|---|---|---|---|
| **OpenAI** | Embeddings for member profiles (powers Pinecone search) | https://platform.openai.com/api-keys | `OPENAI_API_KEY` |
| **Google Maps Platform** | Geocoding postcodes → lat/lng for nearby matching (`src/lib/geo/`) | https://console.cloud.google.com/google/maps-apis/credentials | `GOOGLE_MAPS_API_KEY` |

### Messaging & delivery

| Service | Used for | Account URL | Env vars |
|---|---|---|---|
| **Resend** | Transactional email (match intro emails, oversight BCC) | https://resend.com/overview · API keys: https://resend.com/api-keys | `RESEND_API_KEY`, `RESEND_FROM_EMAIL` |
| **Slack** (workspace) | Posting daily match cards into the donut channel; sending workspace invites | Workspace sign-in: https://slack.com/signin · Bot/app config: https://api.slack.com/apps | `SLACK_BOT_TOKEN`, `SLACK_JOIN_URL`, `SLACK_WORKSPACE_INVITE_URL`, `SLACK_DONUT_CHANNEL`, `SLACK_OVERSIGHT_EMAILS`, `SLACK_WEBHOOK_URL` (optional) |

### Ops tools (manual Slack Admin fallback)

| Tool | Used for | Where |
|---|---|---|
| **Slack Admin** | Manual workspace deactivation when bot cannot deactivate users | Open from Slack Community → Remove inactive. Ordinary bot tokens cannot deactivate workspace users. |

Legacy `/remove-members` redirects to `/members/slack-access?tab=remove`. No extension license keys are stored in this repository.

### Where each integration lives in code

- `src/lib/integrations/airtable.ts` — Airtable REST client
- `src/lib/integrations/pinecone.ts` — Pinecone vector index
- `src/lib/integrations/openai-embeddings.ts` — OpenAI embeddings
- `src/lib/integrations/resend.ts` — Resend email client (supports `cc` / `bcc` / `replyTo`)
- `src/lib/integrations/slack.ts` — Slack Web API client
- `src/lib/integrations/strapi.ts` — Strapi CMS client
- `src/lib/geo/geocode.ts`, `src/lib/geo/nearby.ts` — Google Maps geocoding + nearest-neighbour math
- `src/db/` + `drizzle/` — Neon Postgres schema and migrations

## Recurring City Introductions

A weekly (or channel-configurable) workflow that replaces Donut for in-person Slack channels. Airtable is the operational configuration source; Postgres is the authoritative delivery ledger.

### Architecture

Two separate matching strategies coexist but share the same ledger for history, cooldowns, and reservations:

| Strategy | Matching engine | Data source | UI |
|---|---|---|---|
| **Onboarding (first-time)** | Pinecone vector similarity | Airtable Members + Pinecone index | `/get-matched` |
| **Recurring (city intros)** | Fairness scoring (no Pinecone) | Airtable Slack channels config + Slack API | `/recurring-intros` |

Both systems write to the shared Postgres `introduction_*` tables and Airtable `Match groups` for reporting.

### Database tables (Postgres ledger)

| Table | Purpose |
|---|---|
| `introduction_runs` | Top-level run: source (onboarding/recurring), cycle date, mode, plan hash, status |
| `introduction_groups` | Per-group tracking: fingerprint, delivery key, status, Slack IDs, error fields |
| `introduction_group_members` | Group participants: role, email snapshot, Airtable record ID |
| `introduction_reservations` | Temporary member reservations preventing cross-system conflicts |

See `src/lib/introduction/` for shared helpers: reservations, history, service access, quality scoring.

### Airtable tables used

| Table | Purpose | Key fields |
|---|---|---|
| `Slack channels` | Per-city configuration | `Slack Channel ID`, `Intro type`, `group size`, `Intro frequency weeks`, `Next introduction date`, `Intro local time`, `Timezone`, `Intro message template` |
| `Members` | Eligible participants | `Name`, `email`, `Slack Email`, `Payment`, `Membership`, `City`, `Recurring intro status`, `Recurring pause until`, `First introduction status`, `Service access until` |
| `Match groups` | Historical record for reporting | `Source`, `Cycle ID`, `Member 1`, `Introduction date`, `Status`, `Slack Conversation ID` |
| `Introduction data` | Per-cycle city summary | `Cities`, `Intro date`, `in channel`, `introduced`, `excluded`, `intros made`, `Cycle ID` |

### New Airtable Member fields

| Field | Type | Values |
|---|---|---|
| `First introduction status` | Single select | Pending, Sent, Grandfathered, Failed |
| `First introduction sent at` | Date | ISO date when first intro was sent |
| `Recurring eligible from` | Date | Date when member becomes eligible for recurring intros |
| `Service access until` | Date | Overrides cancellation: member stays eligible until this date |
| `Recurring intro status` | Single select | Active, Paused, Excluded (blank = Active) |
| `Recurring pause until` | Date | First date member may be matched again after pause |

### Slack scopes required

- `users:read` — list workspace users
- `users:read.email` — resolve Slack user emails from Airtable
- `groups:read` — read members of private city channels
- `groups:write` / `channels:manage` — add members to private city channels (`conversations.invite`)
- `channels:read` — read members of public channels
- `channels:write` / `groups:write` — remove members from channels (`conversations.kick`)
- `mpim:write`, `mpim:read` — open and write to group DMs
- `chat:write` — post introduction messages
- `app_mentions:read` — optional, for future reply handling
- `admin.users:write` (via `SLACK_ADMIN_USER_TOKEN`, Enterprise Grid only) — workspace invite (`admin.users.invite`) and account deactivation (`admin.users.setInactive`)

### Introductions runtime modes

One server-side variable controls all introductions side effects:

```env
INTRODUCTIONS_MODE=read_only
```

| Value | Behaviour |
|---|---|
| `read_only` (default if missing) | Real Airtable/Slack/Postgres **reads** only. No writes, no Slack/email delivery, no reservations, no plan persistence. Cron is diagnostic only. |
| `live` | Real data + real writes + real Slack/email delivery. Cron processes due channels and can send. |

Unsupported values fail closed with a configuration error (no writes).

**Remove these legacy variables from Vercel** (no longer used at runtime):

```text
RECURRING_INTROS_SEND_ENABLED
RECURRING_INTROS_AUTOMATION_MODE
RECURRING_INTROS_SLACK_MODE
RECURRING_INTROS_AIRTABLE_WRITES_ENABLED
NEXT_PUBLIC_RECURRING_INTROS_SEND_ENABLED
```

### Environment variables

| Var | Default | Description |
|---|---|---|
| `INTRODUCTIONS_MODE` | `read_only` | `read_only` or `live` — sole runtime mode switch |
| `RECURRING_INTROS_ALLOWED_CHANNEL_IDS` | — | Comma-separated Slack channel IDs allowlist; empty = all (safety, not a mode) |
| `RECURRING_INTROS_PLAN_TTL_MINUTES` | `30` | Preview plan expiration in minutes |
| `INTRO_MEMBER_COOLDOWN_DAYS` | `14` | Days before a member can re-appear in recurring intros |
| `INTRO_PAIR_COOLDOWN_DAYS` | `60` | Days before a pair can be reintroduced |
| `INTRO_ONBOARDING_TO_RECURRING_DAYS` | `14` | Days after first introduction before recurring eligibility |
| `CRON_SECRET` | required | Bearer token for cron endpoint auth |

### Operations dashboard (navigation)

Grouped sidebar (routes kept stable for bookmarks):

| Section | Label | Route |
|---|---|---|
| Overview | Operations Overview | `/overview` |
| Member Management | Member Directory | `/members` |
| | Data Issues | `/members/issues` |
| | Slack Community | `/members/slack-access` |
| | Billing Integrity | `/members/billing` |
| | New Members | `/get-daily-new-customers-for-cities` |
| | Cancellations | `/remove-members` |
| Communities | City Growth | `/growing-cities` |
| Introductions | Custom Matching | `/get-matched` |
| | Recurring Introductions | `/recurring-intros` |
| System | Operations | `/ops` |
| | Docs & Access | `/docs` |

Root `/` redirects to `/overview`.

**Slack Community** lives under `/members/slack-access` — a 3-tab tool for the community workspace (Slack is community-only, not a core business system):

1. **Link Slack emails** — members with an empty `Slack Email` field, each with a suggested Slack profile; a side-by-side Compare modal, then write `Slack Email` to Airtable.
2. **Remove inactive** — expired-access members no longer in the community (paused members excluded), removed from WLTH channels with one click (+ workspace deactivation when an admin token is available).
3. **Invite to Slack** — current-access members not in the workspace get a joining email; once they join, they are added to their private city channel.

All three lists are ordered by `Date joined` latest → oldest, with search/city/membership/payment/date filters.

#### Runtime mode (dashboard + introductions)

`INTRODUCTIONS_MODE` remains the server-side mode (`read_only` default, `live` for writes/delivery).

- Dashboard **reads/scans** work in both modes.
- Manual dashboard mutations (Slack Email write, outreach email send, ops that write) require **`live` + admin role**.
- Stripe `invoice.paid` webhook is **independent** of dashboard mode and **never creates** Airtable Members.
- There is **no** browser mode toggle and **no** “Create Airtable member from Stripe” button.

#### Authorisation

```env
OPS_ADMIN_USER_IDS=user_xxx,user_yyy
OPS_VIEWER_USER_IDS=user_aaa
```

- **Viewer** — dashboards and scans only.
- **Admin** — mutations only when mode is `live`.
- Unknown authenticated users fail closed in production.
- Local/dev: if both allowlists are empty, authenticated users are treated as admin.

#### Slack community

```env
SLACK_WORKSPACE_INVITE_URL=
SLACK_JOIN_URL=                 # fallback invite URL
SLACK_WORKSPACE_URL=            # for channel deep links
SLACK_ALL_MEMBERS_CHANNEL_ID=
SLACK_ALL_MEMBERS_CHANNEL_NAME=all-wlth-wlks
SLACK_OUTREACH_COOLDOWN_DAYS=7
SLACK_ADMIN_USER_TOKEN=         # optional: Enterprise Grid admin token (admin.users:write)
RESEND_API_KEY=
RESEND_FROM_EMAIL=
OPS_SUPPORT_EMAIL=
```

Invite emails carry the workspace join link + channel guidance. Open channels are joinable by everyone in the workspace; private city channels are handled by the bot (`conversations.invite`) once the member joins. With `SLACK_ADMIN_USER_TOKEN` the bot can also invite via `admin.users.invite` and deactivate accounts via `admin.users.setInactive`. Cooldown prevents duplicate invites; force-resend is admin+live only.

#### Billing integrity

- Dashboard shows missing Stripe links and conflicts using Airtable-side health scans.
- Full paying-Stripe-missing-Airtable detection remains CLI-oriented (`airtable:historical-stripe-repair`, `airtable:reconcile-stripe-customers`).
- **Dashboard does not create missing Airtable members from Stripe.**

#### Dashboard APIs

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/ops-dashboard/config` | GET | Mode, role, config flags |
| `/api/ops-dashboard/summary` | GET | Overview KPIs + critical issues |
| `/api/ops-dashboard/members` | GET | Filtered member health page |
| `/api/ops-dashboard/issues` | GET | Issue work queue |
| `/api/ops-dashboard/scans/member-health` | POST | Explicit member/Slack/channel scan |
| `/api/ops-dashboard/slack/resolve` | POST | Scan or safe Slack Email write |
| `/api/ops-dashboard/slack/link` | GET | Slack Email linking queue (empty Slack Email + suggestions) |
| `/api/ops-dashboard/slack/compare` | POST | Side-by-side Airtable record vs Slack profile |
| `/api/ops-dashboard/slack/removal-queue` | GET | Inactive member removal queue (+ capabilities) |
| `/api/ops-dashboard/slack/removal` | POST | Preview / remove channels / remove + deactivate (live admin) |
| `/api/ops-dashboard/slack/invite` | GET | Invite queue + pending private-channel adds |
| `/api/ops-dashboard/slack/channel-invite` | POST | Add member to private city channel (live admin) |
| `/api/ops-dashboard/slack-email/preview` | POST | Preview joining email |
| `/api/ops-dashboard/slack-email/send` | POST | Send joining email (live admin) |

#### Migrations

```bash
npm run db:migrate
```

Adds `member_outreach` and `ops_scan_snapshots`.

#### Member Directory pagination

- Default **100 rows per page** (`pageSize=100`).
- Options: 50 / 100 / 200.
- Controlled server-side pagination via `?page=` and `?pageSize=` (single slice on the API — not double-paginated in the table).
- Filters and search reset to page 1. Result range shows `1–100 of N members`.

#### Slack Community (`/members/slack-access`)

- **Link Slack emails** — lists members with an empty `Slack Email` and a best-guess Slack profile (primary-email or exact-name match, plus name-scored candidates). Compare shows the Airtable record next to the Slack profile; confirming writes `Slack Email` (server revalidates: field must still be empty and the email must map to exactly one active Slack user).
- **Remove inactive** — expired-access members who are not paused (intro pause or Stripe pause). One click removes them from their WLTH channels; with an admin token, their workspace account is deactivated too. Already-deactivated accounts are not listed.
- **Invite to Slack** — current-access members not found in the workspace get a joining email (cooldown-aware, forceable). Once they join, the "Add to city channel" view invites them into their private city channel via `conversations.invite`.
- All lists ordered by `Date joined` latest → oldest. Filters: search, city, membership, payment, date range, plus per-tab status filters.

#### Airtable field maps

Table-specific maps live in `src/lib/ops/airtable-fields.ts`. Do not request `Name` on the Cities table or `City` on Slack channels. Schema mismatches return `AIRTABLE_SCHEMA_MISMATCH` with table/field details (no secrets).

#### Members → Cities → Slack channels model

Correct relationship chain:

```text
Member  --(City relation)-->  ALL CITIES  --(Slack channels)-->  Slack channel
```

- Live Airtable table name is **`ALL CITIES`** (not `Cities`). Override with `AIRTABLE_CITIES_TABLE` if needed.
- **Do not** store a direct Member→Slack channel field.
- Prefer Members **`City relation`** (linked record → ALL CITIES, single). Create this field before `--apply-member-links`.
- Legacy Members **`City`** text/select is kept as source during migration and as fallback.
- Update **Slack channels.Cities** (multi-link) only; Airtable maintains the reciprocal link on ALL CITIES.
- **Active** channels require `Slack Channel ID`. **Paused/Closed** may omit it (not an urgent config error).
- Linked-record writes use bare ID strings `["rec…"]`, never `[{id:"rec…"}]`.

Optional env (defaults shown):

```env
AIRTABLE_CITIES_TABLE=ALL CITIES
AIRTABLE_MEMBER_CITY_LEGACY_FIELD=City
AIRTABLE_MEMBER_CITY_LINK_FIELD=City relation
AIRTABLE_CITY_NAME_FIELD=City
AIRTABLE_CITY_COUNTRY_FIELD=Country
AIRTABLE_CITY_CHANNEL_FIELD=Slack channels
AIRTABLE_SLACK_CHANNEL_NAME_FIELD=Name
AIRTABLE_SLACK_CHANNEL_CITIES_FIELD=Cities
AIRTABLE_SLACK_CHANNEL_STATUS_FIELD=Channel status/donut
AIRTABLE_SLACK_CHANNEL_ID_FIELD=Slack Channel ID
```

##### City relation repair CLI

Config: `config/city_relation_repair_config.json` (reviewed aliases, creates, channel↔city links, virtual fallbacks).

```bash
# 1) Audit (no writes) — always start here
npm run airtable:repair-city-relations -- --audit --config=./config/city_relation_repair_config.json

# 2) Dry-run proposals
npm run airtable:repair-city-relations -- --dry-run --config=./config/city_relation_repair_config.json

# 3) Create/rename Cities
npm run airtable:repair-city-relations -- --apply-city-records --confirm-apply --config=./config/city_relation_repair_config.json

# 4) Link Slack channels.Cities
npm run airtable:repair-city-relations -- --apply-channel-relations --confirm-apply --config=./config/city_relation_repair_config.json

# 5) Populate Members.City relation
npm run airtable:repair-city-relations -- --apply-member-links --confirm-apply --config=./config/city_relation_repair_config.json

# 6) Re-audit
npm run airtable:repair-city-relations -- --audit --config=./config/city_relation_repair_config.json
```

Reports land in `reports/city-relation-repair/<timestamp>/`.

**Before member links:** create Airtable field `City relation` on Members = Link to Cities (allow one record).

**Safety:** no writes without `--confirm-apply` + an `--apply-*` flag. No fuzzy auto-writes. No automatic Virtual assignment for blank/NA. Duplicate São Paulo merge via `--merge-duplicates`; delete only with `--delete-merged-duplicates` after verification. Not exposed as a dashboard button.

**Rollback:** restore from Airtable revision history / re-run audit CSVs; legacy `City` text is never cleared by the script.

#### Safe testing

1. Set `INTRODUCTIONS_MODE=read_only`, open `/overview`, hover KPI tooltips, run scans — no writes.
2. `/members?page=1&pageSize=100` — confirm 100 rows and next page.
3. `/members/slack-access` → Link / Remove / Invite tabs load ordered by Date joined; filters apply; mutation buttons disabled in read-only mode.
4. Confirm send/write buttons disabled or return `403` / `MANUAL_ACTIONS_READ_ONLY`.
5. Live rollout: set allowlists, `INTRODUCTIONS_MODE=live`, preview then single-send outreach.

### Legacy intro routes

- `/recurring-intros` — Recurring introductions only (preview/send)
- `/get-matched` — First-time matching (Pinecone-based, unchanged)

### API endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/recurring-intros/preview` | POST | Compute groups for selected channels, no writes |
| `/api/recurring-intros/send` | POST | Execute saved plan, deliver Slack messages |
| `/api/recurring-intros/config` | GET | Return non-secret configuration (send status, cooldowns, etc.) |
| `/api/recurring-intros/resolve-emails` | POST | Cross-reference Airtable members with Slack users |
| `/api/recurring-intros/slack-users` | POST | Fetch all workspace Slack users |
| `/api/cron/recurring-intros` | GET | Vercel cron entry (bypasses Clerk, protected by CRON_SECRET) |

### Plan/Send flow

1. **Preview** (`POST /api/recurring-intros/preview`) — Reads Airtable + Slack, computes groups, renders messages. Does not persist a plan or create reservations.
2. **Send** (`POST /api/recurring-intros/send`) — Requires `requestId`. Rejects mock mode. Runs the same computation with writes:
   - Checks idempotency by Cycle ID + participant record IDs
   - Creates Match-group record before Slack
   - Opens Slack group DM + posts message
   - Updates Match-group record on success/failure
   - Creates/updates Introduction data summary
   - Advances `Next introduction date` when all groups succeed

### HTTP status codes (send endpoint)

| Code | Meaning |
|---|---|
| 200 | All intended groups delivered or already idempotently delivered |
| 207 | Some groups delivered, some failed (partial success) |
| 400 | Invalid input |
| 403 | Sending disabled or mock mode attempted on send |
| 500 | No intended groups were delivered |

### Idempotency

- Send endpoint requires a unique `requestId`
- Groups are matched by Cycle ID + sorted participant Airtable IDs
- Already sent groups are skipped (idempotent)
- Failed groups are retried using the existing Match-group record

### Tracking-only retry

When Slack succeeds but Airtable tracking fails, the group status becomes `sent_tracking_failed`. A retry endpoint updates only Airtable — it never calls Slack again.

### Scripts

| Script | Purpose |
|---|---|
| `npm run airtable:update-intro-fields` | Batch-update First introduction status and Recurring eligible from on Members |
| `npm run airtable:import-history` | Import historical Airtable Match-groups into Postgres ledger |
| `npm run airtable:backfill-service-access` | Backfill `Service access until` from paid Stripe invoices (dry-run by default; `--apply` to write) |
| `npm run airtable:reconcile-stripe-customers` | Fill missing `Stripe Customer ID` via strict email + billing match (dry-run default; `--apply` for auto_match only) |
| `npm run airtable:historical-stripe-repair` | **One-time** historical repair: link/create paying Stripe customers in Airtable (not used by webhook) |
| `npm run airtable:historical-stripe-repair -- --subscriptions` | Reconcile every active+trialing Stripe subscription (allowlist `price_` ids) to Airtable: access = `current_period_end`, links blank `Stripe Customer ID` via unique email, creates missing with `--apply --create-missing`. Monotonic — never shortens access. Dry-run by default |
| `npm run airtable:audit-future-access-parity` | Read-only parity report: future-access Airtable rows without a listed-price active sub (extras) + qualifying memberships with no future access (holes). CSV at `tmp/future-access-parity-audit.csv` |
| `npm run airtable:apply-future-access-parity` | Apply parity fixes: repoint conflict records to the most recent qualifying customer + clear non-qualifying future access. Dry-run default; `-- --apply` to write. Repoint list lives in `scripts/apply-future-access-parity.ts` |

#### Daily parity cron

`/api/cron/future-access-parity` (Vercel cron, daily 06:00) runs the same computation as the audit CLI and repairs drift in **both** directions so Airtable future `Service access until` stays aligned with the Stripe listed-price census:
- **Holes** (paying member without future access) are auto-fixed with the monotonic repair (`repairParityHoles` — extends access only).
- **Extras** (future access without a listed-price active sub) are auto-fixed with the corrective repair (`repairParityExtras`): Stripe's authoritative paid-through is written when known (reduction allowed), unsupported future access is cleared, blank `Stripe Customer ID`s are linked via unique primary email, and duplicate rows sharing a customer id are collapsed to one keeper. Extras that cannot be resolved are alerted via `recordIntegrationError`.

Env gates: `PARITY_CRON_ENABLED=true`; optional `PARITY_CRON_AUTO_FIX_HOLES=false` (holes alert-only), `PARITY_CRON_AUTO_FIX_EXTRAS=false` (extras alert-only), `PARITY_CRON_MAX_HOLES` (default 100) and `PARITY_CRON_MAX_EXTRAS` (default 50).

### Member ownership (Memberstack + Make vs Stripe)

| Owner | Responsibility |
|---|---|
| **Memberstack → Make → Airtable** | Ongoing **Member create/upsert**. Make should upsert on `Memberstack ID` (preferred) or primary `email`, and set profile fields. |
| **Stripe webhook** | **Billing only**: update `Service access until`; optionally **link** blank `Stripe Customer ID` via unique primary email. **Never creates Members.** |
| **Historical repair CLI** | One-time backfill only (`--apply-links` / `--apply --create-missing`). Not part of the live path. |

#### Make.com upsert checklist

1. Trigger on Memberstack member create/update  
2. Upsert Airtable `Members` by **`Memberstack ID`** (unique); fallback unique primary **`email`**  
3. Map: `Memberstack ID`, `email`, `Name`, and any profile fields Make already owns  
4. Do **not** clear `Stripe Customer ID` or `Service access until` on profile sync  
5. Stripe webhook / repair scripts own those two billing fields  

### Stripe Service Access Synchronization

`Service access until` is the latest successfully paid membership period end from Stripe. It is independent of `INTRODUCTIONS_MODE` — billing sync stays active while introductions are read-only.

#### Airtable fields

| Field | Purpose |
|---|---|
| `Stripe Customer ID` | Exact Stripe `cus_…` ID |
| `Service access until` | Date **with time** (UTC ISO from Stripe `line.period.end`) |
| `email` | Primary email (used for optional webhook link; not Slack Email) |
| `Memberstack ID` | Owned by Make upsert |

#### Environment variables

```env
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_MEMBERSHIP_PRICE_IDS=price_xxx,price_yyy
STRIPE_MEMBER_REGISTRATION_RETRY_HOURS=24
AIRTABLE_GET_DATA_TOKEN=
AIRTABLE_BASE_ID=
```

`STRIPE_MEMBERSHIP_PRICE_IDS` is a comma-separated allowlist of recurring Price IDs that grant membership. Unrelated paid invoices are ignored.

`STRIPE_MEMBER_REGISTRATION_RETRY_HOURS` (default `24`): if `invoice.paid` arrives before Make has created the Member, the webhook returns **503** so Stripe retries. After the window it returns **200** with `member_registration_pending` and still does **not** create a Member.

#### Backfill

```bash
# Dry-run (default — no writes)
npm run airtable:backfill-service-access
npm run airtable:backfill-service-access -- --dry-run

# One customer
npm run airtable:backfill-service-access -- --dry-run --stripe-customer-id=cus_example
npm run airtable:backfill-service-access -- --apply --stripe-customer-id=cus_example

# Full apply
npm run airtable:backfill-service-access -- --apply
```

#### Webhook

- **Route:** `POST /api/webhooks/stripe` (not Clerk-protected; verified via Stripe signature)
- **Event:** `invoice.paid` only
- Retrieves the invoice + paginated lines, filters by membership prices, applies **monotonic** update (never shortens an existing future date)
- Match order: (1) `Stripe Customer ID` (2) unique primary `email` with **blank** customer ID → link + update  
- Conflicts (duplicate email, different existing customer ID) → **200** + status, no overwrite  
- Missing member inside retry window → **503** `member_registration_pending`  
- Missing member after window → **200** `member_registration_pending` (no create)  
- **Never** calls Airtable create from the webhook  

Cancellation / failed payment events do **not** clear or reduce `Service access until`.

#### One-time historical repair (CLI only)

```bash
# Preview
npm run airtable:historical-stripe-repair -- --dry-run
npm run airtable:historical-stripe-repair -- --dry-run --limit=20
npm run airtable:historical-stripe-repair -- --dry-run --stripe-customer-id=cus_example

# Link blank Stripe Customer IDs + update access (no creates)
npm run airtable:historical-stripe-repair -- --apply-links

# Full apply including creating missing Members (historical only)
npm run airtable:historical-stripe-repair -- --apply --create-missing
```

Report CSV: `tmp/historical-stripe-member-repair.csv`

### Stripe Customer ID reconciliation

Fills blank Airtable `Stripe Customer ID` values using **strict** email match + paid membership invoice proof. Never writes to Stripe. Independent of `INTRODUCTIONS_MODE`.

#### Automatic match (all must pass)

1. `Stripe Customer ID` blank  
2. Primary `email` present and valid  
3. Exactly one Airtable record with that normalized email  
4. Exactly one non-deleted Stripe customer with that email  
5. That `cus_…` not already on another Member  
6. Customer has ≥1 paid invoice  
7. ≥1 line uses a price in `STRIPE_MEMBERSHIP_PRICE_IDS`  
8. Valid `period.end`  

Only `auto_match` rows are written on `--apply`. Ambiguous cases go to the manual-review CSV.

#### Commands

```bash
# One email dry-run
npm run airtable:reconcile-stripe-customers -- --dry-run --email=person@example.com

# Full dry-run
npm run airtable:reconcile-stripe-customers -- --dry-run

# Review reports (not committed — tmp/)
#   tmp/stripe-customer-reconciliation.csv
#   tmp/stripe-customer-reconciliation-manual-review.csv

# Apply automatic matches only
npm run airtable:reconcile-stripe-customers -- --apply

# Verify (auto matches should become already_has_customer_id)
npm run airtable:reconcile-stripe-customers -- --dry-run

# Then recalculate Service access until
npm run airtable:backfill-service-access -- --dry-run
npm run airtable:backfill-service-access -- --apply
npm run airtable:backfill-service-access -- --dry-run
```

### Pilot rollout procedure

1. Run `npm run airtable:update-intro-fields` to set Grandfathered/Pending status
2. Keep `INTRODUCTIONS_MODE=read_only` and verify previews against real data
3. Set `RECURRING_INTROS_ALLOWED_CHANNEL_IDS` to a pilot Slack channel ID
4. Run `npm run db:migrate` to create Postgres ledger tables
5. Set `INTRODUCTIONS_MODE=live` only when ready to write and deliver
6. Remove legacy mode env vars from Vercel (listed above)

### Known limitations

- No Google/Outlook calendar scheduling (shows warning only)
- Group quality scoring is implemented but not yet fully wired into the orchestrator
- Saved preview plans / planId send flow is simplified (send still recomputes from current data)
- Postgres ledger tables exist; full plan persistence is partial

### Testing

```bash
npx vitest run tests/lib/introduction/   # reservations, history, quality, service-access
npx vitest run tests/lib/ops/recurring-city-intros.test.ts   # 37 core tests
```

See `tests/lib/introduction/` for reservation, history, quality, and service-access tests (13 tests). See `tests/lib/ops/recurring-city-intros.test.ts` for 37 core orchestrator tests.

## Forms / Make replacement (Tally)

Vercel-hosted signup and update-details widgets plus Memberstack/Stripe webhooks.

- Docs: `docs/forms-architecture.md`, `docs/webflow-embed.md`, `docs/production-rollout.md`
- Feature flags default **off** — see `.env.example`
- Build widgets: `npm run widgets:build`
- OPS: `/ops/webhook-errors`, `/ops/form-analytics`
- Matching / introductions are **not** modified by this subsystem

