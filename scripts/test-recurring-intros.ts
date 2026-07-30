/**
 * Self-contained test script for recurring city introductions.
 * Uses mock adapters — no real Airtable or Slack calls.
 *
 * Usage:  npx tsx scripts/test-recurring-intros.ts
 */

import {
  runRecurringCityIntros,
} from "../src/lib/ops/recurring-city-intros";
import {
  createMockAirtable,
  createMockSlack,
  getMockMembers,
} from "../src/lib/ops/recurring-intros-mock-data";
import type { AirtableRecord } from "../src/lib/integrations/airtable";

const FAKE_MEMBERS = getMockMembers();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function separator(title: string) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(70)}`);
}

function printPreview(preview: unknown) {
  const p = preview as {
    channelName: string;
    cityName: string;
    cycleId: string;
    isDue: boolean;
    slackUserCount: number;
    eligibleMembers: { name: string; email: string }[];
    proposedGroups: { members: { name: string; email: string }[]; unmatched: boolean }[];
    groupSizes: number[];
    unmatchedMembers: { name: string; email: string }[];
    excludedByReason: Record<string, { name: string; email: string }[]>;
    recentRepeatWarnings: string[];
    calendarWarning: string | null;
    renderedMessages: string[];
  };
  console.log(`  Channel:        ${p.channelName} (${p.cityName})`);
  console.log(`  Cycle ID:       ${p.cycleId}`);
  console.log(`  Due:            ${p.isDue ? "YES" : "no"}`);
  console.log(`  Slack users:    ${p.slackUserCount}`);
  console.log(`  Eligible:       ${p.eligibleMembers.length}`);
  console.log(`  Proposed groups: ${p.proposedGroups.length}`);
  console.log(`  Group sizes:    [${p.groupSizes.join(", ")}]`);
  console.log(`  Unmatched:      ${p.unmatchedMembers.length}`);

  if (p.excludedByReason && Object.keys(p.excludedByReason).length > 0) {
    console.log(`  Exclusions:`);
    for (const [reason, members] of Object.entries(p.excludedByReason)) {
      console.log(`    - ${reason}: ${members.map((m) => m.name).join(", ")}`);
    }
  }

  if (p.recentRepeatWarnings?.length) {
    console.log(`  Repeat warnings:`);
    for (const w of p.recentRepeatWarnings) {
      console.log(`    ⚠ ${w}`);
    }
  }

  if (p.calendarWarning) {
    console.log(`  Calendar warning: ${p.calendarWarning}`);
  }

  console.log(`\n  Proposed groups:`);
  for (let i = 0; i < p.proposedGroups.length; i++) {
    const g = p.proposedGroups[i];
    const tag = g.unmatched ? " (unmatched)" : "";
    const names = g.members.map((m) => `${m.name} <${m.email}>`).join(", ");
    console.log(`    Group ${i + 1}${tag}: ${names}`);
  }

  if (p.renderedMessages?.length) {
    console.log(`\n  Message preview (group 1):`);
    console.log(`    ${p.renderedMessages[0]?.replace(/\n/g, "\n    ")}`);
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioA_Preview() {
  separator("Scenario A — Preview (no side effects)");
  const airtable = createMockAirtable();
  const slack = createMockSlack();

  const result = await runRecurringCityIntros(
    {
      airtable,
      slack,
      now: () => new Date("2026-06-01T10:00:00Z"),
      mode: "preview",
      writesEnabled: false,
      
      
      
      allowedChannelIds: null,
    },
    { cycleDate: "2026-06-01T10:00:00Z" }
  );

  console.log(`\n  Summary: ${result.summary}`);
  console.log(`  Success: ${result.success}`);
  for (const p of result.previews) {
    printPreview(p);
  }
}

async function scenarioB_SendMock() {
  separator("Scenario B — Send (mock Slack, no real messages)");
  const airtable = createMockAirtable();
  const slack = createMockSlack();

  const result = await runRecurringCityIntros(
    {
      airtable,
      slack,
      now: () => new Date("2026-06-01T10:00:00Z"),
      mode: "send",
      writesEnabled: true,
      
      
      
      allowedChannelIds: null,
    },
    { cycleDate: "2026-06-01T10:00:00Z" }
  );

  console.log(`\n  Summary: ${result.summary}`);
  console.log(`  Sent groups: ${result.sentGroups}`);
  console.log(`  Failed groups: ${result.failedGroups}`);
  for (const p of result.previews) {
    printPreview(p);
  }
}

async function scenarioC_RepeatPrevention() {
  separator("Scenario C — Repeat prevention (second cycle reuses members from first)");

  const matchGroupRecords: AirtableRecord[] = [
    {
      id: "rec_mg_prev_1",
      fields: {
        "Member 1": ["rec_m_01", "rec_m_02", "rec_m_03"],
        "Introduction date": "2026-05-25",
        Status: "Done/Sent",
        Source: "recurring-intros",
      },
    },
    {
      id: "rec_mg_prev_2",
      fields: {
        "Member 1": ["rec_m_04", "rec_m_05", "rec_m_06"],
        "Introduction date": "2026-05-25",
        Status: "Done/Sent",
        Source: "recurring-intros",
      },
    },
  ];

  const airtable = createMockAirtable(matchGroupRecords);
  const slack = createMockSlack();

  const result = await runRecurringCityIntros(
    {
      airtable,
      slack,
      now: () => new Date("2026-06-01T10:00:00Z"),
      mode: "preview",
      writesEnabled: false,
      
      
      
      allowedChannelIds: null,
    },
    { cycleDate: "2026-06-08T10:00:00Z" }
  );

  console.log(`\n  Summary: ${result.summary}`);
  for (const p of result.previews) {
    const preview = p as {
      channelName: string;
      cityName: string;
      cycleId: string;
      recentRepeatWarnings: string[];
      proposedGroups: { members: { name: string }[] }[];
    };
    console.log(`  Channel: ${preview.channelName} (${preview.cityName})`);
    console.log(`  Cycle ID: ${preview.cycleId}`);

    if (preview.recentRepeatWarnings?.length) {
      console.log(`  Repeat warnings:`);
      for (const w of preview.recentRepeatWarnings) {
        console.log(`    ⚠ ${w}`);
      }
    } else {
      console.log(`  No repeat warnings (fresh groupings found)`);
    }

    console.log(`\n  Groups:`);
    for (let i = 0; i < preview.proposedGroups.length; i++) {
      const g = preview.proposedGroups[i];
      const names = g.members.map((m) => m.name).join(", ");
      console.log(`    Group ${i + 1}: ${names}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Recurring City Intros — Self-Contained Mock Test");
  console.log(`Members: ${FAKE_MEMBERS.airtable.length} fake records (${FAKE_MEMBERS.slack.length} Slack users)`);
  console.log(`Eligible: 8 (1 unpaid, 1 excluded, 1 paused, 1 missing from Slack scenario via email gap)`);

  await scenarioA_Preview();
  await scenarioB_SendMock();
  await scenarioC_RepeatPrevention();

  separator("Done — all scenarios completed (no real Airtable or Slack calls made)");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
