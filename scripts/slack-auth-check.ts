/**
 * READ-ONLY Slack token check. Confirms SLACK_BOT_TOKEN is valid and reports
 * which workspace/bot it's tied to (auth.test). Optionally verifies the
 * users:read.email scope with one lookup. Makes no posts, opens no DMs.
 *
 * Usage:
 *   npx tsx scripts/slack-auth-check.ts                 # auth.test only
 *   npx tsx scripts/slack-auth-check.ts you@email.com   # also test a lookup
 */
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.development.local" });

const SLACK_API = "https://slack.com/api";

async function slackGet(method: string, token: string, params: Record<string, string> = {}) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("✗ SLACK_BOT_TOKEN is not set.");
    process.exit(1);
  }
  console.log(`Token prefix: ${token.slice(0, 5)}…  length: ${token.length}`);

  // 1. auth.test — the definitive "is this token alive" check.
  const auth = await slackGet("auth.test", token);
  if (!auth.ok) {
    console.error(`✗ auth.test failed: ${auth.error}`);
    if (auth.error === "account_inactive") {
      console.error("  → The app was removed from the workspace, or the token was revoked.");
      console.error("  → Reinstall: https://api.slack.com/apps/A0B7861TNM9/oauth");
    }
    if (auth.error === "invalid_auth") {
      console.error("  → Token is wrong/expired. Copy the fresh Bot User OAuth Token (xoxb-).");
    }
    process.exit(1);
  }
  console.log("✓ auth.test OK");
  console.log(`  workspace: ${auth.team} (${auth.team_id})`);
  console.log(`  bot user:  ${auth.user} (${auth.user_id})`);
  console.log(`  url:       ${auth.url}`);

  // 2. Optional scope check — users:read.email
  const email = process.argv[2];
  if (email) {
    const lookup = await slackGet("users.lookupByEmail", token, { email });
    if (lookup.ok) {
      const u = lookup.user as { id: string; real_name?: string; name?: string };
      console.log(`✓ users.lookupByEmail OK — ${email} → ${u.real_name || u.name} (${u.id})`);
    } else if (lookup.error === "users_not_found") {
      console.log(`✓ users.lookupByEmail scope OK — ${email} simply isn't in the workspace (expected for many members)`);
    } else if (lookup.error === "missing_scope") {
      console.error(`✗ Missing scope for users.lookupByEmail — add 'users:read.email' and reinstall.`);
      process.exit(1);
    } else {
      console.error(`✗ users.lookupByEmail failed: ${lookup.error}`);
      process.exit(1);
    }
  } else {
    console.log("(pass an email arg to also verify the users:read.email scope)");
  }

  console.log("\nAll good — re-run Preview on /get-matched and Slack lookups should resolve.");
}

main();
