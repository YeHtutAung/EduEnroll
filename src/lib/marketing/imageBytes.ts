// ─── Image type and size, from the file's own bytes ──────────────────────────
// The declared type and filename are never trusted. SVG isn't recognised on
// purpose: it can carry scripts.

export type DetectedImage = {
  mime: "image/jpeg" | "image/png" | "image/webp";
  ext: "jpg" | "png" | "webp";
  width: number;
  height: number;
};

const ascii = (b: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...b.subarray(offset, offset + length));

function detectPng(b: Uint8Array, view: DataView): DetectedImage | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !signature.every((v, i) => b[i] === v) || ascii(b, 12, 4) !== "IHDR") return null;
  return { mime: "image/png", ext: "png", width: view.getUint32(16), height: view.getUint32(20) };
}

function detectJpeg(b: Uint8Array, view: DataView): DetectedImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // SOF0-15, except DHT (C4), JPG (C8) and DAC (CC), carry the dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { mime: "image/jpeg", ext: "jpg", height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    }
    const length = view.getUint16(i + 2);
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

function detectWebp(b: Uint8Array, view: DataView): DetectedImage | null {
  if (b.length < 25 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const base = { mime: "image/webp", ext: "webp" } as const;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { ...base, width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = view.getUint32(21, true);
    return { ...base, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    if (b.length < 30) return null;
    const u24 = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
    return { ...base, width: u24(24) + 1, height: u24(27) + 1 };
  }
  return null;
}

export function detectImage(bytes: Uint8Array): DetectedImage | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = detectPng(bytes, view) ?? detectJpeg(bytes, view) ?? detectWebp(bytes, view);
  return found && found.width > 0 && found.height > 0 ? found : null;
}
