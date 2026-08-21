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

async function slackPost(method: string, token: string, params: Record<string, string> = {}) {
  const body = new URLSearchParams(params).toString();
  return fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("✗ SLACK_BOT_TOKEN is not set.");
    process.exit(1);
  }
  console.log(`Token prefix: ${token.slice(0, 5)}…  length: ${token.length}`);

  // 1. auth.test — the definitive "is this token alive" check.
  const authRes = await slackPost("auth.test", token);
  const auth = (await authRes.json()) as Record<string, unknown>;
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

  const scopesHeader = authRes.headers.get("x-oauth-scopes") || "";
  const scopes = scopesHeader.split(",").map((s) => s.trim()).filter(Boolean);
  console.log(`  scopes:    ${scopes.length > 0 ? scopes.join(", ") : "(none reported)"}`);
  const communityScopes = [
    "users:read",
    "users:read.email",
    "channels:read",
    "groups:read",
    "groups:write",
    "channels:manage",
  ];
  const missing = communityScopes.filter((s) => !scopes.includes(s));
  if (missing.length > 0) {
    console.warn(`  ⚠ missing for community access operations: ${missing.join(", ")}`);
    console.warn("    → api.slack.com/apps/A0B7861TNM9 → OAuth & Permissions → add them, then reinstall on wlth-wlks.slack.com");
  } else {
    console.log("  ✓ all scopes needed for community access operations are present");
  }

  // 2. Optional scope check — users:read.email
  const email = process.argv[2];
  if (email) {
    const lookup = await slackPost("users.lookupByEmail", token, { email });
    const lookupJson = (await lookup.json()) as Record<string, unknown>;
    if (lookupJson.ok) {
      const u = lookupJson.user as { id: string; real_name?: string; name?: string };
      console.log(`✓ users.lookupByEmail OK — ${email} → ${u.real_name || u.name} (${u.id})`);
    } else if (lookupJson.error === "users_not_found") {
      console.log(`✓ users.lookupByEmail scope OK — ${email} simply isn't in the workspace (expected for many members)`);
    } else if (lookupJson.error === "missing_scope") {
      console.error(`✗ Missing scope for users.lookupByEmail — add 'users:read.email' and reinstall.`);
      process.exit(1);
    } else {
      console.error(`✗ users.lookupByEmail failed: ${lookupJson.error}`);
      process.exit(1);
    }
  } else {
    console.log("(pass an email arg to also verify the users:read.email scope)");
  }

  console.log("\nAll good — re-run Preview on /get-matched and Slack lookups should resolve.");
}

main();
