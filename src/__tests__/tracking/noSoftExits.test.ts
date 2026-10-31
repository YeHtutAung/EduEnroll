import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { isTrackedPath } from "@/lib/tagManager";

// A static source scan. GTM runs only on tracked pages (see isTrackedPath). A
// client-side navigation from a tracked page to an untracked one would keep the
// GTM script alive on a page it must not be on, so every exit from a tracked
// page must be a full page load: a plain <a href> or hardNavigate().
// Design: docs/superpowers/specs/2026-10-30-tenant-gtm-design.md
//
// These scans are TRIPWIRES, NOT PROOFS. They read source as text and catch the
// usual ways a soft navigation gets written; code written to dodge them would
// pass. Review still matters.
//
// This test reads files as text. It flags:
//   - router.push / router.replace whose target is not allowlisted
//   - useRouter() bound to any name but `router`, destructured, or used inline
//     (so the router.* check above cannot be sidestepped by renaming)
//   - <Link href> whose target is not allowlisted
//   - next/link imported under any name but `Link`
//   - any assignment to location (window.location =, document.location =,
//     location.href =, ...) and location.assign/replace used directly.
//     hardNavigate in src/lib/tagManager.ts is the one sanctioned way, and that
//     file is not in the scanned set.
// Plain <a href> is always a full page load and is not flagged.

const ROOT = process.cwd();
const TRACKED_PAGES = [
  "src/app/(public)/enroll/[slug]/page.tsx",
  "src/app/(public)/enroll/page.tsx",
  "src/app/(public)/enroll/[slug]/tickets/page.tsx",
  // The public layout wraps tracked pages, so its links are exits too.
  "src/app/(public)/layout.tsx",
];
const TEMPLATES_DIR = "src/components/enrollment/templates";

/**
 * Targets a soft navigation may go to: tracked pages only.
 *  - /enroll/<slug>          the event page
 *  - /enroll/<slug>/tickets  the Trusted Official tickets page
 * Matched against the literal as written in source (quotes or backticks kept).
 */
const ALLOWED_SOFT_TARGETS: RegExp[] = [
  /^`\/enroll\/\$\{[^}]+\}`$/,
  /^`\/enroll\/\$\{[^}]+\}\/tickets\/?`$/,
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

interface Finding {
  kind: string;
  target: string;
}

export function scanSource(src: string, extraAllowed: RegExp[] = []): Finding[] {
  const code = stripComments(src);
  const allowed = [...ALLOWED_SOFT_TARGETS, ...extraAllowed];
  const findings: Finding[] = [];

  for (const m of code.matchAll(/\brouter\s*\.\s*(push|replace)\s*\(\s*([^)]*?)\s*\)\s*;?/g)) {
    // The target is the first argument; take the literal up to the closing paren.
    const target = m[2].trim();
    if (!allowed.some((re) => re.test(target))) findings.push({ kind: `router.${m[1]}`, target });
  }

  if (/from\s+["']next\/link["']/.test(code)) {
    for (const m of code.matchAll(/<Link\b[^>]*?\bhref\s*=\s*\{?\s*(`[^`]*`|"[^"]*"|'[^']*')\s*\}?/g)) {
      const target = m[1];
      if (!allowed.some((re) => re.test(target))) findings.push({ kind: "<Link href>", target });
    }
    // A Link whose href could not be read as a literal is not provably safe.
    const links = (code.match(/<Link\b/g) ?? []).length;
    const literal = [...code.matchAll(/<Link\b[^>]*?\bhref\s*=\s*\{?\s*(`[^`]*`|"[^"]*"|'[^']*')/g)].length;
    if (links !== literal) findings.push({ kind: "<Link href>", target: "non-literal href" });
  }

  for (const m of code.matchAll(
    /\b(?:(?:window|document|self|globalThis)\s*\.\s*)?location\s*(?:\.\s*(?:href|pathname|search|host|hostname|origin|port|protocol)\s*)?=(?!=)|\blocation\s*\.\s*(?:assign|replace)\s*\(/g,
  )) {
    findings.push({ kind: "location assignment", target: m[0] });
  }

  findings.push(...routerAliasFindings(code));

  // next/link under another name would escape the <Link> check.
  for (const m of code.matchAll(/import\s+([^;]*?)\s+from\s+["']next\/link["']/g)) {
    if (m[1].trim() !== "Link") findings.push({ kind: "aliased next/link import", target: m[1].trim() });
  }

  return findings;
}

/** useRouter() bound to anything but `const router`, so router.* checks cannot be renamed around. */
function routerAliasFindings(code: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of code.matchAll(/(?:\b(const|let|var)\s+([^=;]+?)\s*=\s*)?\buseRouter\s*\(\s*\)(\s*\.\s*\w+)?/g)) {
    const binding = m[2]?.trim();
    if (m[3]) findings.push({ kind: "useRouter() used inline", target: m[0] });
    else if (binding !== "router") findings.push({ kind: "useRouter alias", target: m[0] });
  }
  return findings;
}

function files(): { label: string; path: string; allowed: RegExp[] }[] {
  const out = TRACKED_PAGES.map((p) => ({ label: p, path: join(ROOT, p), allowed: [] as RegExp[] }));
  for (const f of readdirSync(join(ROOT, TEMPLATES_DIR)).filter((n) => n.endsWith(".tsx"))) {
    out.push({
      label: `${TEMPLATES_DIR}/${f}`,
      path: join(ROOT, TEMPLATES_DIR, f),
      allowed: [] as RegExp[],
    });
  }
  return out;
}

describe("tracked pages have no soft exits to untracked paths", () => {
  for (const f of files()) {
    it(f.label, () => {
      expect(scanSource(readFileSync(f.path, "utf8"), f.allowed)).toEqual([]);
    });
  }

  it("scans the expected set of files", () => {
    const labels = files().map((f) => f.label);
    expect(labels.length).toBeGreaterThanOrEqual(4 + 12);
    expect(labels).toContain("src/app/(public)/layout.tsx");
    expect(labels).toContain(`${TEMPLATES_DIR}/EvTrustedOfficialTemplate.tsx`);
  });
});

describe("the scanner itself", () => {
  it("flags a soft push to an untracked path", () => {
    expect(scanSource("router.push(`/enroll/form?slug=${s}`);")).toHaveLength(1);
    expect(scanSource('router.replace("/enroll/x/checkout");')).toHaveLength(1);
  });

  it("flags a soft push to a variable", () => {
    expect(scanSource("router.push(url);")).toHaveLength(1);
  });

  it("allows soft moves between tracked pages", () => {
    expect(scanSource("router.replace(`/enroll/${slug}/tickets/`);")).toEqual([]);
    expect(scanSource("router.push(`/enroll/${slug}`);")).toEqual([]);
  });

  it("flags next/link to an untracked path and allows a tracked one", () => {
    const head = 'import Link from "next/link";\n';
    expect(scanSource(head + "<Link href={`/enroll/${s}/status`}>x</Link>")).toHaveLength(1);
    expect(scanSource(head + "<Link href={`/enroll/${s}`}>x</Link>")).toEqual([]);
    expect(scanSource(head + "<Link href={target}>x</Link>")).toHaveLength(1);
  });

  it("flags direct location assignment", () => {
    expect(scanSource('window.location.href = "/x";')).toHaveLength(1);
    expect(scanSource('location.assign("/x");')).toHaveLength(1);
  });

  it("flags every kind of location assignment", () => {
    expect(scanSource('window.location = "/x";')).toHaveLength(1);
    expect(scanSource('document.location = "/x";')).toHaveLength(1);
    expect(scanSource('location.href = "/x";')).toHaveLength(1);
    expect(scanSource('location = "/x";')).toHaveLength(1);
    expect(scanSource('window.location.pathname = "/x";')).toHaveLength(1);
    expect(scanSource('location.replace("/x");')).toHaveLength(1);
    expect(scanSource('if (window.location.href === "/x") {}')).toEqual([]);
    expect(scanSource("const p = window.location.pathname;")).toEqual([]);
  });

  it("allows the canonical router binding", () => {
    expect(scanSource("const router = useRouter();\nrouter.push(`/enroll/${s}`);")).toEqual([]);
    expect(scanSource('import { useRouter } from "next/navigation";')).toEqual([]);
  });

  it("flags useRouter aliasing, destructuring and inline use", () => {
    expect(scanSource("const r = useRouter();\nr.push(`/enroll/form`);")).toHaveLength(1);
    expect(scanSource("const { push } = useRouter();\npush(`/enroll/form`);")).toHaveLength(1);
    expect(scanSource("let nav = useRouter();")).toHaveLength(1);
    expect(scanSource("useRouter().push(`/enroll/form`);")).toHaveLength(1);
  });

  it("flags an aliased next/link import", () => {
    expect(scanSource('import A from "next/link";\n<A href="/enroll/form">x</A>')).toHaveLength(1);
    expect(scanSource('import { default as A } from "next/link";')).toHaveLength(1);
    expect(scanSource('import Link from "next/link";')).toEqual([]);
  });

  it("ignores commented-out code and plain anchors", () => {
    expect(scanSource("// router.push('/enroll/form')\n/* router.push(x) */")).toEqual([]);
    expect(scanSource('<a href={`/enroll/${s}/status`}>x</a>')).toEqual([]);
  });
});

// ─── Untracked → tracked ────────────────────────────────────────────────────
//
// GTM may only start in a document whose first page is tracked and clean. A soft
// navigation from an untracked page (which may hold refs or keys in memory) into
// a tracked one would put the container in that document, so every entry into a
// tracked page from an untracked one is a full page load as well.

const PUBLIC_DIR = "src/app/(public)";

function untrackedPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "page.tsx") out.push(relative(ROOT, full).split("\\").join("/"));
    }
  };
  walk(join(ROOT, PUBLIC_DIR));
  return out.filter((p) => !TRACKED_PAGES.includes(p));
}

/** The path a literal target points at, with ${...} filled in and query/hash dropped. */
function literalPath(target: string): string | null {
  const m = /^([`"'])([\s\S]*)\1$/.exec(target.trim());
  if (!m) return null;
  return m[2].replace(/\$\{[^}]*\}/g, "x").split(/[?#]/)[0];
}

function entersTracked(target: string): boolean {
  const p = literalPath(target);
  // A target that cannot be read as a literal is not provably safe.
  if (p === null) return true;
  return p === "/" || p === "" || isTrackedPath(p);
}

export function scanUntrackedSource(src: string): Finding[] {
  const code = stripComments(src);
  const findings: Finding[] = [];
  for (const m of code.matchAll(/\brouter\s*\.\s*(push|replace)\s*\(\s*([^)]*?)\s*\)\s*;?/g)) {
    const target = m[2].trim();
    if (entersTracked(target)) findings.push({ kind: `router.${m[1]}`, target });
  }
  if (/from\s+["']next\/link["']/.test(code)) {
    for (const m of code.matchAll(/<Link\b[^>]*?\bhref\s*=\s*\{?\s*(`[^`]*`|"[^"]*"|'[^']*'|[^\s>}]+)/g)) {
      if (entersTracked(m[1])) findings.push({ kind: "<Link href>", target: m[1] });
    }
  }
  return findings;
}

describe("untracked pages enter tracked pages with a full page load", () => {
  const pages = untrackedPages();

  it("finds the untracked public pages", () => {
    expect(pages).toContain("src/app/(public)/enroll/form/page.tsx");
    expect(pages).toContain("src/app/(public)/enroll/[slug]/checkout/new/page.tsx");
    expect(pages).toContain("src/app/(public)/status/page.tsx");
    expect(pages).not.toContain("src/app/(public)/enroll/[slug]/page.tsx");
  });

  for (const p of pages) {
    it(p, () => {
      expect(scanUntrackedSource(readFileSync(join(ROOT, p), "utf8"))).toEqual([]);
    });
  }

  it("the scanner flags soft moves into tracked pages", () => {
    expect(scanUntrackedSource("router.replace(`/enroll/${slug}/tickets/`);")).toHaveLength(1);
    expect(scanUntrackedSource("router.push(`/enroll/${slug}`)")).toHaveLength(1);
    expect(scanUntrackedSource('router.push("/enroll")')).toHaveLength(1);
    expect(scanUntrackedSource("router.push(dest)")).toHaveLength(1);
    const head = 'import Link from "next/link";\n';
    expect(scanUntrackedSource(head + '<Link href="/">x</Link>')).toHaveLength(1);
    expect(scanUntrackedSource(head + "<Link href={`/enroll/${s}`}>x</Link>")).toHaveLength(1);
  });

  it("the scanner allows soft moves between untracked pages", () => {
    expect(scanUntrackedSource("router.push(`/enroll/${s}/checkout/success/?ref=${r}`);")).toEqual([]);
    expect(scanUntrackedSource("router.push(`/enroll/payment/${ref}`);")).toEqual([]);
    const head = 'import Link from "next/link";\n';
    expect(scanUntrackedSource(head + "<Link href={`/enroll/payment/${r}`}>x</Link>")).toEqual([]);
  });
});
