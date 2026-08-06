/**
 * Fail CI when prohibited/sensitive paths are tracked in git.
 * Never prints full secret values.
 *
 *   npx tsx scripts/check-sensitive-files.ts
 */
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const PROHIBITED_PATH_PREFIXES = [
  ".env",
  "reports/",
  "tmp/",
  "test-results/",
  "drizzle-backup-before-ledger-migration/",
  "__MACOSX/",
];

const PROHIBITED_BASENAMES = [".DS_Store", ".env", ".env.local", ".env.production"];

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "stripe_live_key", re: /sk_live_[A-Za-z0-9]{10,}/ },
  { name: "stripe_webhook", re: /whsec_[A-Za-z0-9]{10,}/ },
  { name: "slack_bot", re: /xoxb-[A-Za-z0-9-]{10,}/ },
];

function trackedFiles(): string[] {
  try {
    const out = execSync("git ls-files -z", { encoding: "buffer" });
    return out
      .toString("utf8")
      .split("\0")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    console.error("git ls-files failed — run from a git checkout");
    process.exit(2);
  }
}

function isProhibitedPath(file: string): boolean {
  const base = file.split("/").pop() || file;
  if (PROHIBITED_BASENAMES.includes(base)) {
    if (file === ".env.example" || file.endsWith("/.env.example")) return false;
    return true;
  }
  if (file === ".env.example") return false;
  for (const p of PROHIBITED_PATH_PREFIXES) {
    if (p === ".env") {
      if (file === ".env" || file.startsWith(".env.") && !file.endsWith(".example")) {
        if (file === ".env.example") continue;
        return true;
      }
      continue;
    }
    if (file === p.replace(/\/$/, "") || file.startsWith(p)) return true;
  }
  return false;
}

function main() {
  const files = trackedFiles();
  const badPaths: string[] = [];
  const secretHits: Array<{ file: string; kind: string }> = [];

  for (const file of files) {
    if (isProhibitedPath(file)) badPaths.push(file);

    // Skip large/binary and example env
    if (file === ".env.example") continue;
    if (/\.(png|jpg|jpeg|gif|webp|lottie|woff2?|ttf|ico)$/i.test(file)) continue;

    const abs = join(process.cwd(), file);
    if (!existsSync(abs)) continue;
    let content = "";
    try {
      const buf = readFileSync(abs);
      if (buf.length > 512_000) continue;
      content = buf.toString("utf8");
    } catch {
      continue;
    }
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(content)) {
        secretHits.push({ file, kind: name });
      }
    }
  }

  let failed = false;
  if (badPaths.length) {
    failed = true;
    console.error("Prohibited paths are tracked in git:");
    for (const p of badPaths.slice(0, 50)) console.error(`  - ${p}`);
    if (badPaths.length > 50) console.error(`  … and ${badPaths.length - 50} more`);
  }
  if (secretHits.length) {
    failed = true;
    console.error("Possible secret patterns found in tracked files (values redacted):");
    for (const h of secretHits.slice(0, 30)) {
      console.error(`  - ${h.file} [${h.kind}]`);
    }
  }

  if (failed) {
    console.error(
      "\nFix: remove from the index (git rm --cached …), update .gitignore, rotate any exposed secrets."
    );
    process.exit(1);
  }
  console.log("security:check-files OK — no prohibited tracked paths or secret patterns.");
}

main();
