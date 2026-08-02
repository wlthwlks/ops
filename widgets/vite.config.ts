import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import {
  ANIMATION_SOURCE_FILES,
  ANIMATION_ASSET_DIR,
} from "./shared/animations-meta";

const widget = process.env.WIDGET || "signup";

const ANIM_SRC_DIR = path.resolve(__dirname, "shared/assets/animations");

/**
 * Inline .lottie files as ArrayBuffer ES modules so the widget IIFE
 * does not need a separate network request to play animations.
 */
function inlineLottieAssets(): Plugin {
  return {
    name: "inline-lottie-assets",
    enforce: "pre",
    load(id) {
      const file = id.split("?")[0] || id;
      if (!file.endsWith(".lottie")) return null;
      if (!fs.existsSync(file)) return null;
      const b64 = fs.readFileSync(file).toString("base64");
      // Export a fresh ArrayBuffer each evaluation site can slice
      return `
const _b64 = ${JSON.stringify(b64)};
function _toBuf() {
  const bin = atob(_b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
export default _toBuf();
`;
    },
  };
}

/** Also emit loose .lottie files next to the JS for optional CDN/debug use. */
function emitLottieAnimations(): Plugin {
  return {
    name: "emit-lottie-animations",
    apply: "build",
    generateBundle() {
      if (!fs.existsSync(ANIM_SRC_DIR)) return;
      const onDisk = fs
        .readdirSync(ANIM_SRC_DIR)
        .filter((f) => f.endsWith(".lottie"));
      const files = Array.from(
        new Set<string>([...ANIMATION_SOURCE_FILES, ...onDisk])
      );
      for (const file of files) {
        const src = path.join(ANIM_SRC_DIR, file);
        if (!fs.existsSync(src)) continue;
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
  plugins: [inlineLottieAssets(), react(), emitLottieAnimations()],
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
          return "assets/[name]-[hash][extname]";
        },
      },
    },
    cssCodeSplit: false,
    assetsInlineLimit: 0,
  },
});
