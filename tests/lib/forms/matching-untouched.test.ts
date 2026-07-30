import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * Regression guard: forms code must not import matching/intro/pinecone engines.
 */
function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

describe("forms must not touch matching/introductions", () => {
  it("src/lib/forms does not import matchmake/matching/pinecone/intro engines", () => {
    const root = join(process.cwd(), "src/lib/forms");
    const files = walk(root);
    expect(files.length).toBeGreaterThan(0);
    const banned = [
      "@/lib/matching",
      "@/lib/matchmake",
      "@/lib/messaging",
      "@/lib/ops/daily-match-message",
      "@/lib/ops/recurring-city-intros",
      "@/lib/ops/sync-to-pinecone",
      "@/lib/integrations/pinecone",
      "@/lib/introduction/history",
      "@/lib/introduction/reservations",
      "@/lib/introduction/quality",
    ];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const b of banned) {
        expect(src, `${file} imports ${b}`).not.toContain(b);
      }
    }
  });

  it("protected matching entrypoints still exist", () => {
    const mustExist = [
      "src/lib/matching/transforms.ts",
      "src/lib/matchmake/select-fresh-matches.ts",
      "src/lib/ops/daily-match-message.ts",
      "src/lib/ops/recurring-city-intros.ts",
      "src/lib/integrations/pinecone.ts",
      "src/app/api/get-matched/route.ts",
      "src/app/api/send-match-intros/route.ts",
    ];
    for (const p of mustExist) {
      expect(statSync(join(process.cwd(), p)).isFile()).toBe(true);
    }
  });
});
