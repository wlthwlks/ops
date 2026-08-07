/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ABLE_TRACKING_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Inlined by widgets/vite.config.ts `inline-lottie-assets` plugin */
declare module "*.lottie" {
  const data: ArrayBuffer;
  export default data;
}

declare module "*.lottie?url" {
  const src: string;
  export default src;
}
