import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { STORAGE_CACHE_CONTROL } from "@/lib/storage/cache";

// Supabase serves `Cache-Control: no-cache` when an upload omits one, which is
// what it was doing in production: every visit re-downloaded every image. These
// guard the two properties that make the fix correct — a long TTL, applied
// everywhere — because a new upload path added without it silently reintroduces
// the bug and nothing else would notice.

const UPLOAD_SITES = [
  "src/app/admin/intakes/page.tsx",
  "src/app/admin/intakes/[id]/page.tsx",
  "src/app/admin/settings/page.tsx",
  "src/app/api/admin/appearance/upload/route.ts",
];

const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf8");

describe("storage cache policy", () => {
  it("is long enough to be worth having", () => {
    // Anything short leaves buyers on slow connections re-downloading artwork.
    expect(Number(STORAGE_CACHE_CONTROL)).toBeGreaterThanOrEqual(60 * 60 * 24 * 30);
  });

  it("is a string of seconds — Supabase rejects anything else", () => {
    expect(typeof STORAGE_CACHE_CONTROL).toBe("string");
    expect(STORAGE_CACHE_CONTROL).toMatch(/^\d+$/);
  });

  it.each(UPLOAD_SITES)("every storage upload in %s sets a cache policy", (file) => {
    const source = read(file);
    const uploads = (source.match(/\.upload\(/g) ?? []).length;
    const cached = (source.match(/cacheControl: STORAGE_CACHE_CONTROL/g) ?? []).length;

    expect(uploads).toBeGreaterThan(0);
    expect(
      cached,
      `${file} has ${uploads} .upload() call(s) but ${cached} with a cache policy. ` +
        "An upload without one serves Cache-Control: no-cache.",
    ).toBe(uploads);
  });
});
