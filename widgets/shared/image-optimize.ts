/**
 * Browser-side image optimization before upload.
 * Converts any image to WebP (JPEG fallback), scales the longest side to a
 * max dimension, and iteratively lowers quality/size so the result stays
 * under a target byte size. Pure client-side — no server transformation cost.
 */

export type OptimizeOptions = {
  /** Longest side in pixels (never upscales). @default 1024 */
  maxDimension?: number;
  /** Ceiling for the output file size in bytes. @default 2 MB */
  targetBytes?: number;
  /** Preferred output MIME type. @default "image/webp" */
  outputType?: "image/webp" | "image/jpeg";
  /** Starting encode quality (0–1). @default 0.82 */
  startQuality?: number;
};

const DEFAULTS: Required<OptimizeOptions> = {
  maxDimension: 1024,
  targetBytes: 2 * 1024 * 1024,
  outputType: "image/webp",
  startQuality: 0.82,
};

export type ImageVariants = {
  full: File;
  thumb: File;
  /** true when thumb === full (source already fits the thumbnail size). */
  same: boolean;
};

export type VariantOptions = {
  /** Full-size longest side. @default 800 */
  fullMaxDimension?: number;
  /** Thumbnail longest side. @default 320 */
  thumbMaxDimension?: number;
  /** Ceiling per output in bytes. @default 2 MB */
  targetBytes?: number;
};

type LoadedImage = {
  source: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
};

async function loadImage(file: File): Promise<LoadedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height };
    } catch {
      /* fall through to HTMLImageElement */
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality);
    } catch {
      resolve(null);
    }
  });
}

function closeSource(source: ImageBitmap | HTMLImageElement): void {
  if (source instanceof ImageBitmap) {
    try {
      source.close();
    } catch {
      /* ignore */
    }
  }
}

async function encodeToFile(
  file: File,
  loaded: LoadedImage,
  maxDimension: number,
  targetBytes: number,
  startQuality: number,
  outputType: "image/webp" | "image/jpeg"
): Promise<File> {
  const srcW = loaded.width;
  const srcH = loaded.height;

  let currentType = outputType;
  let quality = startQuality;
  let scale = Math.min(1, maxDimension / Math.max(srcW, srcH));

  let blob: Blob | null = null;

  for (let attempt = 0; attempt < 12; attempt++) {
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available");
    ctx.drawImage(loaded.source, 0, 0, w, h);

    blob = await canvasToBlob(canvas, currentType, quality);

    if (!blob && currentType === "image/webp") {
      // WebP encoding unsupported — fall back to JPEG.
      currentType = "image/jpeg";
      blob = await canvasToBlob(canvas, currentType, quality);
    }

    if (blob && blob.size <= targetBytes) break;

    if (quality > 0.35) {
      quality = Math.max(0.35, quality - 0.12);
    } else {
      scale = Math.max(0.2, scale * 0.85);
      quality = startQuality;
    }
  }

  if (!blob) throw new Error("Could not optimize image");

  const ext = currentType === "image/webp" ? "webp" : "jpg";
  const base = (file.name || "photo").replace(/\.[^.]+$/, "");
  return new File([blob], `${base}.${ext}`, { type: currentType });
}

export async function optimizeImageFile(
  file: File,
  options?: OptimizeOptions
): Promise<File> {
  const opts = { ...DEFAULTS, ...options };
  const loaded = await loadImage(file);
  try {
    return await encodeToFile(
      file,
      loaded,
      opts.maxDimension,
      opts.targetBytes,
      opts.startQuality,
      opts.outputType
    );
  } finally {
    closeSource(loaded.source);
  }
}

export async function optimizeImageVariants(
  file: File,
  options?: VariantOptions
): Promise<ImageVariants> {
  const fullMax = options?.fullMaxDimension ?? 800;
  const thumbMax = options?.thumbMaxDimension ?? 320;
  const targetBytes = options?.targetBytes ?? 2 * 1024 * 1024;

  const loaded = await loadImage(file);
  try {
    // Already small enough for a thumbnail → one blob serves both roles.
    if (Math.max(loaded.width, loaded.height) <= thumbMax) {
      const single = await encodeToFile(file, loaded, fullMax, targetBytes, 0.82, "image/webp");
      return { full: single, thumb: single, same: true };
    }

    const full = await encodeToFile(file, loaded, fullMax, targetBytes, 0.82, "image/webp");
    const thumb = await encodeToFile(file, loaded, thumbMax, targetBytes, 0.82, "image/webp");
    return { full, thumb, same: false };
  } finally {
    closeSource(loaded.source);
  }
}
