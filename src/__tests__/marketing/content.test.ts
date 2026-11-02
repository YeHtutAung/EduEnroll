import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { marketingImageSrc } from "@/lib/marketing/content";

describe("marketingImageSrc", () => {
  const saved = process.env.NEXT_PUBLIC_SUPABASE_URL;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = saved;
  });

  it("returns a static path unchanged", () => {
    expect(marketingImageSrc({ kind: "static", path: "/marketing/hero.jpg", width: 1, height: 1 })).toBe(
      "/marketing/hero.jpg",
    );
  });

  it("builds a bucket URL from the current environment's host", () => {
    expect(marketingImageSrc({ kind: "bucket", path: "x.png", width: 1, height: 1 })).toBe(
      "https://abc.supabase.co/storage/v1/object/public/marketing-assets/x.png",
    );
  });
});
