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

### Ops tools (browser-only, no env var)

| Tool | Used for | Where |
|---|---|---|
| **Bulk Slack User Deactivation** Chrome extension | CSV-driven mass deactivation from `/remove-members` | https://chromewebstore.google.com/detail/bulk-slack-user-deactivat/bbklkhjijobpamjeemohloddompcehkc — license key is shown in-app on `/remove-members` |

### Where each integration lives in code

- `src/lib/integrations/airtable.ts` — Airtable REST client
- `src/lib/integrations/pinecone.ts` — Pinecone vector index
- `src/lib/integrations/openai-embeddings.ts` — OpenAI embeddings
- `src/lib/integrations/resend.ts` — Resend email client (supports `cc` / `bcc` / `replyTo`)
- `src/lib/integrations/slack.ts` — Slack Web API client
- `src/lib/integrations/strapi.ts` — Strapi CMS client
- `src/lib/geo/geocode.ts`, `src/lib/geo/nearby.ts` — Google Maps geocoding + nearest-neighbour math
- `src/db/` + `drizzle/` — Neon Postgres schema and migrations
