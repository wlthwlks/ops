/// <reference types="vite/client" />

declare module "*.lottie" {
  const src: string;
  export default src;
}

declare module "*.lottie?url" {
  const src: string;
  export default src;
}
