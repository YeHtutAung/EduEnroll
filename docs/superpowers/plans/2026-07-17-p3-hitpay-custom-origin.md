# P3 — HitPay Tenant Custom Origin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a student paying by card on `flashtic.com` return to `flashtic.com`. Today P2 **correctly rejects** that — the tenant's custom origin isn't in the allowlist.

**Architecture:** Add a reverse lookup (`slug → custom origin`) to the canonical tenant module, and add its result to P2's existing `allowedOrigins()`. One line at the extension point P2 built for exactly this. No schema change, no new dependency, no handler edit.

**Tech Stack:** TypeScript, Vitest.

**Scope:** This is the **last deployment blocker in code**. After it merges, the remaining gates are operational (production tenant confirmation, Vercel domain audit, sandbox payment).

---

## Revision history

**v2 (this document)** — revised after review. Three findings accepted; test-harness only, no design change.

| v1 said | Reality (verified) | v2 does |
|---|---|---|
| Task 2's tests call `customOriginForTenant()` | `tenant.test.ts` imports **only** `extractSubdomainFromHost`. The red phase would fail with `Cannot find name` — a reference error proving nothing about the module's exports — and would stay red after implementing until someone silently patched the import. A red test must fail for the reason its name claims. | Extend the import explicitly, as Step 1. |
| "Add `TENANT_CUSTOM_DOMAINS` to `ENV_KEYS`" | **Restoring is not resetting.** `afterEach` restores the *original* value, which may itself be set on a dev machine or in CI — so every test would start with an ambient map feeding `allowedOrigins()`. Latent today (verified: the current suite passes 15/15 with a rogue ambient map, because P2's allowlist never reads it) and **Task 3 makes it live**. | Reset in `prod()` and in the route test's `beforeEach()`, alongside the restore. |
| Test named "map is empty, unset or invalid" | Tested unset and invalid only. Set-but-empty is a distinct case the name claimed and didn't cover. | Adds `withMap("")`. |

---

## Written against real merged code

F1 (the sketch in the custom-domains plan) guessed wrong twice — it assumed `subdomain` was in scope in the HitPay handler, and that `platformOrigin()` belonged in the allowlist. Neither was true. So this plan is written against `dev` at `a02262e`, verified by reading:

| Fact | Verified |
|---|---|
| `domainMap()` in `src/lib/tenant.ts:140` is **private** | So `customOriginForTenant()` must live in `tenant.ts` — nothing else can reach the map. |
| `allowedOrigins(tenantSubdomain, requestOrigin)` in `src/lib/payments/redirect-allowlist.ts` | Already takes the slug. One `origins.add()` is the entire change. P2 created this seam for P3. |
| `parseTenantCustomDomains()` enforces **one domain per tenant** | So the reverse lookup is unambiguous — no canonical-choice problem. |
| tsconfig sets **no `"target"`** → defaults to ES5 | Direct `Map` iteration needs `--downlevelIteration` and **fails the build**. This already broke #166 once. Use `Array.from(map.entries())`. |

---

## Prerequisites — both met

| | Status |
|---|---|
| **P2** base HitPay redirect allowlist | ✅ merged (#165) |
| **Custom-domains Tasks 1–8** (the `TENANT_CUSTOM_DOMAINS` map) | ✅ merged (#166) |

P2 alone was **not** sufficient — `customOriginForTenant()` reads the map that #166 introduced. Tracking that as "blocked on P2" was wrong once already.

---

## Task 1: Branch from dev — DO THIS FIRST

**Nothing below may be edited until this completes.** The last two plans both put the branch check in the final task, and both would have committed to the wrong branch.

- [ ] **Step 1: Preserve unrelated state**

```powershell
git status --short
```

Expect only: `.claude/settings.local.json` (modified), `AGENTS.md`, `design_handoff_sponsor_placements/`, `docs/superpowers/plans/`, `docs/superpowers/reviews/` (untracked). **Not ours — do not stage, stash or clean.** If tracked `src/` files are modified, stop.

- [ ] **Step 2: Branch from a verified dev**

```powershell
git fetch origin dev
git rev-list --left-right --count origin/dev...dev
```

The **right-hand** count must be `0` — that means no divergence. A non-zero *left* count just means dev moved ahead and `pull --ff-only` will resolve it; that is not a stop condition. (A literal "expect 0 0" halted on a healthy repo last time.)

```powershell
git checkout dev
git pull --ff-only origin dev
git checkout -b fix/hitpay-custom-origin
git branch --show-current
```

- [ ] **Step 3: Record the baseline**

```powershell
npm test
```

Expect **exactly 1 failure — `src/__tests__/scanner/events.test.ts`**, pre-existing and unrelated. Write down the pass count. The bar below is **no new failures**, not a green suite.

---

## Task 2: The reverse lookup

**Files:**
- Modify: `src/lib/tenant.ts`
- Modify: `src/__tests__/lib/tenant.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the existing describe blocks — the file already has delete-aware `TENANT_CUSTOM_DOMAINS` restoration and a `withMap()` helper; reuse them, do not add a second setup.

**First extend the import.** The file currently imports only `extractSubdomainFromHost`. Without this the red phase fails with `Cannot find name 'customOriginForTenant'` — a reference error that proves nothing about the module's exports, and would stay red after implementing until someone silently patched the import. A red test must fail for the reason its name claims:

```ts
import { customOriginForTenant, extractSubdomainFromHost } from "@/lib/tenant";
```

```ts
describe("customOriginForTenant", () => {
  it("returns the tenant's configured custom origin", () => {
    withMap('{"flashtic.com":"flashtic"}');
    expect(customOriginForTenant("flashtic")).toBe("https://flashtic.com");
  });

  it("returns null for a tenant without one", () => {
    withMap('{"flashtic.com":"flashtic"}');
    expect(customOriginForTenant("nihon-moment")).toBeNull();
  });

  it("returns null when the map is unset, empty or invalid", () => {
    delete process.env.TENANT_CUSTOM_DOMAINS;
    expect(customOriginForTenant("flashtic")).toBeNull();
    withMap(""); // set-but-empty is a distinct case from unset
    expect(customOriginForTenant("flashtic")).toBeNull();
    withMap("{not json");
    expect(customOriginForTenant("flashtic")).toBeNull();
  });

  // Entries the parser drops must not be reachable through the back door.
  it("returns null for a tenant whose entry was rejected", () => {
    withMap('{"kuunyi.com":"evil","bad host":"broken"}');
    expect(customOriginForTenant("evil")).toBeNull();
    expect(customOriginForTenant("broken")).toBeNull();
  });

  // parseTenantCustomDomains keeps only the first host per tenant, so this is
  // unambiguous by construction rather than by luck.
  it("is unambiguous when two hosts name the same tenant", () => {
    withMap('{"one.com":"flashtic","two.com":"flashtic"}');
    expect(customOriginForTenant("flashtic")).toBe("https://one.com");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```powershell
npx vitest run src/__tests__/lib/tenant.test.ts
```

Expected: FAIL — `customOriginForTenant` is not exported.

- [ ] **Step 3: Implement**

Add to `src/lib/tenant.ts`, next to `tenantForCustomHost()`:

```ts
/**
 * The tenant's configured custom origin, or null. Always https — a custom
 * domain only exists in production, where Vercel provisions TLS.
 *
 * Unambiguous by construction: parseTenantCustomDomains() keeps only the first
 * host per tenant, so there is never a canonical choice to make here.
 */
export function customOriginForTenant(slug: string): string | null {
  // Array.from, not `of map` — tsconfig sets no "target", so it defaults to ES5
  // and direct Map iteration needs --downlevelIteration. This exact pattern
  // already broke the build once.
  for (const [host, mapped] of Array.from(domainMap().entries())) {
    if (mapped === slug) return `https://${host}`;
  }
  return null;
}
```

- [ ] **Step 4: Run to verify they pass**

```powershell
npx vitest run src/__tests__/lib/tenant.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git status --short
git add src/lib/tenant.ts src/__tests__/lib/tenant.test.ts
git diff --cached -- src/lib/tenant.ts src/__tests__/lib/tenant.test.ts
git commit -m "feat: add reverse lookup from tenant slug to custom origin"
```

---

## Task 3: Allow the custom origin for its own tenant

**Files:**
- Modify: `src/lib/payments/redirect-allowlist.ts`
- Modify: `src/__tests__/payments/redirect-allowlist.test.ts`

**The cross-tenant test is the point of this task.** Adding the custom origin is trivial; adding it *only for its mapped tenant* is the requirement. `flashtic.com` must be accepted for `flashtic` and rejected for every other tenant.

- [ ] **Step 1: Make the suite independent of ambient config, then write the failing tests**

The file already has delete-aware `NEXT_PUBLIC_APP_URL`/`VERCEL_ENV` restoration and a `prod()` helper. Two changes are needed, and they do different jobs:

**Add `TENANT_CUSTOM_DOMAINS` to `ENV_KEYS`** so it is *restored* delete-aware after each test — the existing list does not include it.

**And reset it in `prod()`**, because restoring is not resetting:

```ts
function prod() {
  process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
  process.env.VERCEL_ENV = "production";
  delete process.env.TENANT_CUSTOM_DOMAINS; // start from no map, not the machine's
}
```

`afterEach` restores the *original* value — but the original may itself be set, on a developer machine or in CI. Then every test starts with an ambient map feeding `allowedOrigins()`, and results depend on the environment rather than the test.

**This is latent today and Task 3 makes it live.** Verified: running the current suite with `TENANT_CUSTOM_DOMAINS` set to a rogue map still passes 15/15, because P2's allowlist never reads it. The moment Task 3 wires `customOriginForTenant()` in, an ambient entry can silently allow an origin a test asserts is rejected. Fix it in the same change that creates the exposure.

Custom-domain tests call `prod()` first, then set the map they need.

```ts
describe("isAllowedRedirect — tenant custom origin", () => {
  it("allows a tenant's configured custom origin in production", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(
      isAllowedRedirect("https://flashtic.com/enroll/x?hitpay=success", "flashtic", REQ_ORIGIN),
    ).toBe(true);
  });

  // THE REQUIREMENT: the custom origin is allowed for ITS tenant only.
  it("rejects one tenant's custom origin for a different tenant", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(isAllowedRedirect("https://flashtic.com/enroll/x", "nihon-moment", REQ_ORIGIN)).toBe(
      false,
    );
  });

  it("rejects a custom origin lookalike", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(isAllowedRedirect("https://flashtic.com.evil.com/x", "flashtic", REQ_ORIGIN)).toBe(false);
  });

  it("rejects a credential-bearing custom origin", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(isAllowedRedirect("https://user:pass@flashtic.com/x", "flashtic", REQ_ORIGIN)).toBe(
      false,
    );
  });

  it("still allows the tenant's canonical origin when it has a custom domain", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(isAllowedRedirect("https://flashtic.kuunyi.com/enroll/x", "flashtic", REQ_ORIGIN)).toBe(
      true,
    );
  });

  // No map configured is the state everywhere today: behaviour must not change.
  it("changes nothing for a tenant with no custom domain", () => {
    prod();
    delete process.env.TENANT_CUSTOM_DOMAINS;
    expect(isAllowedRedirect("https://flashtic.com/x", "flashtic", REQ_ORIGIN)).toBe(false);
    expect(isAllowedRedirect(`${REQ_ORIGIN}/enroll/x`, "nihon-moment", REQ_ORIGIN)).toBe(true);
  });
});
```

Note `REQ_ORIGIN` is `https://nihon-moment.kuunyi.com` in that file — the cross-tenant test therefore also proves the request origin doesn't smuggle the allowance in.

- [ ] **Step 2: Run to verify they fail**

```powershell
npx vitest run src/__tests__/payments/redirect-allowlist.test.ts
```

**Exactly one test should fail:** "allows a tenant's configured custom origin in production". Everything else passes already, and for two different reasons:

| Test | Red phase | Why |
|---|---|---|
| allows a tenant's configured custom origin | **FAIL** | the only real red — the origin isn't allowed yet |
| still allows the canonical origin / changes nothing without a map | PASS | correct already; these are regression guards |
| rejects cross-tenant / lookalike / credential-bearing | PASS — **for the wrong reason** | nothing is allowed yet, so "rejected" is trivially true |

The rejection tests earn their keep only in the **green** run, once the origin is allowed for *someone*. **If more than one test fails here, stop** — the harness is wrong, not the code.

- [ ] **Step 3: Implement**

In `allowedOrigins()`, after the canonical origin:

```ts
// The tenant's own custom domain, when configured. Scoped to THIS tenant by
// construction — the lookup is by slug, so another tenant's domain can never
// appear here. Unlike the dev-host exception below, this applies in production:
// serving students on a branded domain is the entire point.
const custom = customOriginForTenant(tenantSubdomain);
if (custom) origins.add(custom);
```

Add `customOriginForTenant` to the existing `@/lib/tenant` import.

- [ ] **Step 4: Run to verify they pass**

```powershell
npx vitest run src/__tests__/payments/redirect-allowlist.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git status --short
git add src/lib/payments/redirect-allowlist.ts src/__tests__/payments/redirect-allowlist.test.ts
git diff --cached -- src/lib/payments/redirect-allowlist.ts src/__tests__/payments/redirect-allowlist.test.ts
git commit -m "feat: allow a tenant's custom origin in the HitPay redirect allowlist"
```

---

## Task 4: Prove the route honours it

**Files:**
- Modify: `src/__tests__/payments/hitpay-redirect.test.ts`

Pure tests prove the decision; route tests prove the handler *consults* it. PR #163 showed a handler drifting while every pure test stayed green.

- [ ] **Step 1: Write the failing test**

The file's fixture uses subdomain `nihon-moment`; set the map to match.

```ts
describe("HitPay card redirect — tenant custom domain", () => {
  it("accepts a return to the tenant's custom domain", async () => {
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"nihon-moment"}';
    const url = "https://flashtic.com/enroll/x?hitpay=success";
    const res = await POST(card(url));
    expect(res.status).not.toBe(400);
    expect(sentRedirect()).toBe(url);
  });

  it("rejects a custom domain mapped to a different tenant", async () => {
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"some-other-tenant"}';
    const res = await POST(card("https://flashtic.com/enroll/x"));
    expect(res.status).toBe(400);
  });
});
```

**Two changes to that file's harness**, same reasoning as Task 3: add `TENANT_CUSTOM_DOMAINS` to its `ENV_KEYS` so it *restores* delete-aware, **and** reset it in `beforeEach()` so tests start from no map rather than the machine's:

```ts
beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
  process.env.VERCEL_ENV = "production";
  delete process.env.TENANT_CUSTOM_DOMAINS; // ambient config must not reach the allowlist
  setupMocks();
});
```

The custom-domain tests set their map after that.

- [ ] **Step 2: Run to verify it fails**

```powershell
npx vitest run src/__tests__/payments/hitpay-redirect.test.ts
```

Expected: the accept test FAILS with 400 — P2 correctly rejects it today.

- [ ] **Step 3: No implementation needed**

Task 3 already did it. If this passes without a code change, that is the seam working. **If it still fails, stop** — the handler is not consulting the allowlist the way Task 3 assumes.

- [ ] **Step 4: Commit**

```powershell
git status --short
git add src/__tests__/payments/hitpay-redirect.test.ts
git diff --cached -- src/__tests__/payments/hitpay-redirect.test.ts
git commit -m "test: pin custom-domain card returns at the route level"
```

---

## Task 5: Verify and open the PR

- [ ] **Step 1: Gates — separately, never chained**

`dev` carries a known baseline failure, so `&&` would stop at `npm test` and lint/build would never run. PowerShell has no `&&` anyway.

```powershell
npm test
npm run lint
npm run build
```

- **`npm test`**: no new failures beyond the `scanner/events.test.ts` baseline.
- **`npm run build`**: judge by **exit code**, not output. `next build` prints "Compiled successfully" and *then* type-checks — that line is not the verdict. This is how a broken build shipped once.

- [ ] **Step 2: Review the complete diff**

```powershell
git branch --show-current
git status --short
git fetch origin dev
git rev-list --left-right --count origin/dev...HEAD
git diff --stat origin/dev...HEAD
```

Expected, exactly:

```
src/lib/tenant.ts
src/lib/payments/redirect-allowlist.ts
src/__tests__/lib/tenant.test.ts
src/__tests__/payments/redirect-allowlist.test.ts
src/__tests__/payments/hitpay-redirect.test.ts
```

**Anything else is a stop condition** — in particular `hitpay/route.ts` must NOT appear. If it does, the change was made in the handler instead of the allowlist, and P2's seam was bypassed.

- [ ] **Step 3: Open the PR**

Branch off `dev`, PR for review, **never self-merge** (`CLAUDE.md`). The repo is **public** — describe behaviour, not exploit recipes.

State: this is the last code-level deployment blocker; the remaining gates are operational.

---

## Deployment gates after this merges

None are code, and none can be closed by tooling:

- [ ] **Confirm `flashtic` in the production superadmin UI** maps to the school owning `flashtic.com`. The preflight cannot — dev and prod hold different tenants.
- [ ] **Audit Vercel's assigned domains** for any relying on the generic 3-part fallback #166 removed.
- [ ] **One sandbox card payment** on the custom domain, returning to it.
- [ ] **Confirm staging's `NEXT_PUBLIC_APP_URL`** is `https://staging.kuunyi.com`. If staging deploys as production carrying the prod value, card returns 400 there — fix the env var, do not widen the allowlist.
- [ ] **Issue #164** (tenant header / agent contract) — the plan's merge gate.

---

## Out of Scope

| Item | Why |
|---|---|
| `tenantOrigin()` returning the custom domain | Student emails/SMS still link to `flashtic.kuunyi.com/status`. Functional, unbranded. Touches live outbound messaging. **`platformOrigin()` exists so that PR cannot move payment callbacks by accident.** |
| Tenant-aware `app/page.tsx` | The better answer than redirecting `/`. A page design, not this. |
| PayPay / Stripe returns | Server-built from `host`, no client-supplied equivalent. Not the same defect. |
