# src/db/schema

Drizzle ORM schema files for the Neon Postgres database. Each table lives in its own file; `index.ts` re-exports all of them.

| File | Table | Description |
|---|---|---|
| `members.ts` | `members` | Canonical member records keyed by app-generated UUID text PK |
| `match-events.ts` | `match_events` | One row per operator "Send" click; tracks Slack delivery state and soft-delete |
| `match-event-matches.ts` | `match_event_matches` | 1–5 matched peers produced by each match event |
| `email-deliveries.ts` | `email_deliveries` | Per-recipient Resend email send; correlates Resend webhooks via `resend_message_id` |
| `run-log.ts` | `op_runs` | Operational run log (converted from SQLite); serial PK, timestamptz columns |

## Conventions

- **One table per file.** Add a new schema file here and re-export it from `index.ts`.
- **Glob restriction.** `drizzle.config.ts` points at `./src/db/schema/*.ts`, not the directory itself, because drizzle-kit globs every file in a directory and chokes on non-`.ts` files (like this README). Keep that pattern when adding new schema files — anything `.md`/`.txt` lives safely alongside.
- **Type pattern.** Each table file exports the `pgTable` along with `$inferSelect` / `$inferInsert` types (e.g. `OpRun`, `NewOpRun`) so callers import from `@/db/schema` without poking at table internals.
