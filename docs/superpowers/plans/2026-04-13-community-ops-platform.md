# Community Ops Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an internal ops platform that automates data flows between Airtable, Slack, and Strapi for a 1,000+ member community, with a dashboard UI for ops team members.

**Architecture:** Single Next.js monolith (App Router) with Ant Design UI. Each operation is a self-contained file conforming to an `Op` interface. A registry auto-discovers ops, a scheduler triggers them on cron, and API routes allow manual triggers. Drizzle ORM with SQLite (dev) / Postgres (prod) for run history.

**Tech Stack:** Next.js 14 (App Router), Ant Design 5, Drizzle ORM, better-sqlite3 (dev), node-cron, TypeScript, Vitest

---

## File Structure

```
wlth-wlks-ops/
  src/
    app/
      layout.tsx                          # Root layout (Ant Design ConfigProvider)
      (dashboard)/
        layout.tsx                        # Sidebar + content shell
        page.tsx                          # Redirect to /ops
        ops/
          page.tsx                        # Ops overview table
          [slug]/
            page.tsx                      # Op detail: run history + logs
      api/
        ops/[slug]/run/
          route.ts                        # POST — trigger an op manually
        cron/
          route.ts                        # GET — run scheduled ops
        health/
          route.ts                        # GET — health check
    lib/
      types.ts                           # Op, OpContext, OpResult interfaces
      registry.ts                        # Auto-discover ops from lib/ops/
      logger.ts                          # Run history: start, log, finish
      scheduler.ts                       # Cron registry using node-cron
      integrations/
        airtable.ts                      # Airtable client: pagination + rate limit
        slack.ts                         # Slack Web API wrapper
        strapi.ts                        # Strapi REST client
      ops/
        sync-signups.ts                  # Airtable → Slack → Strapi
        donut-tracker.ts                 # Slack Donut channel → Strapi/Airtable
        member-export.ts                 # Airtable → CSV
    db/
      index.ts                           # DB connection (SQLite dev / Postgres prod)
      schema.ts                          # Drizzle schema: op_runs table
      migrate.ts                         # Run migrations on startup
  tests/
    lib/
      types.test.ts
      registry.test.ts
      logger.test.ts
      scheduler.test.ts
      integrations/
        airtable.test.ts
        slack.test.ts
        strapi.test.ts
      ops/
        sync-signups.test.ts
        donut-tracker.test.ts
        member-export.test.ts
    api/
      health.test.ts
      run.test.ts
      cron.test.ts
  .env.example
  drizzle.config.ts
  vitest.config.ts
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `.env.example`, `src/app/layout.tsx`, `src/app/page.tsx`

- [ ] **Step 1: Create Next.js project with dependencies**

```bash
cd /Users/jj/Documents/wlth-wlks-ops
npx create-next-app@latest . --typescript --eslint --app --src-dir --tailwind=no --import-alias="@/*" --use-npm
```

When prompted about overwriting existing files, accept.

- [ ] **Step 2: Install core dependencies**

```bash
npm install antd @ant-design/icons @ant-design/nextjs-registry drizzle-orm better-sqlite3 node-cron
npm install -D drizzle-kit @types/better-sqlite3 @types/node-cron vitest @vitejs/plugin-react
```

- [ ] **Step 3: Create `.env.example`**

Create `.env.example`:

```env
# Airtable
AIRTABLE_API_KEY=pat_xxx
AIRTABLE_BASE_ID=appXXX

# Slack
SLACK_BOT_TOKEN=xoxb-xxx
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx

# Strapi
STRAPI_URL=http://localhost:1337
STRAPI_TOKEN=xxx

# Database (optional — defaults to SQLite at ./data/ops.db)
DATABASE_URL=
```

- [ ] **Step 4: Create `vitest.config.ts`**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
```

- [ ] **Step 5: Add test script to `package.json`**

Add to `package.json` scripts:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 6: Update root layout with Ant Design provider**

Replace `src/app/layout.tsx`:

```tsx
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider } from "antd";

export const metadata = {
  title: "Community Ops",
  description: "Internal ops platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AntdRegistry>
          <ConfigProvider
            theme={{
              token: {
                colorPrimary: "#1677ff",
              },
            }}
          >
            {children}
          </ConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
```

- [ ] **Step 7: Verify dev server starts**

```bash
npm run dev
```

Expected: Next.js dev server starts on http://localhost:3000 without errors.

- [ ] **Step 8: Verify test runner works**

Create a smoke test at `tests/smoke.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

```bash
npm test
```

Expected: 1 test passes.

- [ ] **Step 9: Commit**

```bash
git init
echo "node_modules\n.next\n.env\ndata/" > .gitignore
git add .
git commit -m "feat: scaffold Next.js project with Ant Design and Vitest"
```

---

## Task 2: Database Schema and Connection

**Files:**
- Create: `src/db/schema.ts`, `src/db/index.ts`, `drizzle.config.ts`
- Test: `tests/lib/db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/db.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { opRuns } from "@/db/schema";
import { eq } from "drizzle-orm";

describe("op_runs schema", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE op_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_slug TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        log TEXT NOT NULL DEFAULT '',
        summary TEXT
      )
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("inserts and retrieves a run", async () => {
    const inserted = db
      .insert(opRuns)
      .values({ opSlug: "test-op", status: "running" })
      .returning()
      .get();

    expect(inserted.opSlug).toBe("test-op");
    expect(inserted.status).toBe("running");
    expect(inserted.id).toBeGreaterThan(0);
  });

  it("updates status and summary on finish", async () => {
    const inserted = db
      .insert(opRuns)
      .values({ opSlug: "test-op", status: "running" })
      .returning()
      .get();

    db.update(opRuns)
      .set({
        status: "success",
        summary: "Processed 5 records",
        finishedAt: new Date().toISOString(),
      })
      .where(eq(opRuns.id, inserted.id))
      .run();

    const updated = db
      .select()
      .from(opRuns)
      .where(eq(opRuns.id, inserted.id))
      .get();

    expect(updated?.status).toBe("success");
    expect(updated?.summary).toBe("Processed 5 records");
    expect(updated?.finishedAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/lib/db.test.ts
```

Expected: FAIL — `@/db/schema` not found.

- [ ] **Step 3: Create the schema**

Create `src/db/schema.ts`:

```typescript
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const opRuns = sqliteTable("op_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  opSlug: text("op_slug").notNull(),
  startedAt: text("started_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  finishedAt: text("finished_at"),
  status: text("status", { enum: ["running", "success", "failed"] })
    .notNull()
    .default("running"),
  log: text("log").notNull().default(""),
  summary: text("summary"),
});

export type OpRun = typeof opRuns.$inferSelect;
export type NewOpRun = typeof opRuns.$inferInsert;
```

- [ ] **Step 4: Create the DB connection module**

Create `src/db/index.ts`:

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "path";
import fs from "fs";

function getDb() {
  const dbUrl = process.env.DATABASE_URL;

  if (dbUrl && dbUrl.startsWith("postgres")) {
    throw new Error(
      "Postgres support requires drizzle-orm/node-postgres. Set up separately for production."
    );
  }

  const dbPath = dbUrl || path.join(process.cwd(), "data", "ops.db");
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");

  const db = drizzle(sqlite, { schema });

  // Auto-create table if not exists
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS op_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op_slug TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      log TEXT NOT NULL DEFAULT '',
      summary TEXT
    )
  `);

  return db;
}

export const db = getDb();
export type AppDb = typeof db;
```

- [ ] **Step 5: Create Drizzle config**

Create `drizzle.config.ts`:

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL || "./data/ops.db",
  },
});
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npm test -- tests/lib/db.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/db/ drizzle.config.ts tests/lib/db.test.ts
git commit -m "feat: add database schema and connection for op_runs"
```

---

## Task 3: Op Types and Registry

**Files:**
- Create: `src/lib/types.ts`, `src/lib/registry.ts`
- Test: `tests/lib/types.test.ts`, `tests/lib/registry.test.ts`

- [ ] **Step 1: Write the types test**

Create `tests/lib/types.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { Op, OpContext, OpResult } from "@/lib/types";

describe("Op type", () => {
  it("accepts a valid op definition", () => {
    const op: Op = {
      slug: "test-op",
      name: "Test Op",
      description: "A test operation",
      schedule: "0 * * * *",
      run: async (ctx: OpContext): Promise<OpResult> => {
        ctx.log("running");
        return { success: true, summary: "done", recordsProcessed: 0 };
      },
    };

    expect(op.slug).toBe("test-op");
    expect(op.schedule).toBe("0 * * * *");
  });

  it("allows op without schedule", () => {
    const op: Op = {
      slug: "manual-op",
      name: "Manual Op",
      description: "Manual only",
      run: async () => ({ success: true, summary: "done" }),
    };

    expect(op.schedule).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/lib/types.test.ts
```

Expected: FAIL — `@/lib/types` not found.

- [ ] **Step 3: Create the types**

Create `src/lib/types.ts`:

```typescript
import type { AppDb } from "@/db";

export interface OpContext {
  log: (message: string) => void;
  db: AppDb;
}

export interface OpResult {
  success: boolean;
  summary: string;
  recordsProcessed?: number;
}

export interface Op {
  slug: string;
  name: string;
  description: string;
  schedule?: string;
  run: (ctx: OpContext) => Promise<OpResult>;
}
```

- [ ] **Step 4: Run types test**

```bash
npm test -- tests/lib/types.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Write the registry test**

Create `tests/lib/registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createRegistry } from "@/lib/registry";
import type { Op } from "@/lib/types";

const fakeOp: Op = {
  slug: "fake-op",
  name: "Fake Op",
  description: "A fake op for testing",
  run: async () => ({ success: true, summary: "done" }),
};

const scheduledOp: Op = {
  slug: "scheduled-op",
  name: "Scheduled Op",
  description: "Runs on a schedule",
  schedule: "*/15 * * * *",
  run: async () => ({ success: true, summary: "done" }),
};

describe("registry", () => {
  it("registers and retrieves ops", () => {
    const registry = createRegistry([fakeOp, scheduledOp]);

    expect(registry.getAll()).toHaveLength(2);
    expect(registry.getBySlug("fake-op")).toBe(fakeOp);
    expect(registry.getBySlug("nonexistent")).toBeUndefined();
  });

  it("returns only scheduled ops", () => {
    const registry = createRegistry([fakeOp, scheduledOp]);
    const scheduled = registry.getScheduled();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].slug).toBe("scheduled-op");
  });
});
```

- [ ] **Step 6: Run registry test to verify it fails**

```bash
npm test -- tests/lib/registry.test.ts
```

Expected: FAIL — `@/lib/registry` not found.

- [ ] **Step 7: Implement the registry**

Create `src/lib/registry.ts`:

```typescript
import type { Op } from "./types";

export interface OpRegistry {
  getAll: () => readonly Op[];
  getBySlug: (slug: string) => Op | undefined;
  getScheduled: () => readonly Op[];
}

export function createRegistry(ops: readonly Op[]): OpRegistry {
  const bySlug = new Map(ops.map((op) => [op.slug, op]));

  return {
    getAll: () => ops,
    getBySlug: (slug) => bySlug.get(slug),
    getScheduled: () => ops.filter((op) => op.schedule !== undefined),
  };
}
```

- [ ] **Step 8: Run registry tests**

```bash
npm test -- tests/lib/registry.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/types.ts src/lib/registry.ts tests/lib/types.test.ts tests/lib/registry.test.ts
git commit -m "feat: add Op types and registry with auto-discovery"
```

---

## Task 4: Logger (Run History)

**Files:**
- Create: `src/lib/logger.ts`
- Test: `tests/lib/logger.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/logger.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createRunLogger } from "@/lib/logger";
import { opRuns } from "@/db/schema";
import { eq } from "drizzle-orm";

describe("RunLogger", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE op_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_slug TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        log TEXT NOT NULL DEFAULT '',
        summary TEXT
      )
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("starts a run and returns a context with log function", () => {
    const { ctx, runId } = createRunLogger(db, "test-op");

    expect(runId).toBeGreaterThan(0);
    expect(typeof ctx.log).toBe("function");
    expect(ctx.db).toBe(db);
  });

  it("appends log messages to the run record", () => {
    const { ctx, runId } = createRunLogger(db, "test-op");

    ctx.log("first message");
    ctx.log("second message");

    const run = db.select().from(opRuns).where(eq(opRuns.id, runId)).get();
    expect(run?.log).toContain("first message");
    expect(run?.log).toContain("second message");
  });

  it("finishRun marks success with summary", () => {
    const { ctx, runId, finishRun } = createRunLogger(db, "test-op");

    ctx.log("did some work");
    finishRun({ success: true, summary: "Processed 10 records" });

    const run = db.select().from(opRuns).where(eq(opRuns.id, runId)).get();
    expect(run?.status).toBe("success");
    expect(run?.summary).toBe("Processed 10 records");
    expect(run?.finishedAt).toBeTruthy();
  });

  it("finishRun marks failure", () => {
    const { runId, finishRun } = createRunLogger(db, "test-op");

    finishRun({ success: false, summary: "Connection timeout" });

    const run = db.select().from(opRuns).where(eq(opRuns.id, runId)).get();
    expect(run?.status).toBe("failed");
    expect(run?.summary).toBe("Connection timeout");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/lib/logger.test.ts
```

Expected: FAIL — `@/lib/logger` not found.

- [ ] **Step 3: Implement the logger**

Create `src/lib/logger.ts`:

```typescript
import { opRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { OpContext, OpResult } from "./types";

type Db = Parameters<typeof drizzle>[0] extends infer T ? T : never;

export function createRunLogger(db: any, opSlug: string) {
  const inserted = db
    .insert(opRuns)
    .values({ opSlug, status: "running" })
    .returning()
    .get();

  const runId: number = inserted.id;

  const ctx: OpContext = {
    db,
    log: (message: string) => {
      const current = db
        .select({ log: opRuns.log })
        .from(opRuns)
        .where(eq(opRuns.id, runId))
        .get();

      const timestamp = new Date().toISOString();
      const newLog = current?.log
        ? `${current.log}\n[${timestamp}] ${message}`
        : `[${timestamp}] ${message}`;

      db.update(opRuns)
        .set({ log: newLog })
        .where(eq(opRuns.id, runId))
        .run();
    },
  };

  const finishRun = (result: OpResult) => {
    db.update(opRuns)
      .set({
        status: result.success ? "success" : "failed",
        summary: result.summary,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(opRuns.id, runId))
      .run();
  };

  return { ctx, runId, finishRun };
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/lib/logger.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logger.ts tests/lib/logger.test.ts
git commit -m "feat: add run logger for op execution history"
```

---

## Task 5: API Routes (Health, Run, Cron)

**Files:**
- Create: `src/app/api/health/route.ts`, `src/app/api/ops/[slug]/run/route.ts`, `src/app/api/cron/route.ts`
- Create: `src/lib/run-op.ts` (shared op execution logic)
- Test: `tests/lib/run-op.test.ts`

- [ ] **Step 1: Write failing test for run-op**

Create `tests/lib/run-op.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { runOp } from "@/lib/run-op";
import { opRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { Op } from "@/lib/types";

describe("runOp", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE op_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_slug TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        log TEXT NOT NULL DEFAULT '',
        summary TEXT
      )
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("runs a successful op and records history", async () => {
    const op: Op = {
      slug: "test-op",
      name: "Test",
      description: "test",
      run: async (ctx) => {
        ctx.log("working");
        return { success: true, summary: "done", recordsProcessed: 3 };
      },
    };

    const result = await runOp(op, db);

    expect(result.success).toBe(true);
    expect(result.summary).toBe("done");

    const runs = db.select().from(opRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("success");
    expect(runs[0].log).toContain("working");
  });

  it("catches op errors and records failure", async () => {
    const op: Op = {
      slug: "failing-op",
      name: "Fail",
      description: "fails",
      run: async () => {
        throw new Error("connection refused");
      },
    };

    const result = await runOp(op, db);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("connection refused");

    const runs = db.select().from(opRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/lib/run-op.test.ts
```

Expected: FAIL — `@/lib/run-op` not found.

- [ ] **Step 3: Implement run-op**

Create `src/lib/run-op.ts`:

```typescript
import { createRunLogger } from "./logger";
import type { Op, OpResult } from "./types";

export async function runOp(op: Op, db: any): Promise<OpResult> {
  const { ctx, finishRun } = createRunLogger(db, op.slug);

  try {
    const result = await op.run(ctx);
    finishRun(result);
    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    const failResult: OpResult = {
      success: false,
      summary: `Error: ${message}`,
    };
    finishRun(failResult);
    return failResult;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/lib/run-op.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Create health route**

Create `src/app/api/health/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/db";
import { opRuns } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export async function GET() {
  try {
    const lastRuns = db
      .select()
      .from(opRuns)
      .orderBy(desc(opRuns.startedAt))
      .limit(20)
      .all();

    const failedOps = lastRuns.filter((r) => r.status === "failed");

    return NextResponse.json({
      status: "ok",
      recentRuns: lastRuns.length,
      failedOps: failedOps.map((r) => r.opSlug),
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: "Database unavailable" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 6: Create run route**

Create `src/app/api/ops/[slug]/run/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { registry } from "@/lib/registry-instance";
import { runOp } from "@/lib/run-op";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const op = registry.getBySlug(slug);

  if (!op) {
    return NextResponse.json(
      { success: false, error: `Op "${slug}" not found` },
      { status: 404 }
    );
  }

  const result = await runOp(op, db);
  const status = result.success ? 200 : 500;

  return NextResponse.json(result, { status });
}
```

- [ ] **Step 7: Create cron route**

Create `src/app/api/cron/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/db";
import { registry } from "@/lib/registry-instance";
import { runOp } from "@/lib/run-op";
import { opRuns } from "@/db/schema";
import { desc, eq, and } from "drizzle-orm";

function shouldRun(schedule: string, lastRunAt: string | null): boolean {
  // Simple check: for Vercel cron (every 15 min),
  // compare last run time against schedule interval.
  // For MVP, just check if enough time has passed based on the cron expression.
  if (!lastRunAt) return true;

  const lastRun = new Date(lastRunAt);
  const now = new Date();
  const diffMinutes = (now.getTime() - lastRun.getTime()) / 1000 / 60;

  // Parse simple cron intervals like "*/15 * * * *"
  const match = schedule.match(/^\*\/(\d+)\s/);
  if (match) {
    return diffMinutes >= parseInt(match[1], 10);
  }

  // For hourly ("0 * * * *"), check if 60 min passed
  if (schedule.startsWith("0 ")) {
    return diffMinutes >= 60;
  }

  // Default: run if 15+ min since last run
  return diffMinutes >= 15;
}

export async function GET() {
  const scheduledOps = registry.getScheduled();
  const results: Array<{ slug: string; ran: boolean; result?: string }> = [];

  for (const op of scheduledOps) {
    const lastRun = db
      .select()
      .from(opRuns)
      .where(
        and(
          eq(opRuns.opSlug, op.slug),
          eq(opRuns.status, "success")
        )
      )
      .orderBy(desc(opRuns.startedAt))
      .limit(1)
      .get();

    if (shouldRun(op.schedule!, lastRun?.startedAt ?? null)) {
      const result = await runOp(op, db);
      results.push({ slug: op.slug, ran: true, result: result.summary });
    } else {
      results.push({ slug: op.slug, ran: false });
    }
  }

  return NextResponse.json({ results });
}
```

- [ ] **Step 8: Create registry instance**

This singleton loads all ops and exports the registry for use by routes.

Create `src/lib/registry-instance.ts`:

```typescript
import { createRegistry } from "./registry";
import type { Op } from "./types";

// Import all ops here as they are created
const ops: Op[] = [];

export const registry = createRegistry(ops);
```

- [ ] **Step 9: Commit**

```bash
git add src/lib/run-op.ts src/lib/registry-instance.ts src/app/api/ tests/lib/run-op.test.ts
git commit -m "feat: add API routes for health, manual run, and cron"
```

---

## Task 6: Dashboard Layout

**Files:**
- Create: `src/app/(dashboard)/layout.tsx`, `src/app/(dashboard)/page.tsx`

- [ ] **Step 1: Create dashboard layout with sidebar**

Create `src/app/(dashboard)/layout.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Layout, Menu } from "antd";
import {
  DashboardOutlined,
  ThunderboltOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import { useRouter, usePathname } from "next/navigation";

const { Sider, Content } = Layout;

const menuItems = [
  {
    key: "/ops",
    icon: <ThunderboltOutlined />,
    label: "Operations",
  },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="light"
        style={{ borderRight: "1px solid #f0f0f0" }}
      >
        <div
          style={{
            height: 48,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 600,
            fontSize: collapsed ? 14 : 16,
            borderBottom: "1px solid #f0f0f0",
          }}
        >
          {collapsed ? "Ops" : "Community Ops"}
        </div>
        <Menu
          mode="inline"
          selectedKeys={[pathname]}
          items={menuItems}
          onClick={({ key }) => router.push(key)}
          style={{ borderRight: 0 }}
        />
      </Sider>
      <Content style={{ padding: 24, background: "#fafafa" }}>
        {children}
      </Content>
    </Layout>
  );
}
```

- [ ] **Step 2: Create dashboard index redirect**

Create `src/app/(dashboard)/page.tsx`:

```tsx
import { redirect } from "next/navigation";

export default function DashboardIndex() {
  redirect("/ops");
}
```

- [ ] **Step 3: Verify layout renders**

```bash
npm run dev
```

Open http://localhost:3000 — should see sidebar with "Community Ops" title and "Operations" menu item. Clicking it navigates to `/ops` (will 404 until next task).

- [ ] **Step 4: Commit**

```bash
git add src/app/\(dashboard\)/
git commit -m "feat: add dashboard layout with Ant Design sidebar"
```

---

## Task 7: Ops Overview Page

**Files:**
- Create: `src/app/(dashboard)/ops/page.tsx`
- Create: `src/lib/queries.ts` (server-side data fetching)

- [ ] **Step 1: Create server-side queries**

Create `src/lib/queries.ts`:

```typescript
import { db } from "@/db";
import { opRuns } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { registry } from "./registry-instance";
import type { Op } from "./types";
import type { OpRun } from "@/db/schema";

export interface OpStatus {
  slug: string;
  name: string;
  description: string;
  schedule?: string;
  lastRun?: OpRun;
  status: "idle" | "running" | "success" | "failed";
}

export function getOpsOverview(): OpStatus[] {
  const ops = registry.getAll();

  return ops.map((op) => {
    const lastRun = db
      .select()
      .from(opRuns)
      .where(eq(opRuns.opSlug, op.slug))
      .orderBy(desc(opRuns.startedAt))
      .limit(1)
      .get();

    return {
      slug: op.slug,
      name: op.name,
      description: op.description,
      schedule: op.schedule,
      lastRun: lastRun ?? undefined,
      status: lastRun?.status ?? "idle",
    };
  });
}

export function getOpRuns(slug: string, limit = 20): OpRun[] {
  return db
    .select()
    .from(opRuns)
    .where(eq(opRuns.opSlug, slug))
    .orderBy(desc(opRuns.startedAt))
    .limit(limit)
    .all();
}
```

- [ ] **Step 2: Create ops overview page**

Create `src/app/(dashboard)/ops/page.tsx`:

```tsx
import { Table, Tag, Button, Space, Typography } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { getOpsOverview } from "@/lib/queries";
import type { OpStatus } from "@/lib/queries";
import Link from "next/link";
import { RunButton } from "./run-button";

const { Title } = Typography;

const statusColors: Record<string, string> = {
  idle: "default",
  running: "processing",
  success: "success",
  failed: "error",
};

export default function OpsPage() {
  const ops = getOpsOverview();

  const columns = [
    {
      title: "Name",
      dataIndex: "name",
      key: "name",
      render: (name: string, record: OpStatus) => (
        <Link href={`/ops/${record.slug}`}>{name}</Link>
      ),
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (status: string) => (
        <Tag color={statusColors[status]}>{status.toUpperCase()}</Tag>
      ),
    },
    {
      title: "Last Run",
      key: "lastRun",
      render: (_: unknown, record: OpStatus) =>
        record.lastRun?.startedAt ?? "Never",
    },
    {
      title: "Schedule",
      dataIndex: "schedule",
      key: "schedule",
      render: (schedule?: string) => schedule ?? "Manual",
    },
    {
      title: "Actions",
      key: "actions",
      render: (_: unknown, record: OpStatus) => (
        <RunButton slug={record.slug} />
      ),
    },
  ];

  return (
    <>
      <Title level={3}>Operations</Title>
      <Table
        dataSource={ops}
        columns={columns}
        rowKey="slug"
        pagination={false}
        size="middle"
      />
    </>
  );
}
```

- [ ] **Step 3: Create the RunButton client component**

Create `src/app/(dashboard)/ops/run-button.tsx`:

```tsx
"use client";

import { Button, message } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function RunButton({ slug }: { slug: string }) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleRun = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ops/${slug}/run`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        message.success(data.summary);
      } else {
        message.error(data.summary || "Op failed");
      }
      router.refresh();
    } catch {
      message.error("Failed to trigger op");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      type="primary"
      size="small"
      icon={<PlayCircleOutlined />}
      loading={loading}
      onClick={handleRun}
    >
      Run Now
    </Button>
  );
}
```

- [ ] **Step 4: Verify page renders**

```bash
npm run dev
```

Open http://localhost:3000/ops — should see "Operations" heading with an empty table (no ops registered yet). Table headers visible: Name, Status, Last Run, Schedule, Actions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries.ts src/app/\(dashboard\)/ops/
git commit -m "feat: add ops overview page with status table"
```

---

## Task 8: Op Detail Page

**Files:**
- Create: `src/app/(dashboard)/ops/[slug]/page.tsx`

- [ ] **Step 1: Create op detail page**

Create `src/app/(dashboard)/ops/[slug]/page.tsx`:

```tsx
import { Typography, Table, Tag, Card, Descriptions, Empty } from "antd";
import { getOpRuns } from "@/lib/queries";
import { registry } from "@/lib/registry-instance";
import { notFound } from "next/navigation";
import { RunButton } from "../run-button";
import type { OpRun } from "@/db/schema";

const { Title } = Typography;

const statusColors: Record<string, string> = {
  running: "processing",
  success: "success",
  failed: "error",
};

export default async function OpDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const op = registry.getBySlug(slug);

  if (!op) {
    notFound();
  }

  const runs = getOpRuns(slug);

  const columns = [
    {
      title: "Started",
      dataIndex: "startedAt",
      key: "startedAt",
    },
    {
      title: "Finished",
      dataIndex: "finishedAt",
      key: "finishedAt",
      render: (v: string | null) => v ?? "—",
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (status: string) => (
        <Tag color={statusColors[status]}>{status.toUpperCase()}</Tag>
      ),
    },
    {
      title: "Summary",
      dataIndex: "summary",
      key: "summary",
      render: (v: string | null) => v ?? "—",
    },
  ];

  return (
    <>
      <Title level={3}>{op.name}</Title>

      <Card size="small" style={{ marginBottom: 24 }}>
        <Descriptions column={2}>
          <Descriptions.Item label="Slug">{op.slug}</Descriptions.Item>
          <Descriptions.Item label="Schedule">
            {op.schedule ?? "Manual"}
          </Descriptions.Item>
          <Descriptions.Item label="Description" span={2}>
            {op.description}
          </Descriptions.Item>
        </Descriptions>
        <div style={{ marginTop: 12 }}>
          <RunButton slug={op.slug} />
        </div>
      </Card>

      <Title level={4}>Run History</Title>
      {runs.length === 0 ? (
        <Empty description="No runs yet" />
      ) : (
        <Table
          dataSource={runs}
          columns={columns}
          rowKey="id"
          pagination={{ pageSize: 10 }}
          size="middle"
          expandable={{
            expandedRowRender: (record: OpRun) => (
              <pre
                style={{
                  maxHeight: 300,
                  overflow: "auto",
                  background: "#fafafa",
                  padding: 12,
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                }}
              >
                {record.log || "No logs"}
              </pre>
            ),
          }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Verify page renders**

```bash
npm run dev
```

Navigate to http://localhost:3000/ops/nonexistent — should get 404. Once ops are registered, `/ops/<slug>` will show detail view.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(dashboard\)/ops/\[slug\]/
git commit -m "feat: add op detail page with run history and log viewer"
```

---

## Task 9: Airtable Integration Client

**Files:**
- Create: `src/lib/integrations/airtable.ts`
- Test: `tests/lib/integrations/airtable.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/integrations/airtable.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAirtableClient } from "@/lib/integrations/airtable";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("AirtableClient", () => {
  const client = createAirtableClient({
    apiKey: "pat_test",
    baseId: "appTEST",
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches records from a table", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        records: [
          { id: "rec1", fields: { Name: "Alice" } },
          { id: "rec2", fields: { Name: "Bob" } },
        ],
      }),
    });

    const records = await client.listRecords("Members");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("appTEST/Members");
    expect(records).toHaveLength(2);
    expect(records[0].fields.Name).toBe("Alice");
  });

  it("handles pagination with offset", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          records: [{ id: "rec1", fields: { Name: "Alice" } }],
          offset: "page2",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          records: [{ id: "rec2", fields: { Name: "Bob" } }],
        }),
      });

    const records = await client.listRecords("Members");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(2);
  });

  it("applies filterByFormula", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ records: [] }),
    });

    await client.listRecords("Members", {
      filterByFormula: "{Status} = 'Active'",
    });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("filterByFormula");
    expect(url).toContain(encodeURIComponent("{Status} = 'Active'"));
  });

  it("retries on 429 rate limit", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ records: [] }),
      });

    const records = await client.listRecords("Members");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(0);
  });

  it("throws on non-retryable error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    await expect(client.listRecords("Members")).rejects.toThrow("401");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/lib/integrations/airtable.test.ts
```

Expected: FAIL — `@/lib/integrations/airtable` not found.

- [ ] **Step 3: Implement the Airtable client**

Create `src/lib/integrations/airtable.ts`:

```typescript
export interface AirtableConfig {
  apiKey: string;
  baseId: string;
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
  createdTime?: string;
}

export interface ListOptions {
  filterByFormula?: string;
  fields?: string[];
  sort?: Array<{ field: string; direction?: "asc" | "desc" }>;
  maxRecords?: number;
}

interface AirtableListResponse {
  records: AirtableRecord[];
  offset?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAirtableClient(config: AirtableConfig) {
  const baseUrl = `https://api.airtable.com/v0/${config.baseId}`;

  async function request(
    url: string,
    options?: RequestInit,
    retries = 3
  ): Promise<Response> {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (res.status === 429 && retries > 0) {
      const delay = Math.pow(2, 3 - retries) * 1000;
      await sleep(delay);
      return request(url, options, retries - 1);
    }

    if (!res.ok) {
      throw new Error(
        `Airtable API error: ${res.status} ${res.statusText}`
      );
    }

    return res;
  }

  async function listRecords(
    table: string,
    options?: ListOptions
  ): Promise<AirtableRecord[]> {
    const allRecords: AirtableRecord[] = [];
    let offset: string | undefined;

    do {
      const params = new URLSearchParams();
      if (options?.filterByFormula) {
        params.set("filterByFormula", options.filterByFormula);
      }
      if (options?.fields) {
        options.fields.forEach((f) => params.append("fields[]", f));
      }
      if (options?.maxRecords) {
        params.set("maxRecords", String(options.maxRecords));
      }
      if (offset) {
        params.set("offset", offset);
      }

      const url = `${baseUrl}/${encodeURIComponent(table)}?${params}`;
      const res = await request(url);
      const data: AirtableListResponse = await res.json();

      allRecords.push(...data.records);
      offset = data.offset;
    } while (offset);

    return allRecords;
  }

  async function getRecord(
    table: string,
    recordId: string
  ): Promise<AirtableRecord> {
    const url = `${baseUrl}/${encodeURIComponent(table)}/${recordId}`;
    const res = await request(url);
    return res.json();
  }

  async function createRecords(
    table: string,
    records: Array<{ fields: Record<string, unknown> }>
  ): Promise<AirtableRecord[]> {
    const url = `${baseUrl}/${encodeURIComponent(table)}`;
    const res = await request(url, {
      method: "POST",
      body: JSON.stringify({ records }),
    });
    const data = await res.json();
    return data.records;
  }

  async function updateRecords(
    table: string,
    records: Array<{ id: string; fields: Record<string, unknown> }>
  ): Promise<AirtableRecord[]> {
    const url = `${baseUrl}/${encodeURIComponent(table)}`;
    const res = await request(url, {
      method: "PATCH",
      body: JSON.stringify({ records }),
    });
    const data = await res.json();
    return data.records;
  }

  return { listRecords, getRecord, createRecords, updateRecords };
}

export type AirtableClient = ReturnType<typeof createAirtableClient>;
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/lib/integrations/airtable.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations/airtable.ts tests/lib/integrations/airtable.test.ts
git commit -m "feat: add Airtable client with pagination and rate limiting"
```

---

## Task 10: Slack Integration Client

**Files:**
- Create: `src/lib/integrations/slack.ts`
- Test: `tests/lib/integrations/slack.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/integrations/slack.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSlackClient } from "@/lib/integrations/slack";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("SlackClient", () => {
  const client = createSlackClient({ botToken: "xoxb-test" });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts a message to a channel", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, ts: "123.456" }),
    });

    const result = await client.postMessage("#general", "Hello!");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("chat.postMessage");
    const body = JSON.parse(opts.body);
    expect(body.channel).toBe("#general");
    expect(body.text).toBe("Hello!");
  });

  it("fetches channel history", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        messages: [
          { ts: "1", text: "hello" },
          { ts: "2", text: "world" },
        ],
        has_more: false,
      }),
    });

    const messages = await client.getChannelHistory("C123");

    expect(messages).toHaveLength(2);
    expect(messages[0].text).toBe("hello");
  });

  it("sends a webhook alert", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const webhookClient = createSlackClient({
      botToken: "xoxb-test",
      webhookUrl: "https://hooks.slack.com/test",
    });

    await webhookClient.sendWebhook("Alert!");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/test");
    const body = JSON.parse(opts.body);
    expect(body.text).toBe("Alert!");
  });

  it("throws when API returns ok: false", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: false, error: "channel_not_found" }),
    });

    await expect(
      client.postMessage("C_BAD", "test")
    ).rejects.toThrow("channel_not_found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/lib/integrations/slack.test.ts
```

Expected: FAIL — `@/lib/integrations/slack` not found.

- [ ] **Step 3: Implement the Slack client**

Create `src/lib/integrations/slack.ts`:

```typescript
export interface SlackConfig {
  botToken: string;
  webhookUrl?: string;
}

export interface SlackMessage {
  ts: string;
  text: string;
  user?: string;
  type?: string;
}

const SLACK_API = "https://slack.com/api";

export function createSlackClient(config: SlackConfig) {
  async function slackApi(
    method: string,
    body: Record<string, unknown>
  ): Promise<any> {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }
    return data;
  }

  async function postMessage(
    channel: string,
    text: string
  ): Promise<{ ts: string }> {
    const data = await slackApi("chat.postMessage", { channel, text });
    return { ts: data.ts };
  }

  async function getChannelHistory(
    channel: string,
    options?: { oldest?: string; limit?: number }
  ): Promise<SlackMessage[]> {
    const allMessages: SlackMessage[] = [];
    let cursor: string | undefined;

    do {
      const data = await slackApi("conversations.history", {
        channel,
        oldest: options?.oldest,
        limit: options?.limit ?? 100,
        cursor,
      });

      allMessages.push(...data.messages);
      cursor = data.has_more ? data.response_metadata?.next_cursor : undefined;
    } while (cursor);

    return allMessages;
  }

  async function sendWebhook(text: string): Promise<void> {
    if (!config.webhookUrl) {
      throw new Error("Webhook URL not configured");
    }

    await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  return { postMessage, getChannelHistory, sendWebhook };
}

export type SlackClient = ReturnType<typeof createSlackClient>;
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/lib/integrations/slack.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations/slack.ts tests/lib/integrations/slack.test.ts
git commit -m "feat: add Slack client with messaging and webhook support"
```

---

## Task 11: Strapi Integration Client

**Files:**
- Create: `src/lib/integrations/strapi.ts`
- Test: `tests/lib/integrations/strapi.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/integrations/strapi.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStrapiClient } from "@/lib/integrations/strapi";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("StrapiClient", () => {
  const client = createStrapiClient({
    baseUrl: "http://localhost:1337",
    token: "test-token",
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches entries from a content type", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 1, attributes: { name: "Alice" } },
          { id: 2, attributes: { name: "Bob" } },
        ],
      }),
    });

    const entries = await client.find("members");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/members");
    expect(entries.data).toHaveLength(2);
  });

  it("creates an entry", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { id: 3, attributes: { name: "Charlie" } },
      }),
    });

    const result = await client.create("members", { name: "Charlie" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.data.name).toBe("Charlie");
  });

  it("updates an entry", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { id: 1, attributes: { name: "Alice Updated" } },
      }),
    });

    await client.update("members", 1, { name: "Alice Updated" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/members/1");
    expect(opts.method).toBe("PUT");
  });

  it("sends auth header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await client.find("members");

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer test-token");
  });

  it("throws on API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });

    await expect(client.find("members")).rejects.toThrow("403");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/lib/integrations/strapi.test.ts
```

Expected: FAIL — `@/lib/integrations/strapi` not found.

- [ ] **Step 3: Implement the Strapi client**

Create `src/lib/integrations/strapi.ts`:

```typescript
export interface StrapiConfig {
  baseUrl: string;
  token: string;
}

export function createStrapiClient(config: StrapiConfig) {
  const apiUrl = `${config.baseUrl}/api`;

  async function request(
    path: string,
    options?: RequestInit
  ): Promise<any> {
    const res = await fetch(`${apiUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!res.ok) {
      throw new Error(
        `Strapi API error: ${res.status} ${res.statusText}`
      );
    }

    return res.json();
  }

  async function find(
    contentType: string,
    params?: Record<string, string>
  ): Promise<any> {
    const qs = params ? `?${new URLSearchParams(params)}` : "";
    return request(`/${contentType}${qs}`);
  }

  async function findOne(
    contentType: string,
    id: number | string
  ): Promise<any> {
    return request(`/${contentType}/${id}`);
  }

  async function create(
    contentType: string,
    data: Record<string, unknown>
  ): Promise<any> {
    return request(`/${contentType}`, {
      method: "POST",
      body: JSON.stringify({ data }),
    });
  }

  async function update(
    contentType: string,
    id: number | string,
    data: Record<string, unknown>
  ): Promise<any> {
    return request(`/${contentType}/${id}`, {
      method: "PUT",
      body: JSON.stringify({ data }),
    });
  }

  async function remove(
    contentType: string,
    id: number | string
  ): Promise<any> {
    return request(`/${contentType}/${id}`, { method: "DELETE" });
  }

  return { find, findOne, create, update, remove };
}

export type StrapiClient = ReturnType<typeof createStrapiClient>;
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/lib/integrations/strapi.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations/strapi.ts tests/lib/integrations/strapi.test.ts
git commit -m "feat: add Strapi REST client with CRUD operations"
```

---

## Task 12: Scheduler

**Files:**
- Create: `src/lib/scheduler.ts`
- Test: `tests/lib/scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/scheduler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createScheduler } from "@/lib/scheduler";
import type { Op } from "@/lib/types";

// Mock node-cron
vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn(() => ({ stop: vi.fn() })),
    validate: vi.fn((expr: string) => expr.split(" ").length === 5),
  },
}));

describe("Scheduler", () => {
  const mockRunOp = vi.fn().mockResolvedValue({ success: true, summary: "ok" });

  const scheduledOp: Op = {
    slug: "hourly-sync",
    name: "Hourly Sync",
    description: "Syncs every hour",
    schedule: "0 * * * *",
    run: async () => ({ success: true, summary: "done" }),
  };

  const manualOp: Op = {
    slug: "manual-op",
    name: "Manual Op",
    description: "No schedule",
    run: async () => ({ success: true, summary: "done" }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers cron jobs for scheduled ops", async () => {
    const cron = await import("node-cron");
    const scheduler = createScheduler([scheduledOp, manualOp], mockRunOp);

    scheduler.start();

    // Only the scheduled op gets a cron job
    expect(cron.default.schedule).toHaveBeenCalledTimes(1);
    expect(cron.default.schedule).toHaveBeenCalledWith(
      "0 * * * *",
      expect.any(Function)
    );
  });

  it("stops all cron jobs", async () => {
    const stopFn = vi.fn();
    const cron = await import("node-cron");
    (cron.default.schedule as any).mockReturnValue({ stop: stopFn });

    const scheduler = createScheduler([scheduledOp], mockRunOp);
    scheduler.start();
    scheduler.stop();

    expect(stopFn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/lib/scheduler.test.ts
```

Expected: FAIL — `@/lib/scheduler` not found.

- [ ] **Step 3: Implement the scheduler**

Create `src/lib/scheduler.ts`:

```typescript
import cron from "node-cron";
import type { Op, OpResult } from "./types";

interface ScheduledTask {
  stop: () => void;
}

export function createScheduler(
  ops: readonly Op[],
  runOp: (op: Op) => Promise<OpResult>
) {
  const tasks: ScheduledTask[] = [];

  function start() {
    for (const op of ops) {
      if (!op.schedule) continue;

      const task = cron.schedule(op.schedule, async () => {
        console.log(`[scheduler] Running ${op.slug}`);
        try {
          const result = await runOp(op);
          console.log(
            `[scheduler] ${op.slug} finished: ${result.summary}`
          );
        } catch (error) {
          console.error(`[scheduler] ${op.slug} error:`, error);
        }
      });

      tasks.push(task);
    }

    console.log(
      `[scheduler] Started ${tasks.length} scheduled job(s)`
    );
  }

  function stop() {
    for (const task of tasks) {
      task.stop();
    }
    tasks.length = 0;
  }

  return { start, stop };
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/lib/scheduler.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduler.ts tests/lib/scheduler.test.ts
git commit -m "feat: add cron scheduler for ops with schedule expressions"
```

---

## Task 13: First Op — sync-signups

**Files:**
- Create: `src/lib/ops/sync-signups.ts`
- Test: `tests/lib/ops/sync-signups.test.ts`
- Modify: `src/lib/registry-instance.ts` (register the op)

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ops/sync-signups.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { syncSignups } from "@/lib/ops/sync-signups";

// Mock the integration clients
vi.mock("@/lib/integrations/airtable", () => ({
  createAirtableClient: () => ({
    listRecords: vi.fn().mockResolvedValue([
      {
        id: "rec1",
        fields: { Name: "Alice", Email: "alice@test.com", Status: "New" },
      },
      {
        id: "rec2",
        fields: { Name: "Bob", Email: "bob@test.com", Status: "New" },
      },
    ]),
    updateRecords: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock("@/lib/integrations/slack", () => ({
  createSlackClient: () => ({
    postMessage: vi.fn().mockResolvedValue({ ts: "123" }),
  }),
}));

vi.mock("@/lib/integrations/strapi", () => ({
  createStrapiClient: () => ({
    create: vi.fn().mockResolvedValue({ data: { id: 1 } }),
  }),
}));

describe("sync-signups op", () => {
  it("has correct metadata", () => {
    expect(syncSignups.slug).toBe("sync-signups");
    expect(syncSignups.name).toBeTruthy();
    expect(syncSignups.description).toBeTruthy();
    expect(syncSignups.schedule).toBeDefined();
  });

  it("runs and returns result", async () => {
    const logs: string[] = [];
    const ctx = {
      log: (msg: string) => logs.push(msg),
      db: {} as any,
    };

    const result = await syncSignups.run(ctx);

    expect(result.success).toBe(true);
    expect(result.recordsProcessed).toBe(2);
    expect(logs.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/lib/ops/sync-signups.test.ts
```

Expected: FAIL — `@/lib/ops/sync-signups` not found.

- [ ] **Step 3: Implement sync-signups**

Create `src/lib/ops/sync-signups.ts`:

```typescript
import type { Op } from "../types";
import { createAirtableClient } from "../integrations/airtable";
import { createSlackClient } from "../integrations/slack";
import { createStrapiClient } from "../integrations/strapi";

export const syncSignups: Op = {
  slug: "sync-signups",
  name: "Sync Signups",
  description:
    "Fetch new Airtable signups, add to Slack channels, update Strapi",
  schedule: "0 * * * *",

  run: async (ctx) => {
    const airtable = createAirtableClient({
      apiKey: process.env.AIRTABLE_API_KEY!,
      baseId: process.env.AIRTABLE_BASE_ID!,
    });
    const slack = createSlackClient({
      botToken: process.env.SLACK_BOT_TOKEN!,
    });
    const strapi = createStrapiClient({
      baseUrl: process.env.STRAPI_URL!,
      token: process.env.STRAPI_TOKEN!,
    });

    ctx.log("Fetching new signups from Airtable...");

    const records = await airtable.listRecords("Signups", {
      filterByFormula: "{Status} = 'New'",
    });

    ctx.log(`Found ${records.length} new signup(s)`);

    if (records.length === 0) {
      return {
        success: true,
        summary: "No new signups",
        recordsProcessed: 0,
      };
    }

    for (const record of records) {
      const name = record.fields.Name as string;
      const email = record.fields.Email as string;

      ctx.log(`Processing: ${name} (${email})`);

      // Post welcome to Slack
      await slack.postMessage(
        "#new-members",
        `Welcome ${name} (${email}) to the community!`
      );

      // Create member in Strapi
      await strapi.create("members", { name, email, airtableId: record.id });

      // Mark as processed in Airtable
      await airtable.updateRecords("Signups", [
        { id: record.id, fields: { Status: "Processed" } },
      ]);
    }

    return {
      success: true,
      summary: `Synced ${records.length} new signup(s)`,
      recordsProcessed: records.length,
    };
  },
};
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/lib/ops/sync-signups.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Register the op**

Update `src/lib/registry-instance.ts`:

```typescript
import { createRegistry } from "./registry";
import type { Op } from "./types";
import { syncSignups } from "./ops/sync-signups";

const ops: Op[] = [syncSignups];

export const registry = createRegistry(ops);
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/ops/sync-signups.ts src/lib/registry-instance.ts tests/lib/ops/sync-signups.test.ts
git commit -m "feat: add sync-signups op (Airtable → Slack → Strapi)"
```

---

## Task 14: Second Op — donut-tracker

**Files:**
- Create: `src/lib/ops/donut-tracker.ts`
- Test: `tests/lib/ops/donut-tracker.test.ts`
- Modify: `src/lib/registry-instance.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ops/donut-tracker.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { donutTracker } from "@/lib/ops/donut-tracker";

vi.mock("@/lib/integrations/slack", () => ({
  createSlackClient: () => ({
    getChannelHistory: vi.fn().mockResolvedValue([
      { ts: "1", text: "Paired: Alice and Bob", user: "U_DONUT_BOT" },
      { ts: "2", text: "How was your chat?", user: "U_DONUT_BOT" },
      { ts: "3", text: "random message", user: "U_HUMAN" },
    ]),
  }),
}));

vi.mock("@/lib/integrations/strapi", () => ({
  createStrapiClient: () => ({
    create: vi.fn().mockResolvedValue({ data: { id: 1 } }),
  }),
}));

vi.mock("@/lib/integrations/airtable", () => ({
  createAirtableClient: () => ({
    createRecords: vi.fn().mockResolvedValue([]),
  }),
}));

describe("donut-tracker op", () => {
  it("has correct metadata", () => {
    expect(donutTracker.slug).toBe("donut-tracker");
    expect(donutTracker.schedule).toBeDefined();
  });

  it("runs and extracts pairings", async () => {
    const logs: string[] = [];
    const ctx = {
      log: (msg: string) => logs.push(msg),
      db: {} as any,
    };

    const result = await donutTracker.run(ctx);

    expect(result.success).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/lib/ops/donut-tracker.test.ts
```

Expected: FAIL — `@/lib/ops/donut-tracker` not found.

- [ ] **Step 3: Implement donut-tracker**

Create `src/lib/ops/donut-tracker.ts`:

```typescript
import type { Op } from "../types";
import { createSlackClient } from "../integrations/slack";
import { createStrapiClient } from "../integrations/strapi";
import { createAirtableClient } from "../integrations/airtable";

function extractPairings(
  messages: Array<{ text: string; ts: string; user?: string }>
): Array<{ person1: string; person2: string; ts: string }> {
  const pairings: Array<{ person1: string; person2: string; ts: string }> = [];

  for (const msg of messages) {
    // Match "Paired: X and Y" pattern from Donut bot
    const match = msg.text.match(/Paired:\s*(.+?)\s+and\s+(.+)/i);
    if (match) {
      pairings.push({
        person1: match[1].trim(),
        person2: match[2].trim(),
        ts: msg.ts,
      });
    }
  }

  return pairings;
}

export const donutTracker: Op = {
  slug: "donut-tracker",
  name: "Donut Tracker",
  description:
    "Read Donut channel history, extract pairing data, push to Strapi/Airtable",
  schedule: "0 9 * * 1",

  run: async (ctx) => {
    const slack = createSlackClient({
      botToken: process.env.SLACK_BOT_TOKEN!,
    });
    const strapi = createStrapiClient({
      baseUrl: process.env.STRAPI_URL!,
      token: process.env.STRAPI_TOKEN!,
    });
    const airtable = createAirtableClient({
      apiKey: process.env.AIRTABLE_API_KEY!,
      baseId: process.env.AIRTABLE_BASE_ID!,
    });

    const donutChannel = process.env.SLACK_DONUT_CHANNEL || "donut-pairings";

    ctx.log(`Fetching Donut channel history from #${donutChannel}...`);

    const messages = await slack.getChannelHistory(donutChannel, {
      limit: 200,
    });

    ctx.log(`Fetched ${messages.length} messages`);

    const pairings = extractPairings(messages);
    ctx.log(`Found ${pairings.length} pairing(s)`);

    if (pairings.length === 0) {
      return {
        success: true,
        summary: "No new pairings found",
        recordsProcessed: 0,
      };
    }

    for (const pairing of pairings) {
      ctx.log(`Recording pairing: ${pairing.person1} <> ${pairing.person2}`);

      await strapi.create("donut-pairings", {
        person1: pairing.person1,
        person2: pairing.person2,
        pairedAt: new Date(parseFloat(pairing.ts) * 1000).toISOString(),
      });

      await airtable.createRecords("Donut Pairings", [
        {
          fields: {
            Person1: pairing.person1,
            Person2: pairing.person2,
            "Paired At": new Date(
              parseFloat(pairing.ts) * 1000
            ).toISOString(),
          },
        },
      ]);
    }

    return {
      success: true,
      summary: `Tracked ${pairings.length} donut pairing(s)`,
      recordsProcessed: pairings.length,
    };
  },
};
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/lib/ops/donut-tracker.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Register the op**

Update `src/lib/registry-instance.ts`:

```typescript
import { createRegistry } from "./registry";
import type { Op } from "./types";
import { syncSignups } from "./ops/sync-signups";
import { donutTracker } from "./ops/donut-tracker";

const ops: Op[] = [syncSignups, donutTracker];

export const registry = createRegistry(ops);
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/ops/donut-tracker.ts src/lib/registry-instance.ts tests/lib/ops/donut-tracker.test.ts
git commit -m "feat: add donut-tracker op (Slack → Strapi/Airtable)"
```

---

## Task 15: Third Op — member-export

**Files:**
- Create: `src/lib/ops/member-export.ts`
- Test: `tests/lib/ops/member-export.test.ts`
- Modify: `src/lib/registry-instance.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ops/member-export.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { memberExport } from "@/lib/ops/member-export";

vi.mock("@/lib/integrations/airtable", () => ({
  createAirtableClient: () => ({
    listRecords: vi.fn().mockResolvedValue([
      {
        id: "rec1",
        fields: { Name: "Alice", Email: "alice@test.com", Role: "Member" },
      },
      {
        id: "rec2",
        fields: { Name: "Bob", Email: "bob@test.com", Role: "Lead" },
      },
    ]),
  }),
}));

// Mock fs
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

describe("member-export op", () => {
  it("has correct metadata", () => {
    expect(memberExport.slug).toBe("member-export");
    expect(memberExport.schedule).toBeUndefined();
  });

  it("exports members to CSV", async () => {
    const logs: string[] = [];
    const ctx = {
      log: (msg: string) => logs.push(msg),
      db: {} as any,
    };

    const result = await memberExport.run(ctx);

    expect(result.success).toBe(true);
    expect(result.recordsProcessed).toBe(2);
    expect(result.summary).toContain("2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/lib/ops/member-export.test.ts
```

Expected: FAIL — `@/lib/ops/member-export` not found.

- [ ] **Step 3: Implement member-export**

Create `src/lib/ops/member-export.ts`:

```typescript
import type { Op } from "../types";
import { createAirtableClient } from "../integrations/airtable";
import fs from "fs";
import path from "path";

function toCsv(
  records: Array<{ fields: Record<string, unknown> }>,
  columns: string[]
): string {
  const header = columns.join(",");
  const rows = records.map((r) =>
    columns
      .map((col) => {
        const val = String(r.fields[col] ?? "");
        // Escape values with commas or quotes
        if (val.includes(",") || val.includes('"') || val.includes("\n")) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val;
      })
      .join(",")
  );
  return [header, ...rows].join("\n");
}

export const memberExport: Op = {
  slug: "member-export",
  name: "Member Export",
  description: "Export member list from Airtable to downloadable CSV",
  // No schedule — manual trigger only

  run: async (ctx) => {
    const airtable = createAirtableClient({
      apiKey: process.env.AIRTABLE_API_KEY!,
      baseId: process.env.AIRTABLE_BASE_ID!,
    });

    ctx.log("Fetching all members from Airtable...");

    const records = await airtable.listRecords("Members");
    ctx.log(`Fetched ${records.length} member(s)`);

    if (records.length === 0) {
      return {
        success: true,
        summary: "No members to export",
        recordsProcessed: 0,
      };
    }

    // Collect all unique field names
    const allFields = new Set<string>();
    for (const r of records) {
      Object.keys(r.fields).forEach((k) => allFields.add(k));
    }
    const columns = Array.from(allFields).sort();

    const csv = toCsv(records, columns);

    const exportDir = path.join(process.cwd(), "data", "exports");
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const filename = `members-${new Date().toISOString().slice(0, 10)}.csv`;
    const filepath = path.join(exportDir, filename);
    fs.writeFileSync(filepath, csv, "utf-8");

    ctx.log(`Exported to ${filepath}`);

    return {
      success: true,
      summary: `Exported ${records.length} member(s) to ${filename}`,
      recordsProcessed: records.length,
    };
  },
};
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/lib/ops/member-export.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Register the op and finalize registry**

Update `src/lib/registry-instance.ts`:

```typescript
import { createRegistry } from "./registry";
import type { Op } from "./types";
import { syncSignups } from "./ops/sync-signups";
import { donutTracker } from "./ops/donut-tracker";
import { memberExport } from "./ops/member-export";

const ops: Op[] = [syncSignups, donutTracker, memberExport];

export const registry = createRegistry(ops);
```

- [ ] **Step 6: Run all tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ops/member-export.ts src/lib/registry-instance.ts tests/lib/ops/member-export.test.ts
git commit -m "feat: add member-export op (Airtable → CSV)"
```

---

## Task 16: Vercel Cron Config and Final Wiring

**Files:**
- Create: `vercel.json`
- Modify: `src/app/page.tsx` (update root redirect)

- [ ] **Step 1: Create vercel.json**

Create `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron",
      "schedule": "*/15 * * * *"
    }
  ]
}
```

- [ ] **Step 2: Update root page to redirect to dashboard**

Replace `src/app/page.tsx`:

```tsx
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/ops");
}
```

- [ ] **Step 3: Add .gitignore entries for data dir**

Ensure `.gitignore` contains:

```
data/
```

- [ ] **Step 4: Verify full app**

```bash
npm run build
```

Expected: Build succeeds with no errors.

```bash
npm run dev
```

Visit http://localhost:3000 — should redirect to `/ops`, showing the ops table with 3 ops: Sync Signups, Donut Tracker, Member Export.

- [ ] **Step 5: Run all tests one final time**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add vercel.json src/app/page.tsx .gitignore
git commit -m "feat: add Vercel cron config and final wiring"
```
