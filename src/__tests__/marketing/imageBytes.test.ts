import { describe, it, expect } from "vitest";
import { detectImage } from "@/lib/marketing/imageBytes";

const png = (w: number, h: number) => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};

// SOI, an APP0 segment to skip, then SOF2 (progressive).
const jpeg = (w: number, h: number) =>
  new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc2, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255,
  ]);

const riff = (fourcc: string, payload: number[]) =>
  new Uint8Array([
    ..."RIFF".split("").map((c) => c.charCodeAt(0)),
    0, 0, 0, 0,
    ..."WEBP".split("").map((c) => c.charCodeAt(0)),
    ...fourcc.split("").map((c) => c.charCodeAt(0)),
    0, 0, 0, 0,
    ...payload,
  ]);

describe("detectImage", () => {
  it("reads PNG", () => {
    expect(detectImage(png(640, 480))).toEqual({ mime: "image/png", ext: "png", width: 640, height: 480 });
  });

  it("reads JPEG past leading segments", () => {
    expect(detectImage(jpeg(1200, 800))).toEqual({ mime: "image/jpeg", ext: "jpg", width: 1200, height: 800 });
  });

  it("reads lossy WebP", () => {
    // 3-byte frame tag, 9d 01 2a, then 14-bit width and height.
    const bytes = riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]);
    expect(detectImage(bytes)).toEqual({ mime: "image/webp", ext: "webp", width: 640, height: 480 });
  });

  it("reads lossless WebP", () => {
    // Signature 0x2f, then width-1 and height-1 in 14 bits each: 640x480.
    const bits = 639 | (479 << 14);
    const bytes = riff("VP8L", [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255]);
    expect(detectImage(bytes)).toEqual({ mime: "image/webp", ext: "webp", width: 640, height: 480 });
  });

  it("reads extended WebP", () => {
    // Flags and reserved (4 bytes), then 24-bit width-1 and height-1.
    const bytes = riff("VP8X", [0, 0, 0, 0, 0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00]);
    expect(detectImage(bytes)).toEqual({ mime: "image/webp", ext: "webp", width: 640, height: 480 });
  });

  it.each([
    ["SVG", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ["GIF", new TextEncoder().encode("GIF89a........")],
    ["HTML", new TextEncoder().encode("<!doctype html><script>")],
    ["empty", new Uint8Array()],
    ["truncated PNG", png(1, 1).slice(0, 12)],
    ["truncated JPEG", new Uint8Array([0xff, 0xd8, 0xff, 0xc0])],
    ["zero-size PNG", png(0, 10)],
  ])("rejects %s", (_name, bytes) => {
    expect(detectImage(bytes)).toBeNull();
  });
});
