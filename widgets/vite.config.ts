import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const widget = process.env.WIDGET || "signup";

export default defineConfig({
  plugins: [react()],
  publicDir: false,
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
        assetFileNames: () =>
          widget === "signup" ? "signup.css" : "update-details.css",
      },
    },
    cssCodeSplit: false,
  },
});
