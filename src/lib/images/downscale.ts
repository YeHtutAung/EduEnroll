// ─── Downscale uploads before they reach storage ─────────────────────────────
// Admin uploads went to Supabase at full camera resolution. On 2026-09-06 the
// live event's artwork was 218 KB, 432 KB and 579 KB — the largest is over five
// minutes on a 2 KB/s mobile connection, and buyers in Myanmar saw broken-image
// icons instead of ticket artwork.
//
// Fixing it at upload rather than at render is deliberate: the same file is
// consumed by the web page, the e-ticket PDF, the html2canvas capture and the
// confirmation email. A render-time optimiser only helps the first of those.
// It also avoids hard-coding an aspect ratio, which the ticket-artwork tests
// forbid — resizing preserves the source ratio exactly.

/** Longest edge for artwork shown full-width (ticket posters, hero images). */
export const MAX_EDGE = 1600;

/**
 * Logos are displayed between 30px and 64px, so 1600 is pointless headroom.
 * Measured on the live tenant logo (1080x1080, 219 KB):
 *   1600 -> 180 KB    512 -> 59 KB    384 -> 38 KB
 * 512 keeps it crisp on a 3x display and still cuts 73%.
 */
export const MAX_EDGE_LOGO = 512;
/** Re-encode quality. 0.78 is where these photographs stop shrinking usefully. */
export const QUALITY = 0.78;
/** Below this, re-encoding usually costs more bytes than it saves. */
export const SKIP_BELOW_BYTES = 100 * 1024;

/**
 * Scale a width/height down so the longest edge is at most `maxEdge`,
 * preserving the aspect ratio. Returns the input unchanged when it already
 * fits — never upscales.
 *
 * Pure and exported so the ratio behaviour is testable without a canvas.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = MAX_EDGE,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width, height };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Pick the output encoding.
 *
 * WebP is smaller than both JPEG and PNG and keeps alpha, so a transparent
 * logo does not gain a black background — the failure a naive JPEG conversion
 * produces. Falls back to the source type when the browser cannot encode WebP.
 */
function outputType(sourceType: string, canWebp: boolean): string {
  if (canWebp) return "image/webp";
  return sourceType === "image/png" ? "image/png" : "image/jpeg";
}

function extensionFor(mime: string): string {
  if (mime === "image/webp") return "webp";
  if (mime === "image/png") return "png";
  return "jpg";
}

function renameTo(original: string, mime: string): string {
  const base = original.replace(/\.[^.]+$/, "") || "image";
  return `${base}.${extensionFor(mime)}`;
}

/**
 * Downscale and re-encode an image chosen in an admin file picker.
 *
 * Returns the ORIGINAL file unchanged, rather than throwing, when it cannot
 * safely improve on it:
 *   - animated GIFs, which a canvas round-trip would flatten to one frame
 *   - files already small enough to not be the problem
 *   - any browser/decoder failure — an un-optimised upload beats a failed one
 *
 * Callers can therefore treat this as best-effort and never guard it.
 */
export async function downscaleImage(
  file: File,
  maxEdge: number = MAX_EDGE,
): Promise<File> {
  if (file.type === "image/gif") return file;
  if (file.size <= SKIP_BELOW_BYTES) return file;
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return file;

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const canWebp = canvas.toDataURL("image/webp").startsWith("data:image/webp");
    const mime = outputType(file.type, canWebp);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mime, QUALITY),
    );
    // Keep whichever is actually smaller. Re-encoding an already-optimised
    // image can grow it, and shipping a bigger file would defeat the point.
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], renameTo(file.name, mime), {
      type: mime,
      lastModified: Date.now(),
    });
  } catch {
    return file;
  }
}
