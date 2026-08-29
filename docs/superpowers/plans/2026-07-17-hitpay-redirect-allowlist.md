# P2 — HitPay Base Redirect Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `/api/public/payments/hitpay` accepting an arbitrary client-supplied `redirectUrl`, so a HitPay card payment cannot be used to land a payer on an attacker-chosen page.

**Architecture:** Validate the client's `redirectUrl` against a server-built allowlist of origins where a legitimate enrollment page for *this tenant* can live. Compare parsed origins exactly — never prefixes. Reject on mismatch rather than silently substituting, so a broken client surfaces instead of degrading. No schema change, no new dependency.

**Tech Stack:** Next.js 14 route handler, TypeScript, Vitest.

**Scope:** This is **P2**, the base allowlist, and is deliberately independent of custom domains. **P3** (adding the tenant's custom origin) is a separate follow-up that cannot be written until this merges — see the custom-domains plan.

---

## Revision history

**v5 (this document)** — the v4 review **approved the security design and gave a go** subject to one mechanical fix. Both its points are folded in. **Ready to implement.**

| v4 said | Reality (verified) | v5 does |
|---|---|---|
| Task 4: `git add` three files, `git diff --cached` two | The new security test `redirect-allowlist.test.ts` was staged but **not in the cached diff** — committed unreviewed. The same defect v4 fixed elsewhere, missed in one spot. | All three paths in the cached diff. |
| `const subdomain = enrollment.tenants?.subdomain ?? ""` | **Fails open.** `tenantOrigin()` returns the **platform root** for a falsy subdomain (`if (!subdomain) return url.origin`) — so a missing or reshaped join would allowlist `https://kuunyi.com`, the one origin this design excludes, and aim the fallback at a nonexistent page. Flagged as "defensive"; it is actually the failure mode the allowlist exists to prevent. | Fail closed with a 500 before any HitPay request, plus a route test. |

**v4** — revised after the v3 review. All six findings accepted; execution mechanics only, **no security-design change** (the model has been approved unchanged since v2).

| v3 said | Reality (verified) | v4 does |
|---|---|---|
| `git checkout dev && git pull …`, `npm run lint && npm run build`, `git fetch … && git rev-list …` | This workspace's primary shell is **PowerShell 5.1, where `&&` is a parser error**. The safety-critical branch sequence in Task 1 was among them — the one step that must not silently half-run. | Every command on its own line. **No `&&` anywhere.** |
| Pre-commit check was `git status` + `git diff -- <files>` | **`git diff -- <untracked>` prints nothing** (verified). The two *new* test files would have been staged and committed with an empty diff — the review-before-commit rule satisfied on paper only. | `git add` first, then `git diff --cached -- <files>`. That is the only form that shows a new file. |
| `hitpay-create.test.ts` "may need its fixture changed" | Task 3 listed, staged and committed **only** the route — so a changed fixture belonged to no commit, while Task 6 expected it in `HEAD`. | Named as a conditional Task 3 file with an explicit staging path. |
| Baseline: `npm test 2>&1 \| tail -3` | Reports **`tail`'s** exit code, not Vitest's; depends on a `tail.exe` that merely happens to be on PATH; may truncate the failing test name away. | `npm test` directly. |
| Red phase: "attacker-origin and cross-tenant FAIL" | Understated. The spoofed-Host fallback and canonical-ref cases must fail too — otherwise only *one* of the two untrusted paths is proven. | Full red table, plus: a listed test that passes early is not testing what its name says. |
| Task 6 status expectation listed plan docs + `AGENTS.md` | Omitted `.claude/settings.local.json` and `design_handoff_sponsor_placements/`, so the stop condition was ambiguous. | Complete unrelated-state list, matching Task 1. |

**v3** — revised after the v2 review. All six findings accepted. The security design was sound; the *execution sequence* was not.

| v2 said | Reality | v3 does |
|---|---|---|
| Branch check lived in the final task ("Open the PR") | **Four commits would land on the wrong branch.** The working tree is currently on `fix/abank-callback-verification` (PR #163). Following v2 literally would have committed P2 onto the ABank PR — and violated `CLAUDE.md`'s "ALWAYS create feature branch from `dev`". | **Task 1 creates the branch from `dev` before any edit.** |
| `if (clientRedirectUrl !== undefined)` validate → 400 | **Contradicts v2's own PayNow test.** That gate runs for *both* methods, so `postPayNow("https://evil.com/phish")` returns 400 while the test asserts it must not. The plan disagreed with itself. | Validation gated on `hitpayMethod === "card"`, structurally. |
| `const proto = host.startsWith("localhost") ? "http" : "https"` | **Breaks two environments the helper claims to support.** `tenant.localhost:3005` and `192.168.50.3:3005` don't start with `"localhost"`, so they'd be labelled `https://` while the browser origin is `http://` — exact-origin comparison then rejects legitimate dev traffic. Pure helper tests never exercise route wiring, so nothing would have caught it. | `request.nextUrl.origin`. **Verified in this runtime**: correct for localhost, `*.localhost`, LAN IPv4, `*.vercel.app` and production. `host` is no longer needed in the route at all. |
| `npm test && npm run lint && npm run build` | `dev` has a **known baseline failure** (`scanner/events.test.ts`). The chain stops at `npm test`; lint and build never run. | Separate steps, with the baseline recorded and "no *new* failures" as the bar. |
| Expected diff: four files | At least six change. An under-specified diff can't function as a stop condition. | Complete list, with `hitpay-create.test.ts` flagged as conditional. |
| One `git diff` after all four commits | `CLAUDE.md`: "ALWAYS check `git status` before committing", "ALWAYS run `git diff` before committing". | Scoped `git status` + `git diff` before **every** commit. |

**v2** — revised after the first review. All three findings accepted; v1 left the boundary incomplete.

| v1 said | Reality (verified) | v2 does |
|---|---|---|
| "The client always sends its own origin. **Both callers**… build `${window.location.origin}/enroll/...`" | **False.** `(public)/enroll/payment/[ref]/page.tsx:1181` sends `{ enrollmentRef, method: "card" }` — **no `redirectUrl`**. It relies entirely on the Host-derived fallback. v1's own grep showed `redirectUrl` in *one* file; a second grep for `method: "card"` returned two, and v1 conflated them into a claim neither supported. | Corrected. That caller now sends its return URL (Task 1), and the fallback is rebuilt from a trusted origin (Task 4). |
| The Host-derived fallback is "server-constructed, not client input" — **out of scope** | The server assembles it, but **its origin comes from the inbound `Host`**, which is request data. And it is the *active* path for one real caller, so leaving it out meant the vulnerability was not actually closed. | Fallback derives from `tenantOrigin(subdomain)`. Never `Host`. |
| `allowedOrigins()` adds `requestOrigin` whenever `VERCEL_ENV !== "production"` | No hostname check, so on a preview deployment a request claiming `Host: evil.com` would allow a redirect to `https://evil.com` — it allows *itself*. Weaker than the custom-domains plan, which gates the same exception on a recognized dev host. | Restricted to recognized dev hosts, via a shared `isDevHost()`. |
| Fallback path built from the client's `enrollmentRef` | The DB lookup uses `enrollmentRef.trim()`; the URL used the raw value, so they can disagree. | Built from `enrollment.enrollment_ref`, the canonical DB value. |

---

## Why this is its own PR

`hitpay/route.ts:151` is a **pre-existing** open redirect, unrelated to custom domains. It is bundled with neither the ABank fix (PR #163) nor the custom-domain work, on the same principle applied there: a live security fix should not wait on unrelated review, and should be cherry-pickable on its own.

It is prerequisite **P2** for the custom-domain rollout. **P3 needs it merged first** — writing P3 against assumed code is what got F1 marked provisional.

---

## The defect

```ts
// hitpay/route.ts:146-151
const host = request.headers.get("host") ?? "localhost:3005";
const proto = host.startsWith("localhost") ? "http" : "https";
const fallbackRedirectUrl = `${proto}://${host}/enroll/payment/${encodeURIComponent(enrollmentRef)}?hitpay=success`;
const redirectUrl = clientRedirectUrl ?? fallbackRedirectUrl;   // ← unvalidated
```

`clientRedirectUrl` comes straight from the request body (line 28) and is handed to HitPay as the card return destination. An attacker creates their own enrollment, obtains a valid `enrollmentRef`, and mints a **genuine HitPay checkout link** that returns the payer to a site they control — a credible re-harvesting page, reached from a real payment flow. Card only (`redirectUrl` is `undefined` for PayNow, line 162).

**Severity:** medium-high. It requires a valid `enrollmentRef` and the victim must follow the attacker's link, so it is phishing amplification rather than direct compromise. But the link is authentic, which is exactly what makes it convincing.

---

## What the code actually says (verified, not assumed)

These corrections matter because the custom-domain plan's **F1 section guessed wrong about both**:

| F1 assumed | Reality |
|---|---|
| "a locally available `subdomain`" | The handler has **`tenantId` only** (a UUID, from `resolveTenantId()` at line 14). There is no `subdomain` in scope. It must be fetched — see Task 2. |
| "`platformOrigin()` and `tenantOrigin(subdomain)` in the allowlist" | **`platformOrigin()` does not belong.** No enrollment page exists on `kuunyi.com`; including it would allow a redirect to a page that cannot complete the flow, widening the allowlist for nothing. |

**The two card callers behave differently** — verified by grepping every `fetch("/api/public/payments/hitpay")` body in the codebase:

| Caller | Card body | Redirect path |
|---|---|---|
| `(public)/enroll/[slug]/checkout/payment/page.tsx:443` | `{ enrollmentRef, method: "card", redirectUrl }` | sends `${window.location.origin}/...` |
| `(public)/enroll/payment/[ref]/page.tsx:1181` | `{ enrollmentRef, method: "card" }` | **sends nothing — uses the Host-derived fallback** |

So there are **two** untrusted paths to close, not one. Validating only the supplied value would leave the second caller redirecting to whatever origin the `Host` header produced.

---

## The allowlist

**Production:** exactly one origin — `tenantOrigin(subdomain)`, the tenant's canonical origin, built from `NEXT_PUBLIC_APP_URL` and never from the inbound Host.

**Non-production** (`VERCEL_ENV !== "production"`): additionally the request's own origin **when its hostname is a recognized dev host** — `localhost`, `*.localhost`, a bare IPv4, or `*.vercel.app`. Both conditions, not either.

**The hostname check is not optional.** Without it, the request origin can allow *itself*: a preview deployment receiving `Host: evil.com` would accept a redirect to `https://evil.com`, because candidate and request origin match. The environment gate alone is not a control. This mirrors the custom-domains plan's Task 3, where the same exception is gated on both `VERCEL_ENV` and a dev host.

**`isDevHost()` is shared, not copied.** It lives in `src/lib/tenant.ts` — the canonical host module — and the custom-domains plan's Task 3 **imports it rather than inlining its own copy**. Two divergent host classifiers is precisely the defect that plan's Task 2 exists to delete.

**Why non-production needs the exception.** `tenantOrigin()` derives from `NEXT_PUBLIC_APP_URL`. On a preview deployment that variable does not point at the preview host, so `window.location.origin` cannot match it and every card return would 400. **Verify during Task 4 whether staging is affected too** — if staging's `NEXT_PUBLIC_APP_URL` is `https://kuunyi.com` rather than `https://staging.kuunyi.com`, then `tenantOrigin("walmal")` yields `walmal.kuunyi.com` while the student is on `walmal.staging.kuunyi.com`. Under `VERCEL_ENV=preview` the exception covers it; if staging deploys as production, it does not and card returns break there.

**Exact origin comparison subsumes the scheme and port checks.** `URL.origin` includes both, so an `http://` return can never match an `https://` allowlisted origin. Two checks do *not* fall out of it and are required explicitly:

- **Credentials.** `new URL("https://user:pass@kuunyi.com/x").origin` is `"https://kuunyi.com"` — it **passes** an origin check while the browser shows a credential-stuffed URL. Reject any URL with `username` or `password`.
- **Malformed input.** `new URL()` throws; that must be a 400, not a 500.

**Never `startsWith`.** `https://nihon-moment.kuunyi.com.evil.com` starts with `https://nihon-moment.kuunyi.com`.

---

## File Structure

- **Modify** `src/app/(public)/enroll/payment/[ref]/page.tsx` — send `redirectUrl` for card, like the other caller.
- **Modify** `src/lib/tenant.ts` — add and export `isDevHost()`, the shared host classifier.
- **Create** `src/lib/payments/redirect-allowlist.ts` — pure origin-validation helper. Separate because it is the security decision and must be unit-testable without mocking a route, and because **P3 extends it** rather than re-editing the handler.
- **Modify** `src/app/api/public/payments/hitpay/route.ts` — fetch the tenant subdomain via the existing enrollment query; validate the supplied redirect; rebuild the fallback from a trusted origin.
- **Create** `src/__tests__/payments/redirect-allowlist.test.ts` — pure tests.
- **Create** `src/__tests__/payments/hitpay-redirect.test.ts` — route-level wiring tests.

Pure helper plus route tests, deliberately: PR #163 showed that pure-function tests alone let the handler drift — its failed path kept writing unauthenticated data while every pure test stayed green.

---

## Task 1: Create the feature branch — DO THIS FIRST

**Nothing below may be edited until this task completes.** At the time of writing the working tree sits on `fix/abank-callback-verification` (PR #163). Committing P2 there would bolt an unrelated security fix onto that PR and break `CLAUDE.md`'s "ALWAYS create feature branch from `dev`".

- [ ] **Step 1: Preserve unrelated working-tree state**

Run: `git status --short`
Expect untracked plan/review docs, `AGENTS.md`, `design_handoff_sponsor_placements/`, and a modified `.claude/settings.local.json`. **These are not ours — do not stage, stash, or clean them.** If tracked `src/` files are modified, stop and ask.

- [ ] **Step 2: Branch from a verified `dev`**

```bash
git fetch origin dev
git rev-list --left-right --count origin/dev...dev   # expect 0 0
git checkout dev
git pull --ff-only origin dev
git checkout -b fix/hitpay-redirect-allowlist
git branch --show-current                            # expect fix/hitpay-redirect-allowlist
```

**If the counts are not `0 0`, stop** and reconcile rather than branching from a stale base.

- [ ] **Step 3: Record the test baseline**

Run: `npm test`

Do not pipe through `tail` — that reports `tail`'s exit code rather than Vitest's, relies on a `tail.exe` that only happens to be on PATH, and may truncate away the failing test name.

Expected: **exactly 1 failure — `src/__tests__/scanner/events.test.ts`**, pre-existing on clean `dev` and unrelated to this work. **Write down the pass count.** The bar for every later step is **no new failures**, not a green suite.

---

## Task 2: Make the generic payment page send its return URL

**Files:**
- Modify: `src/app/(public)/enroll/payment/[ref]/page.tsx` (~line 1181)

**Why first.** This caller currently sends no `redirectUrl` and depends on the fallback. Task 4 makes the fallback derive from `tenantOrigin()`, which on a **preview deployment** resolves to the *production* origin — so without this change, card returns from this page would leave the preview. Sending the origin explicitly keeps preview and local dev working through the same validated path as the other caller.

- [ ] **Step 1: Send the redirect URL**

Mirror `(public)/enroll/[slug]/checkout/payment/page.tsx:438-443`:

```ts
const redirectUrl = `${window.location.origin}/enroll/payment/${encodeURIComponent(params.ref)}?hitpay=success`;
const res = await fetch("/api/public/payments/hitpay", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ enrollmentRef: params.ref, method: "card", redirectUrl }),
});
```

Leave the PayNow call (line 1156) alone — PayNow never receives a `redirectUrl`.

- [ ] **Step 2: Verify**

Run each on its own line — this workspace's primary shell is PowerShell 5.1, where `&&` is a parser error:

```powershell
npm run lint
npm run build
```

Expected: both PASS.

- [ ] **Step 3: Commit**

Per `CLAUDE.md`, check status, stage deliberately, then review the **staged** patch.
`git diff -- <path>` shows nothing for a *new* file, so only `--cached` proves what is
actually about to be committed. One command per line — PowerShell has no `&&`.

```powershell
git status --short
git add "src/app/(public)/enroll/payment/[ref]/page.tsx"
git diff --cached -- "src/app/(public)/enroll/payment/[ref]/page.tsx"
git commit -m "fix: send the card return URL from the generic payment page"
```

---

## Task 3: Fetch the tenant subdomain

**Files:**
- Modify: `src/app/api/public/payments/hitpay/route.ts` (the enrollment query, ~line 50)
- **Modify conditionally:** `src/__tests__/payments/hitpay-create.test.ts` — only if its enrollment fixture needs `tenants(subdomain)` for the new join. **If it changes, it belongs to this commit** — otherwise it is orphaned from every task while Task 6 expects it in `HEAD`.

The handler needs `subdomain` to build the allowlist and does not have it. Get it from the **existing** query rather than a second round trip — `enrollments.tenant_id` joins `tenants`.

- [ ] **Step 1: Extend the enrollment select**

Add `tenants(subdomain)` to the existing select at line 53 and to its result type. Confirm the join name matches the FK (`enrollments.tenant_id → tenants.id`); the existing `classes(...)` and `enrollment_items(...)` joins in the same select are the pattern to follow.

- [ ] **Step 2: Verify the join returns data**

Run: `npx vitest run src/__tests__/payments/hitpay-create.test.ts`

Its admin mock may need `tenants` added to the fixture. **If it fails, fix the fixture, not the query** — then it becomes part of this commit (Step 3).

- [ ] **Step 3: Commit**

Per `CLAUDE.md`, check status, stage deliberately, then review the **staged** patch.
`git diff -- <path>` shows nothing for a *new* file, so only `--cached` proves what is
actually about to be committed. One command per line — PowerShell has no `&&`.

```powershell
git status --short
git add src/app/api/public/payments/hitpay/route.ts
```

**Only if Step 2 required a fixture change**, stage it here too — this is its only commit path:

```powershell
git add src/__tests__/payments/hitpay-create.test.ts
```

Then review and commit:

```powershell
git diff --cached -- src/app/api/public/payments/hitpay/route.ts src/__tests__/payments/hitpay-create.test.ts
git commit -m "refactor: fetch tenant subdomain in the hitpay payment route"
```

---

## Task 4: The origin allowlist helper

**Files:**
- Modify: `src/lib/tenant.ts` — add and export `isDevHost()`
- Create: `src/lib/payments/redirect-allowlist.ts`
- Test: `src/__tests__/payments/redirect-allowlist.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { isAllowedRedirect } from "@/lib/payments/redirect-allowlist";

const ENV_KEYS = ["NEXT_PUBLIC_APP_URL", "VERCEL_ENV"] as const;
const ORIGINAL = Object.fromEntries(
  ENV_KEYS.map((k) => [k, process.env[k]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

// Delete-aware: `process.env.X = undefined` stores the STRING "undefined".
afterEach(() => {
  for (const k of ENV_KEYS) {
    const original = ORIGINAL[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
});

function prod() {
  process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
  process.env.VERCEL_ENV = "production";
}

const TENANT = "nihon-moment";
const REQ_ORIGIN = "https://nihon-moment.kuunyi.com";

describe("isAllowedRedirect — accepts the tenant's own origin", () => {
  it("allows the tenant's canonical origin", () => {
    prod();
    expect(
      isAllowedRedirect("https://nihon-moment.kuunyi.com/enroll/x?hitpay=success", TENANT, REQ_ORIGIN),
    ).toBe(true);
  });

  it("allows any path and query on that origin", () => {
    prod();
    expect(isAllowedRedirect("https://nihon-moment.kuunyi.com/", TENANT, REQ_ORIGIN)).toBe(true);
  });
});

describe("isAllowedRedirect — rejects", () => {
  it("rejects an unrelated origin", () => {
    prod();
    expect(isAllowedRedirect("https://evil.com/phish", TENANT, REQ_ORIGIN)).toBe(false);
  });

  // The reason prefix matching is banned.
  it("rejects a lookalike suffix host", () => {
    prod();
    expect(
      isAllowedRedirect("https://nihon-moment.kuunyi.com.evil.com/x", TENANT, REQ_ORIGIN),
    ).toBe(false);
  });

  it("rejects another tenant's origin", () => {
    prod();
    expect(isAllowedRedirect("https://rival.kuunyi.com/enroll/x", TENANT, REQ_ORIGIN)).toBe(false);
  });

  it("rejects the platform root (no enrollment page lives there)", () => {
    prod();
    expect(isAllowedRedirect("https://kuunyi.com/", TENANT, REQ_ORIGIN)).toBe(false);
  });

  // URL.origin DISCARDS credentials, so this passes an origin check while the
  // browser shows a credential-stuffed URL. Needs its own rejection.
  it("rejects a credential-bearing URL whose origin otherwise matches", () => {
    prod();
    expect(
      isAllowedRedirect("https://user:pass@nihon-moment.kuunyi.com/x", TENANT, REQ_ORIGIN),
    ).toBe(false);
  });

  it("rejects http when the allowed origin is https", () => {
    prod();
    expect(isAllowedRedirect("http://nihon-moment.kuunyi.com/x", TENANT, REQ_ORIGIN)).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    prod();
    for (const bad of ["", "not a url", "/enroll/relative", "javascript:alert(1)", "//evil.com"]) {
      expect(() => isAllowedRedirect(bad, TENANT, REQ_ORIGIN)).not.toThrow();
      expect(isAllowedRedirect(bad, TENANT, REQ_ORIGIN)).toBe(false);
    }
  });

  // In production the request origin gets no latitude: only the canonical
  // tenant origin is allowed, so a Host that somehow differs cannot widen it.
  it("does not trust the request origin in production", () => {
    prod();
    expect(isAllowedRedirect("https://flashtic.com/enroll/x", TENANT, "https://flashtic.com")).toBe(
      false,
    );
  });
});

describe("isAllowedRedirect — non-production", () => {
  it("allows the request's own origin on a preview deployment", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
    process.env.VERCEL_ENV = "preview";
    const preview = "https://edu-enroll-git-x.vercel.app";
    expect(isAllowedRedirect(`${preview}/enroll/x`, TENANT, preview)).toBe(true);
  });

  it("allows localhost and the LAN dev host when unset (local dev)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3005";
    delete process.env.VERCEL_ENV;
    expect(
      isAllowedRedirect("http://localhost:3005/enroll/x", TENANT, "http://localhost:3005"),
    ).toBe(true);
    expect(
      isAllowedRedirect("http://192.168.50.3:3005/enroll/x", TENANT, "http://192.168.50.3:3005"),
    ).toBe(true);
  });

  // Even off production, an arbitrary origin is not allowed — only the one the
  // request actually arrived on.
  it("still rejects an unrelated origin on a preview deployment", () => {
    process.env.VERCEL_ENV = "preview";
    expect(
      isAllowedRedirect("https://evil.com/x", TENANT, "https://edu-enroll-git-x.vercel.app"),
    ).toBe(false);
  });

  // THE ONE THAT MATTERS: without a hostname check the request origin allows
  // ITSELF — candidate and requestOrigin match, so the environment gate alone
  // would return true. VERCEL_ENV is not a control on its own.
  it("does not let an unknown request origin allow itself off production", () => {
    process.env.VERCEL_ENV = "preview";
    expect(isAllowedRedirect("https://evil.com/phish", TENANT, "https://evil.com")).toBe(false);
  });

  it("does not let a lookalike dev host allow itself", () => {
    process.env.VERCEL_ENV = "preview";
    for (const rogue of ["https://vercel.app.evil.com", "https://notlocalhost", "https://evil.com:3005"]) {
      expect(isAllowedRedirect(`${rogue}/phish`, TENANT, rogue)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/__tests__/payments/redirect-allowlist.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Add the shared host classifier to `src/lib/tenant.ts`**

```ts
/**
 * Hosts that only ever appear in development: local machine, LAN testing, or a
 * Vercel preview deployment. Never a production host.
 *
 * Exported and shared on purpose — the custom-domains plan's middleware gate
 * needs the identical rule, and two divergent host classifiers is the exact
 * defect that plan's Task 2 exists to delete. Import this; do not re-inline it.
 */
export function isDevHost(hostname: string): boolean {
  const host = hostname.split(":")[0].trim().toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    host.endsWith(".vercel.app")
  );
}
```

- [ ] **Step 4: Write the allowlist implementation**

```ts
// ─── Payment return-URL allowlist ────────────────────────────────────────────
// A customer return URL is client-supplied and must be validated server-side:
// an unchecked value turns a genuine payment link into a phishing redirect.
//
// Machine callbacks are a different problem with the opposite answer — they pin
// to the platform origin and never follow the client. See the custom-domains
// plan's platformOrigin().

import { tenantOrigin } from "@/lib/origin";
import { isDevHost } from "@/lib/tenant";

/** Origins where a legitimate enrollment page for this tenant can live. */
function allowedOrigins(tenantSubdomain: string, requestOrigin: string): Set<string> {
  // Canonical origin, derived from NEXT_PUBLIC_APP_URL — never the inbound Host.
  // platformOrigin() is deliberately NOT here: no enrollment page exists on the
  // platform root, so allowing it would widen the allowlist for nothing.
  const origins = new Set<string>([tenantOrigin(tenantSubdomain)]);

  // Off production, also allow the origin the request arrived on — but ONLY if
  // it is a recognized dev host. tenantOrigin() derives from
  // NEXT_PUBLIC_APP_URL, which on a preview deployment does not point at the
  // preview host, so without this every preview card return would 400.
  //
  // The hostname check is not optional: without it the request origin allows
  // ITSELF, and a preview receiving `Host: evil.com` would accept a redirect to
  // https://evil.com. VERCEL_ENV alone is not a control.
  if (process.env.VERCEL_ENV !== "production") {
    try {
      if (isDevHost(new URL(requestOrigin).hostname)) origins.add(requestOrigin);
    } catch {
      // Unparseable request origin contributes nothing.
    }
  }

  return origins;
}

/**
 * True only if `candidate` is a well-formed absolute URL whose origin is
 * allowlisted for this tenant. Never throws.
 */
export function isAllowedRedirect(
  candidate: string,
  tenantSubdomain: string,
  requestOrigin: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate); // throws on relative/malformed input
  } catch {
    return false;
  }

  // URL.origin discards credentials, so "https://user:pass@good.com" would
  // otherwise pass while the browser renders a credential-stuffed URL.
  if (parsed.username || parsed.password) return false;

  // Exact origin match. Never startsWith: "https://good.com.evil.com" is a
  // prefix of "https://good.com". Origin covers scheme, host and port, so an
  // http:// candidate cannot match an https:// allowed origin.
  return allowedOrigins(tenantSubdomain, requestOrigin).has(parsed.origin);
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/__tests__/payments/redirect-allowlist.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

Per `CLAUDE.md`, check status, stage deliberately, then review the **staged** patch.
`git diff -- <path>` shows nothing for a *new* file, so only `--cached` proves what is
actually about to be committed. One command per line — PowerShell has no `&&`.

```powershell
git status --short
git add src/lib/tenant.ts src/lib/payments/redirect-allowlist.ts src/__tests__/payments/redirect-allowlist.test.ts
git diff --cached -- src/lib/tenant.ts src/lib/payments/redirect-allowlist.ts src/__tests__/payments/redirect-allowlist.test.ts
git commit -m "feat: add payment return-URL origin allowlist"
```

---

## Task 5: Enforce it in the HitPay route

**Files:**
- Modify: `src/app/api/public/payments/hitpay/route.ts` (~lines 146-151)
- Test: `src/__tests__/payments/hitpay-redirect.test.ts`

- [ ] **Step 1: Write the failing route tests**

Follow `src/__tests__/payments/hitpay-create.test.ts` for the mock shape — it already mocks `@/lib/supabase/admin` and `@/lib/api`'s `resolveTenantId`, which this route calls **first** (line 14) before reading the body. Spy on `hitpay.createPaymentRequest`.

```ts
// Route-level wiring. redirect-allowlist.test.ts covers the decision as a pure
// function; these prove the HANDLER consults it — that a future change can't
// bypass validation while every pure test stays green. (PR #163's failed path
// kept writing unauthenticated data for exactly this reason.)

it("rejects a card redirect to an attacker origin", async () => {
  const res = await POST(postCard("https://evil.com/phish"));
  expect(res.status).toBe(400);
  expect(createPaymentRequestSpy).not.toHaveBeenCalled(); // no payment created
});

it("accepts the tenant's own origin", async () => {
  const res = await POST(postCard("https://nihon-moment.kuunyi.com/enroll/x?hitpay=success"));
  expect(res.status).not.toBe(400);
  expect(createPaymentRequestSpy).toHaveBeenCalledWith(
    expect.objectContaining({ redirectUrl: "https://nihon-moment.kuunyi.com/enroll/x?hitpay=success" }),
  );
});

it("rejects another tenant's origin", async () => {
  const res = await POST(postCard("https://rival.kuunyi.com/enroll/x"));
  expect(res.status).toBe(400);
});

// PayNow never receives a redirectUrl, so a rogue value must not even be
// validated — it must be ignored. If this 400s, the card gate is misplaced.
it("ignores redirectUrl for PayNow", async () => {
  const res = await POST(postPayNow("https://evil.com/phish"));
  expect(res.status).not.toBe(400);
  expect(createPaymentRequestSpy).toHaveBeenCalledWith(
    expect.objectContaining({ redirectUrl: undefined }),
  );
});

// The fallback path — used by any client that sends nothing. Its origin must
// come from tenantOrigin(), never from the Host header.
it("uses the tenant's canonical origin when the client sends no redirectUrl", async () => {
  const res = await POST(postCard(undefined));
  expect(res.status).not.toBe(400);
  expect(createPaymentRequestSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      redirectUrl: expect.stringContaining("https://nihon-moment.kuunyi.com/enroll/payment/"),
    }),
  );
});

// A spoofed Host must not reach the fallback. This is the second untrusted
// path — the generic payment page relied on it before Task 1.
it("ignores a spoofed Host when building the fallback", async () => {
  const res = await POST(postCard(undefined, { host: "evil.com" }));
  expect(res.status).not.toBe(400);
  const call = createPaymentRequestSpy.mock.calls[0][0];
  expect(call.redirectUrl).not.toContain("evil.com");
  expect(call.redirectUrl).toContain("nihon-moment.kuunyi.com");
});

// Fail closed rather than silently allowlisting the platform root.
it("creates no payment when the tenant subdomain is missing", async () => {
  setEnrollmentFixture({ tenants: null }); // join absent or reshaped
  const res = await POST(postCard("https://nihon-moment.kuunyi.com/enroll/x"));
  expect(res.status).toBe(500);
  expect(createPaymentRequestSpy).not.toHaveBeenCalled();
});

// The fallback path uses the canonical DB ref, not the client's raw value.
it("builds the fallback from the database enrollment_ref", async () => {
  const res = await POST(postCard(undefined, { enrollmentRef: "  ENR-TEST-001  " }));
  expect(res.status).not.toBe(400);
  expect(createPaymentRequestSpy.mock.calls[0][0].redirectUrl).toContain("ENR-TEST-001?hitpay=success");
});
```

**Development origins must work off production.** The helper claims to allow `*.localhost`, LAN IPv4 and `*.vercel.app`; only route-level tests prove the *wiring* delivers the right origin to it. These are the cases the old `host.startsWith("localhost")` rule would have silently broken:

```ts
it("accepts development origins off production", async () => {
  process.env.VERCEL_ENV = "preview";
  for (const origin of [
    "http://tenant.localhost:3005",
    "http://192.168.50.3:3005",
    "https://edu-enroll-git-abc.vercel.app",
  ]) {
    createPaymentRequestSpy.mockClear();
    // The request must ARRIVE on that origin, as a browser would send it.
    const res = await POST(postCardOn(origin, `${origin}/enroll/x?hitpay=success`));
    expect(res.status, `${origin} should be accepted`).not.toBe(400);
    expect(createPaymentRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUrl: `${origin}/enroll/x?hitpay=success` }),
    );
  }
});
```

> **Implementer note:** build requests with `new NextRequest(url, ...)` so `nextUrl.origin` reflects the URL under test — that is what the route now reads. Most tests set `VERCEL_ENV=production` and `NEXT_PUBLIC_APP_URL=https://kuunyi.com` to exercise the strict path; the dev-origin test sets `preview`. Restore every mutated var **delete-aware** in `afterEach` (`process.env.X = undefined` stores the string `"undefined"`). The admin fixture must return `tenants: { subdomain: "nihon-moment" }` from Task 3's join.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/__tests__/payments/hitpay-redirect.test.ts`

Expected to FAIL — **both** untrusted paths, not just supplied redirects:

| Test | Why it fails today |
|---|---|
| attacker-supplied redirect origin | the handler forwards any value |
| another tenant's origin | same |
| spoofed Host in the fallback | the fallback origin comes from `Host` |
| fallback built from the canonical DB ref | it currently uses the client's raw `enrollmentRef` |

The canonical-origin, PayNow-ignore and dev-origin tests **may already pass** against the old route, for the wrong reasons — the old code forwards everything, so "accepted" is not evidence. Only the post-enforcement green run proves the wiring. **If a test in the table above passes now, it is not testing what its name says** — fix the test before touching the route.

- [ ] **Step 3: Enforce**

Replace lines ~146-151:

```ts
// ── 7. Build redirect URL (card only) ──────────────────────────────────────
// Two untrusted paths, both closed here:
//   1. A supplied redirectUrl is client input — unvalidated it turns a genuine
//      HitPay link into a phishing redirect.
//   2. The fallback previously derived its origin from the inbound Host, which
//      is also request data. The generic payment page relies on this path.
// Fail closed. `?? ""` would fail OPEN: tenantOrigin() returns the PLATFORM
// ROOT for a falsy subdomain (`if (!subdomain) return url.origin`), so a join
// that came back missing or differently shaped would silently allowlist
// https://kuunyi.com — the one origin this design excludes — and aim the
// fallback at a page that does not exist. The column is non-null, so this
// should be unreachable; if it fires, the join shape is wrong.
const subdomain = enrollment.tenants?.subdomain;
if (!subdomain) {
  console.error("[hitpay] Tenant subdomain missing for enrollment", enrollment.id);
  return NextResponse.json(
    { error: "Internal Server Error", message: "Tenant origin could not be resolved." },
    { status: 500 },
  );
}

// nextUrl.origin, NOT a host/proto guess. `host.startsWith("localhost")` would
// label tenant.localhost:3005 and 192.168.50.3:3005 as https while the browser
// sends http, and exact-origin comparison would then reject real dev traffic.
// Verified: nextUrl.origin is correct for localhost, *.localhost, LAN IPv4,
// *.vercel.app and production.
const requestOrigin = request.nextUrl.origin;

// Trusted origin + the canonical DB ref (the client's enrollmentRef is only
// trimmed for the lookup, so the raw value can differ from what we matched).
const fallbackRedirectUrl =
  `${tenantOrigin(subdomain)}/enroll/payment/` +
  `${encodeURIComponent(enrollment.enrollment_ref)}?hitpay=success`;

// Card only, structurally. PayNow never receives a redirectUrl, so it must not
// validate the body field either — otherwise a rogue value 400s a PayNow request
// that would have ignored it.
let redirectUrl: string | undefined;
if (hitpayMethod === "card") {
  redirectUrl = fallbackRedirectUrl;

  if (clientRedirectUrl !== undefined) {
    if (
      typeof clientRedirectUrl !== "string" ||
      !isAllowedRedirect(clientRedirectUrl, subdomain, requestOrigin)
    ) {
      // Reject rather than silently substituting the fallback: a rejected value
      // is either an attack or a broken client, and both should surface.
      return NextResponse.json(
        { error: "Bad Request", message: "Invalid redirect origin." },
        { status: 400 },
      );
    }
    redirectUrl = clientRedirectUrl;
  }
}
```

Then pass `redirectUrl` **directly** at the `createPaymentRequest` call — replace the existing `redirectUrl: hitpayMethod === "card" ? redirectUrl : undefined` (line ~162) with `redirectUrl`, since the card gate now lives above and the ternary would be a second, drift-prone copy of the same rule.

Add `import { isAllowedRedirect } from "@/lib/payments/redirect-allowlist";` and `import { tenantOrigin } from "@/lib/origin";`. The `host`/`proto` locals are now unused — delete them.

**Note the fallback's remaining limitation, honestly:** on a preview deployment `tenantOrigin()` resolves to the *production* origin, so a client that sends nothing would be returned to production. Task 1 removes the only caller in that position; anything left is a stale client, and sending it to the real tenant page is strictly better than honouring a `Host` it doesn't control. Do **not** "fix" this by reintroducing the Host-derived fallback.

Adjust `enrollment.tenants?.subdomain` to whatever shape Task 1's join actually returns — Supabase renders a to-one join as an object or a single-element array depending on the relationship. **Confirm against the real response; do not guess.**

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/__tests__/payments/hitpay-redirect.test.ts`
Expected: PASS

- [ ] **Step 5: Check the staging hazard**

Confirm `NEXT_PUBLIC_APP_URL` on **staging**. If staging deploys with `VERCEL_ENV=preview`, the non-production branch covers it. If staging deploys as production **and** `NEXT_PUBLIC_APP_URL` is `https://kuunyi.com`, then `tenantOrigin("walmal")` is `walmal.kuunyi.com` while the student is on `walmal.staging.kuunyi.com` — **card returns will 400 on staging**. Fix by setting staging's `NEXT_PUBLIC_APP_URL` to `https://staging.kuunyi.com`, which is the correct value regardless. **Do not widen the allowlist to paper over a misconfigured env var.**

- [ ] **Step 6: Full suite, lint, build — as SEPARATE commands**

Do **not** chain these with `&&`. `dev` carries a known baseline failure, so the chain would stop at `npm test` and lint/build would never run.

```bash
npm test          # compare against the Task 1 baseline
npm run lint
npm run build
```

Expected: **no new failures beyond the baseline** — `scanner/events.test.ts` only. Lint clean. Build compiles. `hitpay-create.test.ts` must still pass; if its fixture lacks `tenants`, **fix the fixture, not the query**.

- [ ] **Step 7: Commit**

Per `CLAUDE.md`, check status, stage deliberately, then review the **staged** patch.
`git diff -- <path>` shows nothing for a *new* file, so only `--cached` proves what is
actually about to be committed. One command per line — PowerShell has no `&&`.

```powershell
git status --short
git add src/app/api/public/payments/hitpay/route.ts src/__tests__/payments/hitpay-redirect.test.ts
git diff --cached -- src/app/api/public/payments/hitpay/route.ts src/__tests__/payments/hitpay-redirect.test.ts
git commit -m "fix: validate the HitPay card redirect origin"
```

---

## Task 6: Open the PR

- [ ] **Step 1: Recheck git state**

The branch was created in Task 1; confirm nothing drifted and that unrelated files are still unstaged.

```powershell
git branch --show-current
git status --short
git fetch origin dev
git rev-list --left-right --count origin/dev...HEAD
```

Expect branch `fix/hitpay-redirect-allowlist`, and `git status` showing **only** the same unrelated state recorded in Task 1 Step 1, all still unstaged:

- `.claude/settings.local.json` (modified)
- `AGENTS.md` (untracked)
- `design_handoff_sponsor_placements/` (untracked)
- `docs/superpowers/plans/` and `docs/superpowers/reviews/` (untracked)

Anything else modified or staged is a stop condition. Never self-merge (`CLAUDE.md`).

- [ ] **Step 2: Review the complete diff**

Run: `git diff --stat origin/dev...HEAD`

Expected, exactly:

```
src/app/(public)/enroll/payment/[ref]/page.tsx      (Task 2)
src/app/api/public/payments/hitpay/route.ts         (Tasks 3, 5)
src/lib/tenant.ts                                   (Task 4 — isDevHost)
src/lib/payments/redirect-allowlist.ts              (Task 4)
src/__tests__/payments/redirect-allowlist.test.ts   (Task 4)
src/__tests__/payments/hitpay-redirect.test.ts      (Task 5)
```

Conditionally also `src/__tests__/payments/hitpay-create.test.ts`, if its enrollment fixture needed `tenants(subdomain)` for Task 3's join.

**Anything else is a stop condition** — in particular the plan/review docs, `AGENTS.md` and `design_handoff_sponsor_placements/` must not appear. Run `git diff origin/dev...HEAD` and confirm no secrets.

- [ ] **Step 3: Open the PR**

**This repo is public and the fix is not deployed** — describe the behaviour and the fix, **not** a working exploit recipe. State: pre-existing, unrelated to custom domains; this is P2 and unblocks P3; PayNow unaffected; no schema change.

---

## Verification after deploy

- [ ] A real card payment on a tenant subdomain completes and returns to that tenant's page
- [ ] A tampered `redirectUrl` returns 400 and creates no payment record
- [ ] PayNow QR still works (it never received a `redirectUrl`)
- [ ] The `EvTrustedOfficialTemplate` checkout page (`/enroll/[slug]/checkout/payment`) still returns correctly — it is one of the two callers

---

## Out of Scope

| Item | Why |
|---|---|
| **P3 — the tenant custom origin** | Belongs to the custom-domains rollout and needs this merged first. It adds `customOriginForTenant(subdomain)` to `allowedOrigins()` — one line in the helper, which is why the helper exists. Until then, a card return to `flashtic.com` is **correctly rejected**. |
| ~~The host-derived `fallbackRedirectUrl`~~ | **No longer out of scope — v1 was wrong.** Its origin came from the inbound `Host`, and the generic payment page actively relied on it. Now built from `tenantOrigin(subdomain)` in Task 4. |
| PayPay / Stripe return URLs | Server-built from `host`, with no client-supplied equivalent. Not the same defect. |
| Machine callbacks (ABank / MMQR) | Opposite treatment — pinned to the platform origin. Custom-domains plan, Task 5. |
