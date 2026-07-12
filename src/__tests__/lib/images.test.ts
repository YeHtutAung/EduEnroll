import { describe, it, expect } from "vitest";
import { sniffImageMime } from "@/lib/images";

describe("sniffImageMime", () => {
  it("detects JPEG", () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("image/jpeg");
  });

  it("detects PNG", () => {
    expect(
      sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])),
    ).toBe("image/png");
  });

  it("detects WebP (RIFF....WEBP)", () => {
    const buf = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WEBP", "ascii"),
    ]);
    expect(sniffImageMime(buf)).toBe("image/webp");
  });

  it("rejects a non-image payload (e.g. HTML/script masquerading as an image)", () => {
    expect(sniffImageMime(Buffer.from("<script>alert(1)</script>", "utf8"))).toBeNull();
    expect(sniffImageMime(Buffer.from("%PDF-1.7", "utf8"))).toBeNull();
    expect(sniffImageMime(Buffer.from("GIF89a", "utf8"))).toBeNull(); // GIF not allowed
  });

  it("rejects a RIFF container that is not WebP (e.g. WAV)", () => {
    const wav = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WAVE", "ascii"),
    ]);
    expect(sniffImageMime(wav)).toBeNull();
  });

  it("rejects truncated/too-short buffers", () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffImageMime(Buffer.from([]))).toBeNull();
  });
});
