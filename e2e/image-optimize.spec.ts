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

test("optimizeImageFile converts a large PNG to webp under 2MB", async ({ page }) => {
  await page.goto("about:blank");

  const result = await page.evaluate(async (b64) => {
    const dataUrl = "data:text/javascript;base64," + b64;
    const mod = await import(dataUrl);
    const { optimizeImageFile } = mod as {
      optimizeImageFile: (f: File) => Promise<File>;
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

    const pngBlob: Blob = await new Promise((res) =>
      canvas.toBlob((b) => res(b!), "image/png")
    );
    const file = new File([pngBlob], "photo.png", { type: "image/png" });

    const out = await optimizeImageFile(file);
    return { type: out.type, size: out.size, name: out.name };
  }, B64);

  expect(result.type).toBe("image/webp");
  expect(result.size).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(result.name).toMatch(/\.webp$/);
});
