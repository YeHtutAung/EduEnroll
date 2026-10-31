import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A static source scan. Tracked pages (GTM may run there) must never receive an
// enrollment ref or anything exchangeable for one: the cart idempotency key makes
// submit_cart_enrollment return the existing order, ref included. Order creation
// therefore lives on the untracked /checkout/new page. This fails if order creation
// or its key ever moves back.
// Design: docs/superpowers/specs/2026-10-30-tenant-gtm-design.md
//
// This scan is a TRIPWIRE, NOT A PROOF. It reads source as text and catches the
// usual ways order creation or its key could come back; code written to dodge
// it would pass. Review still matters.

const ROOT = process.cwd();
const TRACKED_PAGES = [
  "src/app/(public)/enroll/page.tsx",
  "src/app/(public)/enroll/[slug]/page.tsx",
  "src/app/(public)/enroll/[slug]/tickets/page.tsx",
];
const TEMPLATES_DIR = "src/components/enrollment/templates";

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

export function scanSource(src: string): string[] {
  const code = stripComments(src);
  const findings: string[] = [];
  // A fetch to the enroll endpoint whose options name POST.
  for (const m of code.matchAll(/fetch\s*\(\s*([`"'])\/api\/public\/enroll\b[\s\S]*?\)\s*;?/g)) {
    if (/method\s*:\s*["'`]POST["'`]/i.test(m[0])) findings.push("POST fetch to /api/public/enroll");
  }
  if (/enrollment_ref/.test(code)) findings.push("enrollment_ref");
  if (/idempotency_key/.test(code)) findings.push("idempotency_key");
  if (/\brandomId\b/.test(code)) findings.push("randomId");
  // The order-creation module belongs to /checkout/new only.
  if (/from\s+["'][^"']*\/trustedOfficialCheckout["']|import\s*\(\s*["'][^"']*\/trustedOfficialCheckout["']/.test(code)) {
    findings.push("imports trustedOfficialCheckout");
  }
  return findings;
}

function files(): { label: string; path: string }[] {
  const out = TRACKED_PAGES.map((p) => ({ label: p, path: join(ROOT, p) }));
  for (const f of readdirSync(join(ROOT, TEMPLATES_DIR)).filter((n) => n.endsWith(".tsx"))) {
    out.push({ label: `${TEMPLATES_DIR}/${f}`, path: join(ROOT, TEMPLATES_DIR, f) });
  }
  return out;
}

describe("tracked pages never create orders or touch refs and keys", () => {
  for (const f of files()) {
    it(f.label, () => {
      expect(scanSource(readFileSync(f.path, "utf8"))).toEqual([]);
    });
  }

  it("scans the expected set of files", () => {
    const labels = files().map((f) => f.label);
    expect(labels.length).toBeGreaterThanOrEqual(3 + 12);
    expect(labels).toContain(`${TEMPLATES_DIR}/EvTrustedOfficialTemplate.tsx`);
  });
});

describe("the scanner itself", () => {
  it("flags a POST fetch to the enroll endpoint", () => {
    expect(scanSource('await fetch("/api/public/enroll", { method: "POST", body: x });')).toHaveLength(1);
    expect(scanSource("fetch(`/api/public/enroll`, {\n headers: h,\n method: 'POST' })")).toHaveLength(1);
  });

  it("does not flag a GET or an unrelated POST", () => {
    expect(scanSource('fetch("/api/public/enroll?x=1")')).toEqual([]);
    expect(scanSource('fetch("/api/other", { method: "POST" })')).toEqual([]);
  });

  it("flags enrollment_ref, idempotency_key and randomId", () => {
    expect(scanSource("const r = data.enrollment_ref;")).toEqual(["enrollment_ref"]);
    expect(scanSource("body = { idempotency_key: k }")).toEqual(["idempotency_key"]);
    expect(scanSource('import { randomId } from "@/lib/randomId";\nrandomId();')).toEqual(["randomId"]);
  });

  it("flags importing the order-creation module", () => {
    expect(
      scanSource('import { parseCartStash } from "@/lib/enrollment/trustedOfficialCheckout";'),
    ).toEqual(["imports trustedOfficialCheckout"]);
    expect(scanSource('import x from "../../lib/enrollment/trustedOfficialCheckout";')).toEqual([
      "imports trustedOfficialCheckout",
    ]);
    expect(scanSource('const m = await import("@/lib/enrollment/trustedOfficialCheckout");')).toEqual([
      "imports trustedOfficialCheckout",
    ]);
    expect(scanSource('import { x } from "@/lib/enrollment/other";')).toEqual([]);
  });

  it("ignores commented-out code and prose comments", () => {
    expect(scanSource("// idempotency_key randomId enrollment_ref\n/* randomId() */")).toEqual([]);
  });
});
