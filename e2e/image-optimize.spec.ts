import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import ts from "typescript";

const SOURCE = readFileSync(
  resolve(process.cwd(), "widgets/shared/image-optimize.ts"),
  "utf8"
);
const ESM = ts.transpileModule(SOURCE, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2019,
  },
}).outputText;

const B64 = Buffer.from(ESM, "utf8").toString("base64");

test("optimizeImageVariants returns distinct full + thumb webp for a large image", async ({
  page,
}) => {
  await page.goto("about:blank");

  const result = await page.evaluate(async (b64) => {
    const mod = await import("data:text/javascript;base64," + b64);
    const { optimizeImageVariants } = mod as {
      optimizeImageVariants: (f: File) => Promise<{ full: File; thumb: File; same: boolean }>;
    };

    const canvas = document.createElement("canvas");
    canvas.width = 3000;
    canvas.height = 3000;
    const ctx = canvas.getContext("2d")!;
    const imageData = ctx.createImageData(3000, 3000);
    const d = imageData.data;
    let seed = 123456789;
    for (let i = 0; i < d.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = seed & 0xff;
      d[i + 1] = (seed >> 8) & 0xff;
      d[i + 2] = (seed >> 16) & 0xff;
      d[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
    const pngBlob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), "image/png"));
    const file = new File([pngBlob], "photo.png", { type: "image/png" });

    const v = await optimizeImageVariants(file);
    return {
      fullType: v.full.type,
      fullSize: v.full.size,
      thumbType: v.thumb.type,
      thumbSize: v.thumb.size,
      same: v.same,
    };
  }, B64);

  expect(result.fullType).toBe("image/webp");
  expect(result.thumbType).toBe("image/webp");
  expect(result.same).toBe(false);
  expect(result.fullSize).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(result.thumbSize).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(result.thumbSize).toBeLessThan(result.fullSize);
});

test("optimizeImageVariants reuses a single blob for a tiny image", async ({ page }) => {
  await page.goto("about:blank");

  const result = await page.evaluate(async (b64) => {
    const mod = await import("data:text/javascript;base64," + b64);
    const { optimizeImageVariants } = mod as {
      optimizeImageVariants: (f: File) => Promise<{ full: File; thumb: File; same: boolean }>;
    };

    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#3a6";
    ctx.fillRect(0, 0, 200, 200);
    const pngBlob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), "image/png"));
    const file = new File([pngBlob], "tiny.png", { type: "image/png" });

    const v = await optimizeImageVariants(file);
    return { same: v.same, equal: v.full === v.thumb, type: v.full.type };
  }, B64);

  expect(result.same).toBe(true);
  expect(result.equal).toBe(true);
  expect(result.type).toBe("image/webp");
});
