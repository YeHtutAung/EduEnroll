import { describe, it, expect } from "vitest";
import {
  fitWithin,
  MAX_EDGE,
  MAX_EDGE_LOGO,
  SKIP_BELOW_BYTES,
  downscaleImage,
} from "@/lib/images/downscale";

// The canvas round-trip needs a real browser, so these cover the parts that
// decide behaviour: the ratio maths, and the bail-outs that must return the
// original file rather than throw.

describe("fitWithin", () => {
  it("preserves the source aspect ratio when it scales down", () => {
    // The flashtic poster: 1200x630, ~1.905:1. The ticket-artwork tests forbid
    // hard-coding a ratio, so resizing must not invent one.
    const before = 1200 / 630;
    const { width, height } = fitWithin(1200, 630, 800);
    expect(width).toBe(800);
    expect(Math.abs(width / height - before)).toBeLessThan(0.01);
  });

  it("scales by the LONGEST edge, portrait or landscape", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it("never upscales an image that already fits", () => {
    expect(fitWithin(400, 300, 1600)).toEqual({ width: 400, height: 300 });
    expect(fitWithin(1600, 900, 1600)).toEqual({ width: 1600, height: 900 });
  });

  it("keeps an extreme panorama at least one pixel tall", () => {
    const { height } = fitWithin(10000, 3, MAX_EDGE);
    expect(height).toBeGreaterThanOrEqual(1);
  });

  it("leaves degenerate dimensions alone rather than dividing by zero", () => {
    expect(fitWithin(0, 0, 1600)).toEqual({ width: 0, height: 0 });
  });
});

describe("downscaleImage bail-outs", () => {
  const fileOf = (name: string, type: string, bytes: number) =>
    new File([new Uint8Array(bytes)], name, { type });

  it("returns animated GIFs untouched — a canvas round-trip flattens them", async () => {
    const gif = fileOf("banner.gif", "image/gif", SKIP_BELOW_BYTES * 4);
    expect(await downscaleImage(gif)).toBe(gif);
  });

  it("leaves already-small files alone", async () => {
    const small = fileOf("icon.png", "image/png", 1024);
    expect(await downscaleImage(small)).toBe(small);
  });

  it("returns the original rather than throwing when decoding is unavailable", async () => {
    // jsdom has no real createImageBitmap/canvas encoder. An upload that cannot
    // be optimised must still succeed.
    const big = fileOf("poster.jpg", "image/jpeg", SKIP_BELOW_BYTES * 6);
    const out = await downscaleImage(big);
    expect(out).toBe(big);
  });
});

describe("per-type caps", () => {
  it("caps a logo at 512 so a 1080px upload stops being 180 KB", () => {
    expect(fitWithin(1080, 1080, MAX_EDGE_LOGO)).toEqual({ width: 512, height: 512 });
  });

  it("leaves full-width artwork room to stay sharp", () => {
    expect(fitWithin(1080, 1080, MAX_EDGE)).toEqual({ width: 1080, height: 1080 });
  });

  it("caps a logo by its longest edge, keeping the ratio", () => {
    const before = 1200 / 400;
    const { width, height } = fitWithin(1200, 400, MAX_EDGE_LOGO);
    expect(width).toBe(512);
    expect(Math.abs(width / height - before)).toBeLessThan(0.01);
  });
});
