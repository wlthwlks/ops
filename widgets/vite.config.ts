import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import { ANIMATION_SOURCE_FILES, ANIMATION_ASSET_DIR } from "./shared/animations";

const widget = process.env.WIDGET || "signup";

const ANIM_SRC_DIR = path.resolve(__dirname, "shared/assets/animations");

/** Copy all known .lottie animation files into each widget build output. */
function emitLottieAnimations(): Plugin {
  return {
    name: "emit-lottie-animations",
    apply: "build",
    generateBundle() {
      if (!fs.existsSync(ANIM_SRC_DIR)) {
        this.warn(`Animation source dir missing: ${ANIM_SRC_DIR}`);
        return;
      }
      // Emit every .lottie present + known list (so newly dropped files ship)
      const onDisk = fs
        .readdirSync(ANIM_SRC_DIR)
        .filter((f) => f.endsWith(".lottie"));
      const files = Array.from(
        new Set<string>([...ANIMATION_SOURCE_FILES, ...onDisk])
      );
      for (const file of files) {
        const src = path.join(ANIM_SRC_DIR, file);
        if (!fs.existsSync(src)) {
          this.warn(`Missing Lottie asset (skipped): ${src}`);
          continue;
        }
        this.emitFile({
          type: "asset",
          fileName: `${ANIMATION_ASSET_DIR}/${file}`,
          source: fs.readFileSync(src),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), emitLottieAnimations()],
  publicDir: false,
  assetsInclude: ["**/*.lottie"],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    emptyOutDir: true,
    outDir: path.resolve(__dirname, `../public/widgets/${widget}/v1`),
    lib: {
      entry: path.resolve(__dirname, `${widget}/src/main.tsx`),
      name: widget === "signup" ? "WlthSignup" : "WlthUpdateDetails",
      formats: ["iife"],
      fileName: () => (widget === "signup" ? "signup.js" : "update-details.js"),
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => {
          const name = assetInfo.names?.[0] || assetInfo.name || "";
          if (name.endsWith(".css") || assetInfo.name?.endsWith(".css")) {
            return widget === "signup" ? "signup.css" : "update-details.css";
          }
          if (name.endsWith(".lottie") || assetInfo.name?.endsWith(".lottie")) {
            return `${ANIMATION_ASSET_DIR}/[name][extname]`;
          }
          return "assets/[name]-[hash][extname]";
        },
      },
    },
    cssCodeSplit: false,
    assetsInlineLimit: 0,
  },
});
