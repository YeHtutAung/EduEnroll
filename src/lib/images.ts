// ─── Image content sniffing ─────────────────────────────────────────────────
// Detects the real image type from a file's leading "magic bytes" so callers do
// not have to trust a client-provided Content-Type (which can be spoofed to
// smuggle non-image content past a MIME allow-list).

export type SniffedImageMime = "image/jpeg" | "image/png" | "image/webp";

export function sniffImageMime(buf: Buffer): SniffedImageMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return "image/png";
  }
  // RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}
