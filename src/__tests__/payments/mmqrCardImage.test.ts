import { describe, it, expect } from "vitest";
import { hasDarkPixels } from "@/components/payments/mmqrCardImage";

// The export itself needs a real canvas, which this project's node test
// environment does not have. This pins the check that stops a framed image with
// a missing code from being handed to the payer.
describe("hasDarkPixels", () => {
  it("rejects an all-white area, which is what an undecoded QR looks like", () => {
    expect(hasDarkPixels([255, 255, 255, 255, 255, 255, 255, 255])).toBe(false);
  });

  it("accepts an area holding QR modules", () => {
    expect(hasDarkPixels([255, 255, 255, 255, 0, 0, 0, 255])).toBe(true);
  });

  it("ignores transparent pixels", () => {
    expect(hasDarkPixels([0, 0, 0, 0])).toBe(false);
  });

  it("ignores coloured pixels", () => {
    expect(hasDarkPixels([251, 217, 19, 255])).toBe(false);
  });
});
