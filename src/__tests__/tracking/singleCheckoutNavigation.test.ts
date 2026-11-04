import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A fast double click on Buy must push one begin_checkout and write one stash.
// Each checkout handler on a tracked page claims a per-component ref first
// (claimNavigation in tagManager.ts) and returns if it was already claimed.
// Static check: the claim is the handler's first guard.

const CASES: [string, string][] = [
  ["src/app/(public)/enroll/[slug]/page.tsx", "handleSelectClass"],
  ["src/app/(public)/enroll/[slug]/page.tsx", "handleCartCheckout"],
  ["src/components/enrollment/templates/EvTrustedOfficialTemplate.tsx", "handleCheckout"],
];

function handlerBody(src: string, name: string): string | null {
  const start = src.search(new RegExp(String.raw`function\s+${name}\s*\(`));
  if (start < 0) return null;
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

describe("checkout handlers navigate once", () => {
  it.each(CASES)("%s: %s claims navigation before any side effect", (file, name) => {
    const body = handlerBody(readFileSync(join(process.cwd(), file), "utf8"), name);
    expect(body, `${name} not found`).not.toBeNull();
    const claim = body!.search(/claimNavigation\s*\(/);
    expect(claim, "claimNavigation call").toBeGreaterThanOrEqual(0);
    for (const effect of [/sessionStorage\s*\.\s*setItem/, /hardNavigate\s*\(/, /pushDataLayer\s*\(/]) {
      const at = body!.search(effect);
      if (at >= 0) expect(at, String(effect)).toBeGreaterThan(claim);
    }
  });
});
