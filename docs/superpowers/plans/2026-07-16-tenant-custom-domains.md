# Tenant Custom Domains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant serve their student-facing enrollment pages on their own domain (`flashtic.com`) while staff continue to use the tenant's kuunyi subdomain (`flashtic.kuunyi.com`).

**Architecture:** One deployment, one database, no new Vercel project, no migration. Custom-domain resolution is added to the **single canonical host→tenant resolver** (`extractSubdomainFromHost()` in `src/lib/tenant.ts`), which every server layout, `resolveTenantId()`, and middleware already depend on. Middleware's byte-identical duplicate is deleted in favour of importing it. The **whole request path** becomes an allowlist: a host resolves to a tenant only if it is a kuunyi subdomain, a Vercel preview, localhost, or explicitly configured — never by inference, and never via `?tenant=`/cookie/dev-env on a production host. Machine callbacks pin to a stable `platformOrigin()`; customer return URLs stay branded.

**Tech Stack:** Next.js 14 middleware (edge runtime), TypeScript, Vitest, Vercel, Namecheap DNS.

---

## Prerequisites — must land before deployment

This plan is **domain work only**. Two pre-existing vulnerabilities surfaced during review of v2; both are unrelated to custom domains and are tracked separately, on the principle that a live security fix should not wait on domain review.

**Three** distinct changes must be merged and deployed before DNS or production env configuration. They are separate pieces of work; naming them individually prevents "the HitPay PR" being read as covering both HitPay items.

| # | Prerequisite | Status | Why it blocks |
|---|---|---|---|
| P1 | **ABank callback verification** | PR #163 — open, unreviewed | The callback trusted its own inbound params. v2's Task 4 modified this flow, which is how review found it. Must be deployed before more traffic reaches ABank. |
| P2 | **Base HitPay redirect allowlist** | **Not yet written** | `hitpay/route.ts:151` accepts an unvalidated client `redirectUrl`. Rejects arbitrary client-provided redirect origins. Independent of custom domains — a pre-existing vulnerability. |
| P3 | **F1: HitPay tenant custom-origin extension** | **Blocked on P2** | Permits the configured custom origin *for its mapped tenant only*, without permitting another tenant's. P2 alone would **reject** `flashtic.com` returns, breaking HitPay card payments on the custom domain. |

**P2 and P3 solve different problems and deployment needs both.** P2 closes the open redirect; P3 makes the custom domain work with it. Tasks 1-8 depend on neither and can be implemented, reviewed and merged first — but the domain must not go live until all three are deployed.

**No alternative path.** v3.1 offered "disable HitPay card payments for the initial rollout"; withdrawn as unspecified (see F1).

---

## Revision history

**v3.8 (this document)** — the v3.7 review **approved the plan for implementation** with one optional Low finding, folded in here: the MMQR callback test now saves/sets/restores `MMPAY_MODE` delete-aware and forces the sandbox branch explicitly, so an inherited `MMPAY_MODE=production` can't cause an environment-dependent failure. No other change. **The eight-task plan is approved and ready to execute.**

**v3.7** — revised after the v3.6 review. All three findings accepted; Task 5 test-harness only. No architectural change.

| v3.6 said | Reality (verified) | v3.7 does |
|---|---|---|
| Task 5 callback test mocks `createAdminClient` + provider clients | **Insufficient.** Both routes call `resolveTenantId()` as their *first* line (`abank/route.ts:12`, `mmpay/route.ts:14`), which calls `next/headers()` outside a request context and **throws before the provider spy is reached**. The test's red/green would prove nothing about callbacks. | Mock `@/lib/api`'s `resolveTenantId` too — the established repo pattern. |
| One concrete assertion, for ABank; MMQR "the equivalent" | Step 8 rewrites the callback in **both** `abank` and `mmpay`. An ABank-only test lets MMQR keep deriving from the inbound host. Verified: MMQR default is sandbox → `mmpay.sandboxPay`, callback `/api/sandbox/payments/webhook`. | Adds a required MMQR provider-spy assertion on the default sandbox path. |
| `postTo()` and fixtures referenced but undefined | An implementer could build a helper that 400s on empty JSON or 404s on a missing enrollment, and the spy would never fire — a green test proving nothing. | States the minimum contract: valid JSON POST body; admin stub returns a payable pending enrollment before the payment insert. |

**v3.6** — revised after the v3.5 review. Both findings accepted; mechanical test-hygiene fixes only. No architectural change.

| v3.5 said | Reality | v3.6 does |
|---|---|---|
| "All remaining `afterEach` matches are prose warnings — both clean" | **Wrong.** That check grepped Task 4's range only, then declared the whole document clear. Task 1 still restored with `process.env.TENANT_CUSTOM_DOMAINS = original`, and Task 5 modifies `origin.test.ts`, whose existing `afterEach` has the same pattern. Same failure as the last three rounds: fix it in one place, claim it everywhere. | Both made delete-aware. |
| Task 5 adds a `platformOrigin()` fallback test that deletes `NEXT_PUBLIC_APP_URL` | The existing `afterEach` in `origin.test.ts` then writes back the **string `"undefined"`**, which `platformOrigin()` hands to `new URL()` — **which throws**. This task would have broken the file it edits. | Task 5 Step 1 repairs that cleanup *before* adding tests; `callback-urls.test.ts` gets its own delete-aware restoration for both vars it mutates. |

**v3.5** — revised after the v3.4 review. All five findings accepted. The review **executed** the plan's test scaffold against the installed runtime and found it inert; that was the headline.

| v3.4 said | Reality (verified by running it, 2026-07-17) | v3.5 does |
|---|---|---|
| Middleware tests built as `new NextRequest(new Request(url))` — since v2 | **`.headers.get("host")` is `null`.** Middleware reads `request.headers.get("host") ?? ""`, **not** `nextUrl`, so every test handed it an **empty host**. `extractSubdomainFromHost("")` → null for *all* cases: the custom-domain, subdomain, root-domain, preview, LAN and forged-header tests would each have passed or failed for reasons unrelated to their names. Host resolution is this feature's primary security boundary, and four revisions of tests never touched it. Nobody ran them until this review. | A required `middlewareRequest()` factory sets `host` from the URL. Verified in this runtime: `Headers.set("host", …)` works under Node/undici (it is forbidden only in browsers) and preserves caller headers. |
| Task 3 creates and runs `middleware.test.ts` | Its snippet had **no imports and no `@supabase/ssr` mock** — those appeared only in Task 4, which runs later. Task 3 could not compile, let alone reach red/green. | Task 3 owns the complete scaffold: imports, mock, env restoration, factory. Task 4 appends cases only. |
| Task 4 opened with `const original = …; afterEach(() => { process.env.X = original })` | Restores the **string `"undefined"`** when the var was absent — the exact order-dependent leak v3.2 fixed elsewhere in this document, reintroduced in a second setup block. | Duplicate setup deleted; Task 4 reuses Task 3's delete-aware `restoreEnv()`. |
| Live F2: "It grants nothing today" | v3.4 accepted this correction in the revision table and **left the live sentence unchanged**. The corrected wording existed twenty lines away in the same document. | Live F2 carries the narrower, evidence-backed wording. |
| F2 "tracked" as `task_47d00374` | A session task chip. Not in the repo, no owner, no priority, does not outlive the session. Recording it as tracking was self-deception. | Stated plainly as not durable, with a pre-merge requirement to open a real issue and record its URL. |

**v3.4** — revised after the v3.3 review. All six findings accepted.

| v3.3 said | Reality | v3.4 does |
|---|---|---|
| Deployment: "PR #163 (ABank) and the HitPay allowlist PR must be merged and deployed first" | v3.3 added the P1/P2/P3 table at the top and **left this sentence stale**. "The HitPay allowlist PR" reads as P2 alone. An operator following the Deployment section could configure DNS after P2 but before P3 — which **rejects legitimate `flashtic.com` HitPay returns**. Exactly the trap v3.3 documented, then failed to close. | All three named at the deployment gate. |
| "`VERCEL_ENV` … Vercel also exposes **custom environment names**" | **Wrong, and self-inflicted.** The v3.2 review asserted this; v3.3 wrote it in without checking. Vercel's docs (verified 2026-07-17): `VERCEL_ENV` is exactly `production` \| `preview` \| `development`; `VERCEL_TARGET_ENV` is the one carrying custom names. Reviewer claims get verified — that rule was applied to every code claim and skipped for a docs claim. | Three values restored; `VERCEL_TARGET_ENV` noted as the escape hatch that isn't needed. |
| Task 3: "unknown production host must not obtain tenant context by **ANY route**" | Overclaims. v3.3 *deliberately* left caller-supplied `x-tenant-slug` in place (F2), so "ANY route" is false in the same document that explains why. A future audit reading the test name would over-credit the fix. | Test group and comments narrowed to query/cookie/env, with F2 named beside them. |
| Step 6: "verify a signed agent request still authenticates" | Prose with no command, fixture, or assertion — and **this is the claim that justified dropping header sanitization**. `npm test` could pass while proving nothing. | A concrete regression test, marked temporary and linked to F2. |
| F2 "filed" as a section in this plan | A section in a plan that gets archived on merge is not tracking. | Raised as a separately tracked task; its id is recorded in F2. |
| "It grants nothing today" | Too absolute. A forged header **does** select tenant context for public routes on the service-role client — enrollment, status, bank-accounts, uploads, payment creation. No *incremental* privilege was identified because those are reachable on the tenant's own subdomain, but that is a narrower statement than "grants nothing". | Reworded, with the affected consumers listed for F2. |

**v3.3** — revised after the v3.2 review. Both release blockers resolved, one by **removing scope rather than adding it**.

| v3.2 said | Reality | v3.3 does |
|---|---|---|
| "Nothing in this codebase sends `x-tenant-slug` inbound (verified)" | **False, and the evidence was on screen.** `requireAuth()` (`api.ts:60-66`) *requires* that inbound header for signed agent requests and grants `role: "owner"` on the named tenant (line 99). The v3.2 grep printed `api.ts:63` — the line reading `"x-tenant-slug header required."` — and it was filed as a sender without being read. The proposed delete would 400 every agent payment-verification call. | **Remove the header deletion from this plan entirely.** See below. |
| Header deletion is "unconditional" | It isn't. The proposed insertion point (~line 80) sits **inside** `if (!shouldSkipTenant(pathname))` (lines 67-89), so `/api/messenger/*`, `/api/saas/*`, `/api/events`, `/api/scans` and `/superadmin` would retain the caller's header regardless. | Moot — the deletion is gone. |
| F1 moved out of the sequence | The rest of the document did not follow: File Structure still listed `hitpay/route.ts`, Task 8's expected diff still included it, Deployment named one HitPay prerequisite where two exist, and Verification still expected a custom-domain HitPay return. Tasks 1-8 could be executed and *look complete* while producing a PR with no HitPay support. | Two prerequisites named explicitly; HitPay removed from File Structure, Task 8's diff, and Verification. |
| "`VERCEL_ENV` is `production` \| `preview` \| `development`" | This was **correct**, and v3.3 wrongly "fixed" it — see below. | Restored, with the source verified. |

### Why the header deletion is out of scope (scope pushback)

The v3.2 review's direction is right — a client-supplied header should not name a tenant. But it does not belong in *this* plan:

1. **Custom domains already overwrite it.** On `flashtic.com`, `tenantSlug` resolves to `flashtic` and `requestHeaders.set()` replaces any inbound value. The header only survives where **no tenant resolves** — the platform root or an unknown host. This plan neither creates nor worsens that.
2. **No *additional* capability beyond the tenant's public subdomain was identified.** Stated precisely, because "grants nothing" was too absolute: a forged header **does** select tenant context for public routes running on the service-role client — enrollment creation, status lookup, bank-account listing, uploads, payment creation. Those operations are intentionally public and already reachable on that tenant's own subdomain, and headers can only be set on one's own request, so no privilege escalation was found. It is still a real trust-boundary effect, which is why F2 exists rather than being closed as a non-issue.
3. **The fix collides with a live privileged integration.** Sanitizing the header requires deciding the agent contract — host-derived tenant (needs a bot deployment) or a versioned HMAC payload binding the slug (needs a coordinated bot/server migration plus replay defenses). Neither is custom-domain work, and bundling a live integration change into a domain PR is the same mistake already rejected for ABank and HitPay.

Filed as **Follow-up F2**. Task 3 keeps the `?tenant=` / cookie / `NEXT_PUBLIC_DEV_TENANT` restriction, which is the actual release blocker and **does not touch the agent path**: agent calls arrive on `kuunyi.com`, where `isRootDomain` already suppresses that fallback today, so behaviour is unchanged.

**This plan's allowlist claim is therefore narrowed, deliberately:** unknown and unconfigured hosts cannot *infer* a tenant, and query/cookie/env cannot select one in production. A client-supplied `x-tenant-slug` on a host where no tenant resolves is **out of scope and still honoured** — tracked in F2. Stating that plainly is better than a claim the code doesn't support.

**v3.2** — revised after the v3.1 review. All five findings accepted; one recommended *fix* is strengthened (see below).

| v3.1 said | Reality | v3.2 does |
|---|---|---|
| "Confirm an inbound `x-tenant-slug` header cannot survive… **if** it can, delete it" | It **does** survive — not conditionally. `middleware.ts:54` starts `new Headers(request.headers)`, and the header is only overwritten `if (tenantSlug)`. When resolution yields null, the client's value is forwarded to all five readers, including `resolveTenantId()` (`api.ts:60`). v3.1 hedged on a fact it could have checked. | Delete it **unconditionally**. Task 3. |
| Preflight is "restricted to EduEnroll-dev" | Restricted only by `.env.local` happening to point there. A doc sentence is not a guard. | Assert the Supabase hostname is exactly `fnfvwzwrdsnmwxunciti.supabase.co` **before** constructing the client, or throw. Task 7. |
| Task 6 (HitPay) marked PROVISIONAL but left in the executable sequence | An unimplementable task in a numbered sequence invites an executor to attempt it. | Removed from the sequence into a separate blocked follow-up section. |
| `DomainMapIssue { entry, reason }` | The preflight can't name the offending host without reparsing the JSON it was handed. | Add optional `host`. Runtime still logs counts only. Task 1. |
| Tests assign the saved value back in `afterEach` | `process.env.X = undefined` stores the **string** `"undefined"`, not an absent var — leaking state between tests and causing order-dependent failures. | `restoreEnv()` helper using `delete` when the original was absent. Tasks 1, 3, 4, 5. |

**Strengthening the header fix.** The review proposes:

```ts
if (!tenantSlug && !isRootDomain) requestHeaders.delete("x-tenant-slug");
```

On `kuunyi.com`, `tenantSlug` is null and `isRootDomain` is **true**, so this never fires and the inbound header still reaches `resolveTenantId()`. The guard covers `flashtic.evil.com` — which Vercel will not route — and misses `kuunyi.com`, which is live and matched for `/api/:path*`.

> ⚠️ **Superseded by v3.3 — the paragraph that followed here was wrong.** It claimed "nothing in the codebase sends this header inbound (verified: middleware is its only writer)". `requireAuth()` at `api.ts:60-66` *requires* it for signed agent requests. The "verification" behind that claim was a grep whose output included `api.ts:63` — the line reading `"x-tenant-slug header required."` — misfiled as a sender without being read. The unconditional deletion v3.2 specified would have 400'd every agent payment-verification call. The whole header question moved to Follow-up F2; the gap analysis above still stands, but it is no longer this plan's to fix.

**Severity, honestly.** This is not a live privilege escalation. An attacker can only set headers on their *own* request, and everything reachable via a forged `x-tenant-slug` on `kuunyi.com` is already reachable on that tenant's own subdomain — so it grants nothing new today. It matters because this plan *claims* the request path is an allowlist, and that claim is false while any client-supplied value can name a tenant.

**v3.1** — revised after the v3 review. All eight findings accepted. Three were plain errors in v3:

| v3 said | Reality | v3.1 does |
|---|---|---|
| "The resolver is an allowlist… `?tenant=` cannot override" | **Only true for *configured* hosts.** For an *unknown* host, `isRootDomain` is false, so the fallback at `middleware.ts:72` still runs: `https://flashtic.evil.com/enroll?tenant=flashtic` acquires tenant `flashtic` after the resolver returns `null`. v3 removed inference from the resolver and left the back door open one layer up. **Release blocker.** | Restrict the fallback to dev hosts outside production. New Task 3. |
| Task 6: "use the **same** `domainMap()` from `src/lib/tenant.ts`" | **Impossible as written.** `domainMap()` is private and keeps only a rejection *count*; the preflight needs per-entry reasons. The task could not be implemented. | Export `parseTenantCustomDomains(raw) → { map, issues }`. Runtime warns with counts; preflight prints issues. Task 1. |
| Deployment step 1: run the preflight "against the production DB" | **Violates `CLAUDE.md`**: "NEVER access production DB (Mumbai) directly / PROD DB ref: nhxmumcvgnxlczjsgctz — OFF LIMITS". v3 instructed an agent to break an explicit project rule. | Script runs against **dev only**. Production mapping is confirmed by a human via superadmin. Task 6 + Deployment. |
| "A 307 on POST can drop the body or degrade to GET" | **Factually wrong**, and repeated in v1–v3. 307 *preserves* method and body — that is precisely what distinguishes it from 302. | Corrected. The 404 policy stands on its real merits. |
| `npx tsx scripts/verify-custom-domains.ts` | `tsx` is not installed (verified: absent from `package.json`, no binary in `node_modules/.bin`). | `node --env-file=.env.local --experimental-strip-types`, with relative `.ts` imports — matching `scripts/seed-e2e.ts` and `scripts/create-scanner-key.ts`. |
| Task 5 (HitPay) written against an assumed structure | The prerequisite PR does not exist, so the patch and `subdomain` variable are guesses. | Marked **provisional**; must be rewritten against the merged code. Task 6. |

**One adjustment to the review's recommended fix.** The review proposes gating the fallback on `process.env.NODE_ENV !== "production"`. **Vercel preview deployments run with `NODE_ENV=production`**, and `.github/workflows/staging-tests.yml` targets `https://edu-enroll-xi-git-staging-xxx.vercel.app` — a 3-part host that resolves to `null` (the `.vercel.app` branch requires ≥4 parts) and therefore *depends* on this fallback. `NODE_ENV` gating would break staging CI. v3.1 gates on **`VERCEL_ENV`** (`production` | `preview` | `development`), which distinguishes preview from production. The finding is accepted in full; only the lever changes.

**v3** — revised after the v2 review, which was accepted in full. Changes:

| v2 said | Reality | v3 does |
|---|---|---|
| Resolver keeps the generic `parts.length >= 3` fallback; unreachable because "Vercel won't serve a domain not added to the project" | **Wrong to rely on.** `flashtic.evil.com` resolves to tenant `flashtic` with no configuration. Tenant isolation must not depend solely on hosting config. It also mis-resolves the LAN test host `192.168.50.3` to tenant `"192"`. | Remove it. Unknown hosts return `null`. Task 1. |
| Callbacks use `tenantOrigin()` | Neither payment route has `tenantInfo` (v2 asked the implementer to "find it" — it isn't there), and v2's own Deferred section planned to make `tenantOrigin()` custom-domain-aware, which would silently move callbacks **back** onto client-controlled domains. A note asking a future PR not to break it is not a safeguard. | Add `platformOrigin()`, which cannot drift. Task 4. |
| `/register` and `/superadmin` → tenant subdomain | Contradicted v2's own routing table, which placed both at the platform root. They are root-platform surfaces, not tenant ones. | `/register`, `/superadmin` → `kuunyi.com`. `/admin`, `/login`, `/onboarding` → tenant subdomain. Task 3. |
| Slug regex `/^[a-z0-9][a-z0-9-]{0,62}$/` | Accepts a trailing hyphen (`school-`). | Require an alphanumeric last character. Task 1. |
| Invalid map entries dropped silently | A config error surfaces only as generic branding or tenant-not-found — the hardest failure to diagnose. | Redacted startup warning + preflight script. Tasks 1 and 6. |
| Tenant existence verified manually post-deploy | Accepted in principle: a valid-but-wrong slug routes real enrollments and payments to another real tenant. | Read-only preflight script. Task 6. **Still not a request-path DB query** — that position from v2 stands and the review agreed. |
| Callback correctness verified by grep + live payment | Not good enough for a payment path. | Route-level tests with mocked deps. Task 4. |

---

## Context

### The rule

**`flashtic.kuunyi.com` = staff. `flashtic.com` = students.**

Both hostnames hit the same deployment, so both serve every route by default. The split is *enforced*, not inherent.

### Routing map

| Path | `flashtic.com` | `flashtic.kuunyi.com` |
|---|---|---|
| `/` | 307 → `flashtic.com/enroll` | SaaS landing (unchanged) |
| `/enroll/*`, `/status` | **primary** | still works (dup — see Deferred) |
| `/api/public/*` | **serves** | still works (dup) |
| `/admin/*`, `/login`, `/onboarding` | 307 → **tenant subdomain** | **primary** |
| `/register`, `/superadmin` | 307 → **`kuunyi.com` root** | root only |
| `/api/admin/*`, `/api/saas/*`, `/api/superadmin/*` | 404 | **serves** |
| `/api/webhooks/*`, `/api/payments/webhook`, `/api/sandbox/*` | untouched | untouched |

**`/` redirects because `app/page.tsx` is not tenant-aware** — it renders the KuuNyi SaaS landing for every host, which must not be a client's homepage. Making it tenant-aware is the better long-term answer (Deferred).

**Pages redirect, APIs 404.** Not because a 307 would corrupt the request — 307 preserves method and body; that is what distinguishes it from 302. The reason is that redirecting an API call **cross-origin** is a poor contract: a browser `fetch()` following it hits CORS on a different origin and fails opaquely, and an API client expects a status rather than a hop to another host. A 404 is unambiguous. Humans following a link benefit from a redirect; machines don't.

### Payment URLs: two kinds, opposite treatment

| Provider | Line | Builds | Kind | Correct domain |
|---|---|---|---|---|
| ABank | `abank/route.ts:119` | `callbackUrl` | machine→machine | **`platformOrigin()`** (Task 4) |
| MMQR | `mmpay/route.ts:135` | `callbackUrl` | machine→machine | **`platformOrigin()`** (Task 4) |
| HitPay | `hitpay/route.ts:150` | `fallbackRedirectUrl` | customer return | branded — correct as-is |
| PayPay | `paypay/route.ts:118` | `redirectUrl` | customer return | branded — correct as-is |
| Stripe | `stripe/route.ts:190` | `baseUrl` | customer return | branded — correct as-is |

Return URLs already work: the student is *on* `flashtic.com`, so `host` yields `flashtic.com`. Only callbacks need pinning. Stripe's webhook is registered in its dashboard against `kuunyi.com` and is unaffected.

Webhook handlers locate payments by provider identifiers, not hostname, so a callback needs no tenant context — which is why `platformOrigin()` (no tenant argument, no extra query) is the right shape.

### Security properties

1. **The resolver is an allowlist.** After Task 1, a host resolves to a tenant only if it is a kuunyi subdomain, a Vercel preview, localhost, or explicitly configured. `flashtic.evil.com` → `null`.
2. **The request path is an allowlist too.** Task 3 restricts the `?tenant=` / cookie / `NEXT_PUBLIC_DEV_TENANT` fallback to dev hosts outside production. Without it, property 1 is cosmetic: an unknown host still acquires tenant context from a query param after the resolver returns `null`.
3. **`?tenant=` cannot override a custom domain.** The fallback chain at `middleware.ts:72` is guarded by `if (!tenantSlug && …)`. Once the resolver returns `flashtic`, `tenantSlug` is truthy and the fallback never runs. Middleware is the **only** reader of the `tenant` search param (verified by grep).
4. **A custom domain cannot claim the platform.** Reserved hosts (`kuunyi.com`, `*.kuunyi.com`, `*.vercel.app`, `localhost`) are rejected at parse time.
5. **A malformed env var cannot take the platform down.** Parsing never throws; bad entries are dropped individually and counted in a redacted warning.
6. **Machine callbacks never depend on tenant-controlled DNS.**
7. **The blocklist is hygiene, not the boundary.** Tenant-scoped authorization is the real control; bearer-token routes exist, so "everything 401s" was never true.

---

## File Structure

- **Modify** `src/lib/tenant.ts` — sole canonical host→tenant resolver, custom-domain aware, allowlist-only. Pure, env-driven, no Next.js imports.
- **Create** `src/__tests__/lib/tenant.test.ts`
- **Modify** `src/lib/origin.ts` — add `platformOrigin()` beside the existing `tenantOrigin()`.
- **Modify** `src/__tests__/lib/origin.test.ts` — extend, don't replace.
- **Modify** `src/middleware.ts` — delete the duplicate resolver; import the canonical one; add the surface split; extend `config.matcher`.
- **Create** `src/__tests__/middleware.test.ts`
- **Modify** `src/app/api/public/payments/abank/route.ts`, `src/app/api/public/payments/mmpay/route.ts` — pin callbacks.
- **Create** `src/__tests__/payments/callback-urls.test.ts`
- **Create** `scripts/verify-custom-domains.ts` — read-only preflight.
- **Modify** `.env.local.example`

**Not in this PR:** `src/app/api/public/payments/hitpay/route.ts`. Tasks 1-8 are independent of HitPay; the custom-origin extension is Follow-up **F1**, which cannot be written until the base allowlist PR exists. If `hitpay/route.ts` appears in this branch's diff, something has gone wrong.

---

## Task 1: Lock the resolver to configured hosts only

**Files:**
- Modify: `src/lib/tenant.ts`
- Test: `src/__tests__/lib/tenant.test.ts`

- [ ] **Step 1: Pre-check — confirm nothing depends on the generic fallback**

Before removing it, list the domains assigned to the Vercel project. Any host that is **not** `kuunyi.com`, `*.kuunyi.com`, or `*.vercel.app` currently resolves via the generic branch and will return `null` after this task.

Expected: no such domain exists (custom domains are what this plan introduces). **If one does, stop** — it must be added to `TENANT_CUSTOM_DOMAINS` in the same change or it breaks.

- [ ] **Step 2: Write the failing tests**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { extractSubdomainFromHost } from "@/lib/tenant";

const original = process.env.TENANT_CUSTOM_DOMAINS;

// Delete-aware: `process.env.X = undefined` stores the STRING "undefined", so
// the "no custom domains configured" test would leave a malformed map behind
// and later tests would parse it instead of an absent one.
afterEach(() => {
  if (original === undefined) delete process.env.TENANT_CUSTOM_DOMAINS;
  else process.env.TENANT_CUSTOM_DOMAINS = original;
});

function withMap(json: string) {
  process.env.TENANT_CUSTOM_DOMAINS = json;
}

describe("extractSubdomainFromHost — known hosts (regression)", () => {
  it("still resolves kuunyi subdomains, vercel previews and localhost", () => {
    withMap('{"flashtic.com":"flashtic"}');
    expect(extractSubdomainFromHost("tmf.kuunyi.com")).toBe("tmf");
    expect(extractSubdomainFromHost("tmf.staging.kuunyi.com")).toBe("tmf");
    expect(extractSubdomainFromHost("www.kuunyi.com")).toBeNull();
    expect(extractSubdomainFromHost("kuunyi.com")).toBeNull();
    expect(extractSubdomainFromHost("tmf.edu-enroll-xi.vercel.app")).toBe("tmf");
    expect(extractSubdomainFromHost("edu-enroll-xi.vercel.app")).toBeNull();
    expect(extractSubdomainFromHost("tmf.localhost:3005")).toBe("tmf");
  });
});

// The allowlist property: inference is gone. Tenant isolation must not depend
// on Vercel's domain assignment being the only thing standing in the way.
describe("extractSubdomainFromHost — unconfigured hosts never resolve", () => {
  it("refuses to infer a tenant from an arbitrary domain", () => {
    withMap('{"flashtic.com":"flashtic"}');
    expect(extractSubdomainFromHost("flashtic.evil.com")).toBeNull();
    expect(extractSubdomainFromHost("www.evil.com")).toBeNull();
    expect(extractSubdomainFromHost("unknown.example.org")).toBeNull();
    expect(extractSubdomainFromHost("tmf.kuunyi.com.evil.com")).toBeNull();
  });

  // Previously resolved to tenant "192" — LAN testing per project notes.
  it("does not treat a bare IP as a tenant", () => {
    expect(extractSubdomainFromHost("192.168.50.3:3005")).toBeNull();
  });
});

describe("extractSubdomainFromHost — custom domains", () => {
  it("resolves a configured custom domain to its tenant slug", () => {
    withMap('{"flashtic.com":"flashtic"}');
    expect(extractSubdomainFromHost("flashtic.com")).toBe("flashtic");
  });

  it("treats www, ports, case and the FQDN trailing dot as the same domain", () => {
    withMap('{"flashtic.com":"flashtic"}');
    expect(extractSubdomainFromHost("www.flashtic.com")).toBe("flashtic");
    expect(extractSubdomainFromHost("FlashTic.com:3005")).toBe("flashtic");
    expect(extractSubdomainFromHost("flashtic.com.")).toBe("flashtic");
  });

  it("returns null when no custom domains are configured", () => {
    delete process.env.TENANT_CUSTOM_DOMAINS;
    expect(extractSubdomainFromHost("flashtic.com")).toBeNull();
  });
});

describe("extractSubdomainFromHost — env hardening", () => {
  // Runs on every request to every domain: a typo must never 500 the platform.
  it("never throws on a malformed env var", () => {
    withMap("{not json");
    expect(() => extractSubdomainFromHost("flashtic.com")).not.toThrow();
    expect(extractSubdomainFromHost("flashtic.com")).toBeNull();
    expect(extractSubdomainFromHost("tmf.kuunyi.com")).toBe("tmf"); // unaffected
  });

  it("ignores a well-formed value of the wrong shape", () => {
    withMap('["flashtic.com"]');
    expect(extractSubdomainFromHost("flashtic.com")).toBeNull();
  });

  it("drops entries with non-string or invalid slugs", () => {
    withMap('{"a.com":123,"b.com":"BAD SLUG","c.com":"ok"}');
    expect(extractSubdomainFromHost("a.com")).toBeNull();
    expect(extractSubdomainFromHost("b.com")).toBeNull();
    expect(extractSubdomainFromHost("c.com")).toBe("ok");
  });

  it("rejects a slug with a trailing hyphen", () => {
    withMap('{"a.com":"school-","b.com":"-school","c.com":"ok-slug"}');
    expect(extractSubdomainFromHost("a.com")).toBeNull();
    expect(extractSubdomainFromHost("b.com")).toBeNull();
    expect(extractSubdomainFromHost("c.com")).toBe("ok-slug");
  });

  it("drops malformed hostnames", () => {
    withMap('{"not a host":"x","-bad.com":"y","ok.com":"z"}');
    expect(extractSubdomainFromHost("ok.com")).toBe("z");
  });

  // An env typo must not let a custom domain claim the platform's own hosts.
  it("rejects reserved platform hosts", () => {
    withMap('{"kuunyi.com":"evil","tmf.kuunyi.com":"evil","x.vercel.app":"evil"}');
    expect(extractSubdomainFromHost("kuunyi.com")).toBeNull();
    expect(extractSubdomainFromHost("tmf.kuunyi.com")).toBe("tmf"); // real resolver wins
  });

  it("keeps the first host when two map to the same tenant", () => {
    withMap('{"one.com":"flashtic","two.com":"flashtic"}');
    expect(extractSubdomainFromHost("one.com")).toBe("flashtic");
    expect(extractSubdomainFromHost("two.com")).toBeNull();
  });

  it("does not resolve prototype keys", () => {
    withMap('{"flashtic.com":"flashtic"}');
    expect(extractSubdomainFromHost("constructor")).toBeNull();
    expect(extractSubdomainFromHost("__proto__")).toBeNull();
    expect(extractSubdomainFromHost("toString")).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/lib/tenant.test.ts`
Expected: the "known hosts" block PASSES; custom-domain, allowlist and hardening tests FAIL.

- [ ] **Step 4: Write the implementation**

Replace the contents of `src/lib/tenant.ts`:

```ts
// ─── Host → tenant resolution ───────────────────────────────────────────────
// The single canonical resolver. Server components use it as a fallback when
// middleware's x-tenant-slug header doesn't propagate on Vercel, and middleware
// imports it too. Do not add a second copy — a divergent duplicate is how a
// custom domain ends up resolving on some requests and not others.
//
// This is an allowlist. A host resolves to a tenant only if it is a kuunyi
// subdomain, a Vercel preview, localhost, or explicitly configured below.
// Never infer a tenant from an arbitrary hostname: Vercel's domain assignment
// should not be the only thing preventing "flashtic.evil.com" from resolving.

// ─── Tenant custom domains ──────────────────────────────────────────────────
// Maps a client-owned domain ("flashtic.com") to the tenant slug that owns it
// ("flashtic"), configured via TENANT_CUSTOM_DOMAINS as JSON host → slug:
//   {"flashtic.com":"flashtic"}
// The tenant keeps its canonical kuunyi subdomain; the custom domain is an
// additional student-facing alias.

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_HOSTS = new Set(["kuunyi.com", "localhost", "vercel.app"]);

// Host header → bare comparable hostname: strip port, lowercase, drop the FQDN
// trailing dot, fold www.
function normalizeHost(host: string): string {
  return host
    .split(":")[0]
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

export interface DomainMapIssue {
  /** 1-based position in the JSON object. */
  entry: number;
  /** Normalized host, when one could be derived — lets the preflight name the
   *  offending entry without reparsing. Runtime never logs it. */
  host?: string;
  reason: string;
}

export interface ParsedTenantDomains {
  map: Map<string, string>;
  issues: DomainMapIssue[];
}

/**
 * The only implementation of parsing, normalization, validation, reserved-host
 * and uniqueness checks. Exported so the preflight script validates with the
 * exact same code the runtime uses — two parsers would eventually disagree, and
 * a preflight that passes while runtime rejects is worse than none.
 *
 * Pure: takes the raw string, touches no process.env, never throws.
 *
 * A Map (not a plain object) is deliberate: object lookup resolves prototype
 * keys, so a Host of "constructor" would return a truthy value.
 */
export function parseTenantCustomDomains(raw: string): ParsedTenantDomains {
  const map = new Map<string, string>();
  const issues: DomainMapIssue[] = [];

  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    // No custom domains rather than no platform.
    return { map, issues: [{ entry: 0, reason: "not valid JSON" }] };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return raw.trim()
      ? { map, issues: [{ entry: 0, reason: "not a JSON object of host → slug" }] }
      : { map, issues };
  }

  const claimed = new Set<string>();
  let n = 0;

  for (const [rawHost, rawSlug] of Object.entries(parsed as Record<string, unknown>)) {
    n++;
    const host = normalizeHost(rawHost);
    const fail = (reason: string) => issues.push({ entry: n, host, reason });

    if (typeof rawSlug !== "string") {
      fail("slug is not a string");
      continue;
    }
    const slug = rawSlug.trim().toLowerCase();

    if (!HOST_RE.test(host)) fail("malformed hostname");
    else if (!SLUG_RE.test(slug)) fail("malformed tenant slug");
    else if (
      RESERVED_HOSTS.has(host) ||
      host.endsWith(".kuunyi.com") ||
      host.endsWith(".vercel.app")
    )
      fail("reserved platform host");
    else if (map.has(host)) fail("duplicate host");
    // One domain per tenant: a reverse lookup would otherwise be ambiguous.
    else if (claimed.has(slug)) fail("tenant already has a custom domain");
    else {
      claimed.add(slug);
      map.set(host, slug);
      continue;
    }
  }

  return { map, issues };
}

let cachedRaw: string | undefined;
let cachedMap = new Map<string, string>();

// Memoised on the raw string: production parses once, tests can mutate
// process.env freely. Must never throw — this runs on every request to every
// domain, so a parse error over one tenant's typo would 500 the platform.
function domainMap(): Map<string, string> {
  const raw = process.env.TENANT_CUSTOM_DOMAINS ?? "";
  if (raw === cachedRaw) return cachedMap;
  cachedRaw = raw;

  const { map, issues } = parseTenantCustomDomains(raw);

  // Counts only. Hosts and slugs come from an env var and must not be written
  // to shared logs; scripts/verify-custom-domains.ts prints the detail locally,
  // where an operator asked for it explicitly.
  if (issues.length > 0) {
    console.warn(
      `[tenant-domains] Ignored ${issues.length} invalid TENANT_CUSTOM_DOMAINS entr${issues.length === 1 ? "y" : "ies"}; ${map.size} active. Run scripts/verify-custom-domains.ts.`,
    );
  }

  cachedMap = map;
  return cachedMap;
}

/** Tenant slug that owns this host, or null if it is not a configured custom domain. */
export function tenantForCustomHost(host: string): string | null {
  return domainMap().get(normalizeHost(host)) ?? null;
}

export function extractSubdomainFromHost(host: string): string | null {
  // Custom domains resolve first. Must precede everything below: a 2-part host
  // like "flashtic.com" would otherwise fall through to the null return.
  const custom = tenantForCustomHost(host);
  if (custom) return custom;

  const hostname = host.split(":")[0];
  const parts = hostname.split(".");

  // "nihon-moment.localhost" → "nihon-moment"
  if (parts.length === 2 && parts[1] === "localhost") return parts[0];

  // "tmf.kuunyi.com" → "tmf"
  // "tmf.staging.kuunyi.com" → "tmf"
  if (hostname.endsWith(".kuunyi.com")) {
    const sub = parts[0];
    return sub && sub !== "www" && sub !== "staging" ? sub : null;
  }

  // "nihon-moment.edu-enroll-xi.vercel.app" → "nihon-moment"
  if (hostname.endsWith(".vercel.app")) return parts.length >= 4 ? parts[0] : null;

  // Every other host must be explicitly configured above. Do not infer.
  return null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/lib/tenant.test.ts`
Expected: PASS

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: PASS. **If an existing test relied on generic-host inference, do not weaken this resolver** — that test is asserting the bug. Bring it to review.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tenant.ts src/__tests__/lib/tenant.test.ts
git commit -m "feat: resolve tenant custom domains; stop inferring tenants from unknown hosts"
```

---

## Task 2: Delete middleware's duplicate resolver

**Why:** `middleware.ts:18-49` and `tenant.ts:5` are byte-identical copies today. Leaving both means the custom-domain lookup and the allowlist exist in one and not the other — the exact drift that makes resolution host-dependent.

**Files:**
- Modify: `src/middleware.ts` (delete lines 13-49; add import; update the call site at line 68)

- [ ] **Step 1: Confirm they are identical before deleting**

Run: `sed -n '18,49p' src/middleware.ts` and compare against `src/lib/tenant.ts` as it was before Task 1 (`git show HEAD~1:src/lib/tenant.ts`).
Expected: same branches, same order. **If they differ, stop** and reconcile explicitly.

- [ ] **Step 2: Delete and import**

Remove the `extractSubdomain` function and its comment block. Add:

```ts
import { extractSubdomainFromHost, tenantForCustomHost, isDevHost } from "@/lib/tenant";
```

Update the call site (was line 68):

```ts
tenantSlug = extractSubdomainFromHost(host);
```

- [ ] **Step 3: Verify no references remain**

Run: `grep -rn "extractSubdomain\b" src/`
Expected: no matches (only `extractSubdomainFromHost`).

- [ ] **Step 4: Full suite + build**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/middleware.ts
git commit -m "refactor: use the canonical host resolver in middleware"
```

---

## Task 3: Restrict the dev fallback to dev hosts — RELEASE BLOCKER

**Why this is the most important task in the plan.** Task 1 stops the *resolver* inferring tenants. It does not stop the *middleware* handing one out anyway. The fallback at `middleware.ts:72` is guarded by `!isRootDomain`, and `isRootDomain` is a four-host literal list — so for any unknown host it is `false` and the chain runs:

```
https://flashtic.evil.com/enroll?tenant=flashtic
  → extractSubdomainFromHost() returns null   (Task 1 working correctly)
  → isRootDomain false                        (unknown host)
  → fallback: searchParams "tenant" → "flashtic"
  → tenant context granted
```

Its comment calls it a localhost fallback. It is not — it applies to every non-root hostname. Without this task, Task 1 is cosmetic and the "allowlist" claim in this plan is false.

**Gate on `VERCEL_ENV`, not `NODE_ENV`.** The review recommended `NODE_ENV !== "production"`. Vercel preview deployments run with `NODE_ENV=production`, and `.github/workflows/staging-tests.yml` targets `https://edu-enroll-xi-git-staging-xxx.vercel.app` — a 3-part host that resolves to `null` (the `.vercel.app` branch needs ≥4 parts) and therefore *depends* on this fallback. `NODE_ENV` gating would break staging CI.

**The actual policy, stated precisely.** Per Vercel's system environment variable docs (verified 2026-07-17): **`VERCEL_ENV` is exactly `production` | `preview` | `development`** — it never carries a custom environment name. The variable that does is **`VERCEL_TARGET_ENV`** ("production, preview, development, or the name of a custom environment"). `VERCEL_ENV` is unset locally. The guard is `VERCEL_ENV !== "production"`, so the policy is:

- **Production is denied**, always.
- **Preview, development, and unset (local)** are allowed **only on a recognized dev host** (`localhost`, `*.localhost`, a bare IPv4, `*.vercel.app`).

Custom Vercel environments still report a non-production `VERCEL_ENV`, so they fall under the second rule and remain constrained by `isDevHost`. Only reach for `VERCEL_TARGET_ENV` if per-custom-environment policy is ever needed — it is not today.

The host check is the primary control; the environment check is defence in depth.

**Files:**
- Modify: `src/middleware.ts` (the fallback block at lines 70-78)
- Test: `src/__tests__/middleware.test.ts`

- [ ] **Step 1: Write the failing security tests**

**Task 3 owns the whole scaffold.** Task 4 appends cases to this file and adds nothing else — no second import block, no second mock, no second `afterEach`. Create `src/__tests__/middleware.test.ts` complete:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

// Middleware calls Supabase auth.getUser(); stub it so these stay offline and
// deterministic. Without this, tests fail inside createServerClient() before
// reaching any tenant assertion.
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));

// process.env.X = undefined stores the STRING "undefined", not an absent var —
// which leaks between tests and causes order-dependent failures in the full
// suite. Every mutated variable must be restored delete-aware.
const ENV_KEYS = [
  "VERCEL_ENV",
  "TENANT_CUSTOM_DOMAINS",
  "NEXT_PUBLIC_DEV_TENANT",
  "NEXT_PUBLIC_APP_URL",
] as const;

const ORIGINAL = Object.fromEntries(
  ENV_KEYS.map((k) => [k, process.env[k]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnv(key: (typeof ENV_KEYS)[number]) {
  const original = ORIGINAL[key];
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

afterEach(() => {
  for (const k of ENV_KEYS) restoreEnv(k);
});

// ─── Host-aware request factory — REQUIRED, do not inline NextRequest ────────
// Verified against this runtime:
//   new NextRequest(new Request("https://flashtic.com/enroll"))
//     .headers.get("host")  →  null
//   ...while .nextUrl.hostname → "flashtic.com"
//
// Middleware reads `request.headers.get("host") ?? ""` — NOT nextUrl. So a test
// built from the URL alone hands middleware an EMPTY host, and every hostname
// assertion then passes or fails for a reason unrelated to its name. Host
// resolution is this feature's primary security boundary; a suite that doesn't
// set the header doesn't test it.
//
// Host is a forbidden header in browsers but settable under Node/undici —
// verified: Headers.set("host", ...) reads back correctly here.
//
// The URL's host always wins over any caller-supplied host header, so a
// spoofing test can never accidentally evaluate a different host than its title.
function middlewareRequest(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(url).host);
  return new NextRequest(new Request(url, { ...init, headers }));
}

// An unknown production host cannot acquire tenant context through the
// development fallback: query parameter, cookie, or NEXT_PUBLIC_DEV_TENANT.
//
// Scope, deliberately: a caller-supplied x-tenant-slug header IS still honoured
// where no tenant resolves. That is acknowledged debt (Follow-up F2) — it
// collides with requireAuth()'s agent contract, which requires that header.
// Do not read this group as "unknown hosts cannot get a tenant, full stop".
describe("middleware — unknown hosts cannot use the dev fallback", () => {
  function prodGet(url: string, init?: RequestInit) {
    process.env.VERCEL_ENV = "production";
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    process.env.NEXT_PUBLIC_DEV_TENANT = "nihon-moment";
    return middleware(middlewareRequest(url, init));
  }

  const slug = (res: Response) => res.headers.get("x-middleware-request-x-tenant-slug");

  it("ignores ?tenant= on an unknown host", async () => {
    expect(slug(await prodGet("https://flashtic.evil.com/enroll?tenant=flashtic"))).toBeNull();
  });

  it("ignores an x-tenant-slug cookie on an unknown host", async () => {
    const res = await prodGet("https://flashtic.evil.com/enroll", {
      headers: { cookie: "x-tenant-slug=flashtic" },
    });
    expect(slug(res)).toBeNull();
  });

  it("ignores NEXT_PUBLIC_DEV_TENANT on an unknown host in production", async () => {
    expect(slug(await prodGet("https://flashtic.evil.com/enroll"))).toBeNull();
  });

  it("ignores ?tenant= on a bare IP in production", async () => {
    expect(slug(await prodGet("https://192.168.50.3/enroll?tenant=flashtic"))).toBeNull();
  });

  // A configured custom domain overwrites any inbound header — which is why the
  // header trust boundary (Follow-up F2) is not this plan's problem. Where a
  // tenant DOES resolve, the resolver wins; where it doesn't, F2 applies.
  it("overwrites a forged tenant header on a configured custom domain", async () => {
    const res = await prodGet("https://flashtic.com/enroll", {
      headers: { "x-tenant-slug": "victim-tenant" },
    });
    expect(slug(res)).toBe("flashtic");
  });

  it("overwrites a forged tenant header on a tenant's own kuunyi subdomain", async () => {
    const res = await prodGet("https://nihon-moment.kuunyi.com/enroll", {
      headers: { "x-tenant-slug": "victim-tenant" },
    });
    expect(slug(res)).toBe("nihon-moment");
  });
});

// The conveniences must still work where they are meant to.
describe("middleware — dev fallback still works off production", () => {
  function devGet(url: string) {
    delete process.env.VERCEL_ENV; // local
    process.env.NEXT_PUBLIC_DEV_TENANT = "nihon-moment";
    return middleware(middlewareRequest(url));
  }

  const slug = (res: Response) => res.headers.get("x-middleware-request-x-tenant-slug");

  it("honours ?tenant= on localhost", async () => {
    expect(slug(await devGet("http://localhost:3005/enroll?tenant=acme"))).toBe("acme");
  });

  it("honours NEXT_PUBLIC_DEV_TENANT on localhost", async () => {
    expect(slug(await devGet("http://localhost:3005/enroll"))).toBe("nihon-moment");
  });

  it("honours the LAN dev host", async () => {
    expect(slug(await devGet("http://192.168.50.3:3005/enroll"))).toBe("nihon-moment");
  });

  it("resolves tenant.localhost via the resolver, not the fallback", async () => {
    expect(slug(await devGet("http://acme.localhost:3005/enroll"))).toBe("acme");
  });

  // Preview deployments are 3-part vercel.app hosts and depend on the fallback;
  // staging CI targets one. NODE_ENV would be "production" here.
  it("honours NEXT_PUBLIC_DEV_TENANT on a preview deployment", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.NEXT_PUBLIC_DEV_TENANT = "nihon-moment";
    const res = await middleware(
      middlewareRequest("https://edu-enroll-xi-git-staging-abc.vercel.app/enroll"),
    );
    expect(slug(res)).toBe("nihon-moment");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/middleware.test.ts`
Expected: every "unknown hosts" test FAILS (tenant context granted); the "dev fallback" tests PASS (current behaviour).

- [ ] **Step 3: Restrict the fallback**

Replace the block at `middleware.ts:70-78`:

```ts
// Dev conveniences — ?tenant=, the cookie, NEXT_PUBLIC_DEV_TENANT — must never
// establish tenant context on a host we do not control. The old guard was
// `!isRootDomain`, a four-host literal list, so every UNKNOWN host qualified:
// https://flashtic.evil.com/enroll?tenant=flashtic got tenant context even
// after the resolver correctly returned null. Gate on the host instead.
//
// VERCEL_ENV, not NODE_ENV: Vercel preview deployments run NODE_ENV=production,
// and staging CI targets a 3-part *.vercel.app preview host that resolves to
// null and relies on this fallback. VERCEL_ENV is production|preview|development
// and is unset locally.
// isDevHost() is imported from @/lib/tenant — it is the SAME rule the HitPay
// redirect allowlist needs (P2 adds it there). Do not inline a second copy:
// two divergent host classifiers is exactly what Task 2 deletes. If P2 has not
// merged yet, add isDevHost() to src/lib/tenant.ts here and P2 will import it.
if (!tenantSlug && process.env.VERCEL_ENV !== "production" && isDevHost(hostname)) {
  tenantSlug =
    request.nextUrl.searchParams.get("tenant") ??
    request.cookies.get("x-tenant-slug")?.value ??
    process.env.NEXT_PUBLIC_DEV_TENANT ??
    null;
}
```

`isRootDomain` remains in use by the `/admin` guard below it; leave that alone.

**Do not add `requestHeaders.delete("x-tenant-slug")` here.** v3.2 specified it; v3.3 removed it. `requireAuth()` (`api.ts:60-66`) *requires* that inbound header for signed agent requests and grants `role: "owner"` on the named tenant — deleting it 400s every agent payment-verification call. The header trust boundary and the agent contract are **Follow-up F2**, not this plan. See the Revision history for the reasoning.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/middleware.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Prove the agent path still works**

Removing header sanitization from this plan was justified by "the agent contract keeps working". That claim must be **executable**, not prose — otherwise `npm test` passes while proving nothing. No existing test exercises signed agent auth through middleware.

Add to `src/__tests__/middleware.test.ts`:

```ts
// TEMPORARY — pinned to Follow-up F2.
// requireAuth() (api.ts:60-66) requires an inbound x-tenant-slug for signed
// agent requests and grants role:"owner" on the named tenant. This plan
// deliberately does not sanitize that header, so this test pins the contract it
// leaves intact. When F2 lands host-derived tenant identity, this expectation
// FLIPS to null and this test should be deleted — a failure here after F2 is
// expected, not a regression.
it("preserves the root-host agent tenant header pending F2", async () => {
  process.env.VERCEL_ENV = "production";
  const res = await middleware(
    middlewareRequest("https://kuunyi.com/api/admin/payments/payment-id/verify", {
      headers: {
        "x-agent-signature": "test-signature",
        "x-chat-id": "123",
        "x-tenant-slug": "flashtic",
      },
    }),
  );
  expect(res.headers.get("x-middleware-request-x-tenant-slug")).toBe("flashtic");
});
```

This asserts only what middleware does — the header survives to `requireAuth()`. It does **not** exercise HMAC verification (that needs `AGENT_SECRET` and a real signature); middleware is the only thing this task changes, and the header reaching `requireAuth()` unaltered is the whole compatibility claim.

**If this test fails, stop** — the fallback guard has caught a path it shouldn't.

- [ ] **Step 6: Full suite + build**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/middleware.ts src/__tests__/middleware.test.ts
git commit -m "fix: restrict tenant fallback to development hosts"
```

---

## Task 4: Keep staff and platform surfaces off the custom domain

**Files:**
- Modify: `src/middleware.ts` (new branch before the `shouldSkipTenant` block at line 67; `config.matcher`)
- Test: `src/__tests__/middleware.test.ts`

**Two ordering constraints:**
1. `/superadmin`, `/register` and `/onboarding` are in `SKIP_TENANT_PREFIXES`, so tenant detection never runs for them. The branch must sit **before** `if (!shouldSkipTenant(pathname))`.
2. `/` and `/register` are **not in `config.matcher`** — middleware does not run there at all today. Without the matcher change these redirects silently no-op.

**Redirect targets differ by surface.** `/register` and `/superadmin` are root-platform surfaces and go to `kuunyi.com`. `/admin`, `/login`, `/onboarding` are tenant surfaces and go to the tenant subdomain.

- [ ] **Step 1: Write the failing tests**

**Append to the file Task 3 created. Add nothing else** — no imports, no `vi.mock`, no `afterEach`, no request factory. Task 3 owns all of it.

In particular do **not** reintroduce `afterEach(() => { process.env.X = original })`. Assigning back a value that was absent stores the **string** `"undefined"` — the order-dependent leak Task 3's delete-aware `restoreEnv()` exists to prevent. And do **not** build requests with `new NextRequest(new Request(url))`: that yields a **null** `host` header, and middleware reads `headers.get("host")`, so the test would assert nothing about the hostname in its own title.

```ts
// Uses Task 3's middlewareRequest() factory and ENV_KEYS restoration.
function get(url: string) {
  process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
  return middleware(middlewareRequest(url));
}

describe("middleware — custom domain tenant resolution", () => {
  it("resolves a custom domain, and www of it, to its tenant", async () => {
    for (const host of ["flashtic.com", "www.flashtic.com"]) {
      const res = await get(`https://${host}/enroll/spring`);
      expect(res.headers.get("x-middleware-request-x-tenant-slug")).toBe("flashtic");
    }
  });

  // The security property this design leans on.
  it("ignores ?tenant= on a custom domain", async () => {
    const res = await get("https://flashtic.com/enroll/spring?tenant=rival");
    expect(res.headers.get("x-middleware-request-x-tenant-slug")).toBe("flashtic");
  });

  it("leaves kuunyi subdomain routing unchanged", async () => {
    const res = await get("https://nihon-moment.kuunyi.com/enroll/spring");
    expect(res.headers.get("x-middleware-request-x-tenant-slug")).toBe("nihon-moment");
  });
});

describe("middleware — custom domain surface split", () => {
  it("sends the custom domain root to the tenant's enroll index", async () => {
    const res = await get("https://flashtic.com/");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://flashtic.com/enroll");
  });

  it("redirects tenant staff pages to the tenant subdomain", async () => {
    for (const path of ["/admin/dashboard", "/login", "/onboarding"]) {
      const res = await get(`https://flashtic.com${path}`);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(`https://flashtic.kuunyi.com${path}`);
    }
  });

  // Root-platform surfaces belong to the platform, not to a tenant.
  it("redirects platform pages to the platform root", async () => {
    for (const path of ["/register", "/superadmin"]) {
      const res = await get(`https://flashtic.com${path}`);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(`https://kuunyi.com${path}`);
    }
  });

  it("preserves the query string when redirecting", async () => {
    const res = await get("https://flashtic.com/login?next=%2Fadmin");
    expect(res.headers.get("location")).toBe("https://flashtic.kuunyi.com/login?next=%2Fadmin");
  });

  // APIs 404 rather than redirect: a cross-origin redirect fails opaquely under
  // CORS for a fetch(), and an API client expects a status, not a host hop.
  it("404s platform APIs instead of redirecting them", async () => {
    for (const path of ["/api/admin/students", "/api/saas/tenants", "/api/superadmin/stats"]) {
      const res = await get(`https://flashtic.com${path}`);
      expect(res.status).toBe(404);
    }
  });

  it("still serves student pages, public APIs and webhooks on the custom domain", async () => {
    for (const path of ["/enroll/spring", "/status", "/api/public/form-fields", "/api/webhooks/hitpay"]) {
      const res = await get(`https://flashtic.com${path}`);
      expect(res.status).not.toBe(404);
      expect(res.status).not.toBe(307);
    }
  });

  it("blocks nothing on the tenant's own kuunyi subdomain", async () => {
    const res = await get("https://flashtic.kuunyi.com/admin/dashboard");
    expect(res.headers.get("location")).not.toContain("flashtic.com/admin");
  });

  it("leaves the kuunyi root landing page alone", async () => {
    const res = await get("https://kuunyi.com/");
    expect(res.status).not.toBe(307);
  });
});
```

> **Implementer note:** middleware sets request headers via `NextResponse.next({ request: { headers } })`, which Next surfaces on the response as `x-middleware-request-<name>`. If that prefix differs in this Next version, inspect the actual headers in the Step 2 failing run and adjust. **Do not** weaken the assertion to `expect(res).toBeDefined()` — the `?tenant=` test is the security assertion of this plan.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/middleware.test.ts`
Expected: resolution tests PASS (Task 1); surface-split tests FAIL.

- [ ] **Step 3: Add the surface split**

Insert into `middleware()` immediately after `hostname` is computed (~line 60), **before** the `if (!shouldSkipTenant(pathname))` block:

```ts
// ── Custom domain surface split ──────────────────────────────────────────
// A tenant's own domain is student-facing only. Staff surfaces stay on the
// kuunyi subdomain so sessions live on exactly one origin; platform surfaces
// stay on the platform root so a client's domain never serves signup or
// superadmin. Runs before shouldSkipTenant(): /superadmin, /register and
// /onboarding skip tenant detection and would otherwise slip through.
const customTenant = tenantForCustomHost(host);
if (customTenant) {
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "kuunyi.com";
  const search = request.nextUrl.search;

  // app/page.tsx renders the KuuNyi SaaS landing for every host — not something
  // to serve on a client's homepage. Send the root to their enrollment index.
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/enroll", request.url));
  }

  // Root-platform surfaces: the platform's, not this tenant's.
  if (/^\/(register|superadmin)(\/|$)/.test(pathname)) {
    return NextResponse.redirect(`https://${appDomain}${pathname}${search}`);
  }

  // Tenant staff surfaces.
  if (/^\/(admin|login|onboarding)(\/|$)/.test(pathname)) {
    return NextResponse.redirect(`https://${customTenant}.${appDomain}${pathname}${search}`);
  }

  // Not a security control: tenant-scoped authorization is. This only avoids
  // answering platform calls on a client's domain.
  if (/^\/api\/(admin|saas|superadmin)(\/|$)/.test(pathname)) {
    return new NextResponse("Not Found", { status: 404 });
  }
}

// "/" is in the matcher only for the redirect above. The landing page needs no
// session, so skip the Supabase round-trip the rest of this middleware performs.
if (pathname === "/") return NextResponse.next();
```

- [ ] **Step 4: Extend the matcher**

```ts
export const config = {
  matcher: [
    "/",
    "/login",
    "/register",
    "/admin/:path*",
    "/superadmin",
    "/superadmin/:path*",
    "/onboarding",
    "/api/:path*",
    "/enroll/:path*",
    "/status",
  ],
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/middleware.test.ts`
Expected: PASS

- [ ] **Step 6: Full suite, lint, build**

Run: `npm test && npm run lint && npm run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/middleware.ts src/__tests__/middleware.test.ts
git commit -m "feat: keep staff and platform surfaces off tenant custom domains"
```

---

## Task 5: Pin payment callbacks to a stable platform origin

**Why:** `abank/route.ts:119` and `mmpay/route.ts:135` build `callbackUrl` from the inbound `Host`. On a custom domain that aims payment settlement at a domain **the client controls and could remove**, and would require adding every custom domain to each provider's callback allowlist.

**Why `platformOrigin()` and not `tenantOrigin()`:** neither route has `tenantInfo` (using it would need another query), and `tenantOrigin()` is planned to become custom-domain-aware, which would silently move callbacks back onto client domains. `platformOrigin()` takes no tenant and cannot drift. Webhook handlers find payments by provider identifiers, so a callback needs no tenant context.

**No behaviour change for existing tenants:** `platformOrigin()` returns `https://kuunyi.com`, which is where `nihon-moment.kuunyi.com`'s callbacks already land at the deployment level.

**Not in scope:** HitPay/PayPay/Stripe return URLs — customer-facing, correctly branded already.

**Files:**
- Modify: `src/lib/origin.ts`, `src/__tests__/lib/origin.test.ts`
- Modify: `src/app/api/public/payments/abank/route.ts:117-119`, `src/app/api/public/payments/mmpay/route.ts:129-135`
- Create: `src/__tests__/payments/callback-urls.test.ts`

- [ ] **Step 1: Repair the existing cleanup in `origin.test.ts` first**

The file's current `afterEach` is unsafe, and this task makes it actively break:

```ts
const original = process.env.NEXT_PUBLIC_APP_URL;
afterEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = original;   // stores "undefined" if absent
});
```

The `platformOrigin()` fallback test below does `delete process.env.NEXT_PUBLIC_APP_URL`. If the var was absent to begin with, this `afterEach` writes back the **string** `"undefined"` — and `platformOrigin()` passes it to `new URL()`, which **throws**. Fix it before adding tests:

```ts
const original = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = original;
});
```

- [ ] **Step 2: Write the failing test for `platformOrigin()`**

Add to `src/__tests__/lib/origin.test.ts`:

```ts
import { tenantOrigin, platformOrigin } from "@/lib/origin";

describe("platformOrigin", () => {
  it("returns the configured app origin, never a tenant or custom domain", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
    expect(platformOrigin()).toBe("https://kuunyi.com");
  });

  it("strips any path from the configured value", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com/some/path";
    expect(platformOrigin()).toBe("https://kuunyi.com");
  });

  it("falls back to the production origin when unset", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(platformOrigin()).toBe("https://kuunyi.com");
  });

  it("follows the environment on staging and local", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://staging.kuunyi.com";
    expect(platformOrigin()).toBe("https://staging.kuunyi.com");
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3005";
    expect(platformOrigin()).toBe("http://localhost:3005");
  });

  // The reason this exists rather than reusing tenantOrigin(): tenantOrigin is
  // slated to become custom-domain-aware, which would move machine callbacks
  // onto tenant-controlled DNS. platformOrigin takes no tenant, so it can't.
  it("takes no tenant argument", () => {
    expect(platformOrigin.length).toBe(0);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/__tests__/lib/origin.test.ts`
Expected: FAIL — `platformOrigin` is not exported.

- [ ] **Step 4: Add `platformOrigin()` to `src/lib/origin.ts`**

```ts
// ─── Stable platform origin ──────────────────────────────────────────────────
// For machine-to-machine URLs (payment callbacks) that must never point at a
// tenant-controlled domain. Deliberately takes no tenant argument: unlike
// tenantOrigin(), which may become custom-domain-aware, this cannot be made to
// return a host a client can remove or repoint. Removing a custom domain must
// never strand an in-flight payment.

export function platformOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL ?? "https://kuunyi.com";
  return new URL(configured).origin;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/__tests__/lib/origin.test.ts`
Expected: PASS

- [ ] **Step 6: Write the failing callback-URL tests**

Create `src/__tests__/payments/callback-urls.test.ts`. This must exercise **both** ABank and MMQR — the Step 8 change touches both, and a test that only covers ABank lets MMQR keep deriving its callback from the inbound host undetected.

**Three offline dependencies — get all three or the test proves nothing.** Verified against the routes: both call `resolveTenantId()` as their *first* line (`abank/route.ts:12`, `mmpay/route.ts:14`), before reading the body or the admin client.

1. **Mock `@/lib/api`** — without it the handler calls `resolveTenantId()`, which calls `next/headers()` outside a request context and throws **before** reaching the provider spy. Its red/green would then prove nothing about callbacks. This is the established pattern (`src/__tests__/payments/hitpay-create.test.ts` and others):

```ts
vi.mock("@/lib/api", () => ({
  resolveTenantId: vi.fn().mockResolvedValue("tenant-1"),
}));
```

2. **`postTo()` must send a valid JSON POST** — an empty body makes `await request.json()` throw and the handler 400s before the provider call:

```ts
function postTo(url: string) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", host: new URL(url).host },
    body: JSON.stringify({ enrollmentRef: "ENR-TEST-001" }),
  });
}
```

3. **The `createAdminClient` stub must return a *payable* enrollment** — a pending enrollment with enough class/cart data to compute a fee, then a successful payment insert. Otherwise the handler returns 404/409/500 before the provider is ever called, and the spy sees nothing.

This file also mutates env vars, so it needs delete-aware cleanup — the same trap as Step 1. **Include `MMPAY_MODE`, and set it explicitly in the MMQR test rather than assuming it is unset** — an inherited `MMPAY_MODE=production` would call `mmpay.pay` and `/api/payments/webhook`, an environment-dependent failure unrelated to this change. The route selects production only when the value is exactly `"production"` (`mmpay/route.ts:133`):

```ts
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
const originalDomainMap = process.env.TENANT_CUSTOM_DOMAINS;
const originalMmpayMode = process.env.MMPAY_MODE;

afterEach(() => {
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;

  if (originalDomainMap === undefined) delete process.env.TENANT_CUSTOM_DOMAINS;
  else process.env.TENANT_CUSTOM_DOMAINS = originalDomainMap;

  if (originalMmpayMode === undefined) delete process.env.MMPAY_MODE;
  else process.env.MMPAY_MODE = originalMmpayMode;
});
```

**ABank** — spy on `abank.createOrder`:

```ts
// A payment started on a tenant's custom domain must still tell the provider to
// call back to the platform. Otherwise removing the domain strands settlement.
it("ABank: uses the platform origin even on a custom domain", async () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
  process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
  await POST_abank(postTo("https://flashtic.com/api/public/payments/abank"));
  expect(createOrderSpy).toHaveBeenCalledWith(
    expect.objectContaining({ callbackUrl: "https://kuunyi.com/api/webhooks/abank" }),
  );
});

it("ABank: ignores a spoofed Host header", async () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
  await POST_abank(postTo("https://evil.com/api/public/payments/abank"));
  expect(createOrderSpy).toHaveBeenCalledWith(
    expect.objectContaining({ callbackUrl: "https://kuunyi.com/api/webhooks/abank" }),
  );
});
```

**MMQR** — spy on `mmpay.sandboxPay` (the default when `MMPAY_MODE` is unset; verified at `mmpay/route.ts:133-135`, callback path `/api/sandbox/payments/webhook`):

```ts
it("MMQR: uses the platform origin even on a custom domain", async () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
  process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
  delete process.env.MMPAY_MODE; // force the sandbox branch; don't inherit prod
  await POST_mmpay(postTo("https://flashtic.com/api/public/payments/mmpay"));
  expect(sandboxPaySpy).toHaveBeenCalledWith(
    expect.objectContaining({
      callbackUrl: "https://kuunyi.com/api/sandbox/payments/webhook",
    }),
  );
});
```

The **red** phase must show both spies receiving the custom/spoofed host today; the **green** phase (after Step 8) must show both receiving `platformOrigin()`.

> **Implementer note:** v2 claimed these routes were untestable and settled for grep. That was a cop-out for a payment path. If a handler's import graph makes this genuinely impractical after honestly attempting the three dependencies above, **say so in the PR** — do not silently drop the tests or fall back to grep alone.

- [ ] **Step 7: Run to verify they fail**

Run: `npx vitest run src/__tests__/payments/callback-urls.test.ts`
Expected: FAIL — callbacks still derive from `host`.

- [ ] **Step 8: Replace host-derived callbacks**

In `abank/route.ts`, replace the `host`/`proto`/`callbackUrl` block:

```ts
// Callbacks must not follow the inbound Host. On a tenant custom domain that
// would aim settlement at a domain the client controls and could remove,
// stranding in-flight payments — and would need every custom domain added to
// the provider's callback allowlist.
const callbackUrl = `${platformOrigin()}/api/webhooks/abank`;
```

Apply the same in `mmpay/route.ts`, preserving its existing `callbackPath`:

```ts
const callbackUrl = `${platformOrigin()}${callbackPath}`;
```

Add `import { platformOrigin } from "@/lib/origin";` to both.

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/payments/callback-urls.test.ts`
Expected: PASS

- [ ] **Step 10: Verify no host-derived callbacks remain**

Run: `grep -rn 'callbackUrl' src/app/api/public/payments/`
Expected: no `${host}` interpolation in any `callbackUrl`.

Run: `grep -rn 'const host' src/app/api/public/payments/`
Expected: only `hitpay`, `paypay`, `stripe` — customer return URLs, correct as-is.

- [ ] **Step 11: Full suite + build, then commit**

```bash
npm test && npm run build
git add src/lib/origin.ts src/__tests__/lib/origin.test.ts \
        src/app/api/public/payments/abank/route.ts \
        src/app/api/public/payments/mmpay/route.ts \
        src/__tests__/payments/callback-urls.test.ts
git commit -m "fix: pin payment callbacks to a stable platform origin"
```

---

## NOT A TASK — Follow-up F1: HitPay custom origin (blocked, unwritten)

> **This is deliberately outside the numbered sequence. Do not execute it.** It targets code that does not exist. The HitPay prerequisite PR is unwritten, so the allowlist's shape, the name and availability of `subdomain` in that handler, and the patch site below are all *assumptions*. An unimplementable task inside a numbered list invites an executor to attempt it anyway — hence the separation.
>
> **Required sequence:** implement and review the base HitPay redirect allowlist → merge to `dev` → rebase this branch → read the merged handler → rewrite this section against what is actually there → add custom-origin acceptance and cross-tenant rejection tests → only then implement.

**Deployment is blocked on the prerequisite. There is no shortcut in this plan.** v3.1 offered "disable HitPay card payments for the initial rollout" as an alternative; that is withdrawn, because saying it is not doing it. A real card-disable would need a named config flag, defined UI behaviour when cards are unavailable, a **server-side** rejection so bypassing the UI cannot create a card payment, and a test. That is its own task, and nobody has written it. Absent that, HitPay's allowlist PR is a hard prerequisite.

**What the prerequisite is assumed to provide** (verify each before implementing): `platformOrigin()` and `tenantOrigin(subdomain)` in the allowlist; a locally available `subdomain`; parsed-origin comparison rather than prefix matching.

This section's only job is to extend that allowlist with the tenant's custom origin, so a student paying on `flashtic.com` returns to `flashtic.com`.

**Files:**
- Modify: `src/lib/tenant.ts` (add reverse lookup), `src/app/api/public/payments/hitpay/route.ts`

- [ ] **Step 1: Write failing tests for the reverse lookup**

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

  it("returns null when the map is empty or invalid", () => {
    withMap("{not json");
    expect(customOriginForTenant("flashtic")).toBeNull();
  });
});
```

- [ ] **Step 2: Implement the reverse lookup in `src/lib/tenant.ts`**

```ts
/** The tenant's configured custom origin, or null. One domain per tenant is
 *  enforced at parse time, so this is unambiguous. */
export function customOriginForTenant(slug: string): string | null {
  for (const [host, mapped] of domainMap()) {
    if (mapped === slug) return `https://${host}`;
  }
  return null;
}
```

- [ ] **Step 3: Extend the allowlist**

**Read the merged handler first — the snippet below is a sketch, not a patch.** Add the tenant's custom origin to the allowed set. Origins must be compared **parsed**, never with `startsWith` — `https://kuunyi.com.evil.com` starts with `https://kuunyi.com`.

```ts
const allowedOrigins = new Set(
  [platformOrigin(), tenantOrigin(subdomain), customOriginForTenant(subdomain)].filter(
    (o): o is string => Boolean(o),
  ),
);

let redirectUrl = fallbackRedirectUrl;
if (clientRedirectUrl) {
  let parsed: URL | null = null;
  try {
    parsed = new URL(clientRedirectUrl); // throws on a malformed value
  } catch {
    parsed = null;
  }
  if (!parsed || !allowedOrigins.has(parsed.origin)) {
    return NextResponse.json({ error: "Invalid redirect origin" }, { status: 400 });
  }
  redirectUrl = clientRedirectUrl;
}
```

- [ ] **Step 4: Verify against the merged handler, then commit**

Run: `npm test && npm run build`

Confirm by test: a tampered `redirectUrl` returns 400, and a configured custom origin is accepted **only** for its mapped tenant.

```bash
git add src/lib/tenant.ts src/__tests__/lib/tenant.test.ts src/app/api/public/payments/hitpay/route.ts
git commit -m "feat: allow tenant custom origins in the HitPay redirect allowlist"
```

---

## NOT A TASK — Follow-up F2: tenant header trust boundary + agent contract

> **Not this plan's work. Do not execute.**
>
> **Tracked at https://github.com/YeHtutAung/EduEnroll/issues/164** — "Security: tenant header trust boundary + agent auth contract", assigned to @YeHtutAung.
>
> That issue is the durable owner; this section is the reasoning behind it. The merge gate is satisfied: issue #164 exists and is assigned. (It supersedes the session chip `task_47d00374`, which was never durable tracking.)

**The issue.** `middleware.ts:54` copies inbound headers, and `x-tenant-slug` is only overwritten when a tenant resolves. Where none does — the platform root, or an unknown host — the client's own value survives to `resolveTenantId()` (`api.ts:60`) and the server layouts.

**Why it is not in this plan.** Custom domains overwrite the header (a tenant always resolves there), so this plan neither creates nor widens the behaviour.

**No additional capability beyond the tenant's public subdomain was identified.** A forged header still selects tenant context for service-role-backed public routes — enrollment creation, status lookup, bank-account listing, uploads, payment creation. Those are intentionally public and already reachable on that tenant's own subdomain, and headers can only be set on one's own request, so no privilege escalation was found. That is a narrower claim than "grants nothing", and the difference matters: this is a real trust-boundary effect, which is why F2 exists rather than being closed as a non-issue. Fixing it requires the coordinated agent-contract migration below.

**The collision.** `requireAuth()` (`api.ts:60-66`) *requires* an inbound `x-tenant-slug` for signed agent requests, then grants `role: "owner"` on the named tenant (line 99). Deleting the header 400s every agent call, including payment verification via `src/app/api/admin/payments/[id]/verify/route.ts`.

**A second, related weakness.** The agent HMAC covers `chatId + "." + rawBody` (`api.ts:33`) — **not** the tenant slug. Tenant selection sits outside the authenticated message; only the `allowed_chat_ids` revocation check (line 88) constrains which tenant a signed request can name. That check is a mitigation, not a binding.

**Contract options — pick one, then sanitize:**

| Option | Shape | Cost |
|---|---|---|
| **Host-derived** (preferred) | Bot calls `https://<tenant>.kuunyi.com/api/admin/...`; middleware resolves from the trusted host; `requireAuth()` consumes the middleware-set header. Client-supplied slug disappears. | Bot deployment. Custom domains stay out of the privileged API contract. |
| **Signed slug** | Versioned canonical payload — method, path, chatId, tenant slug, timestamp, nonce, body — with timing-safe verification and replay protection. | Coordinated bot/server migration. |

Only once one is chosen can the header be sanitized at the **top** of middleware (before `shouldSkipTenant`, so `/api/messenger/*`, `/api/saas/*`, `/api/events`, `/api/scans` and `/superadmin` are covered — v3.2's placement missed all of them).

**Tests it needs:** signed request succeeds on the correct tenant host; the same request replayed against another tenant host is rejected; a forged header on `kuunyi.com` and on a skipped prefix establishes no tenant.

---

## Task 6: Read-only preflight for the domain map

**Why:** tenant existence is deliberately **not** checked in the resolver — that would be a DB query on a path that runs in middleware and every server layout, and project notes record middleware DB queries as unreliable here. A valid-but-wrong slug would silently route real enrollments and payments to another real tenant, so it needs catching before deploy instead.

**Scope limit — read this before writing the script.** `CLAUDE.md`: *"NEVER access production DB (Mumbai) directly / PROD DB ref: `nhxmumcvgnxlczjsgctz` — OFF LIMITS."* This script is agent-operated and **must only ever be pointed at EduEnroll-dev (`fnfvwzwrdsnmwxunciti`)**. It must not accept a connection string or project ref as an argument, so it cannot be aimed at production by mistake.

**That restriction must be enforced in code, not by convention.** `.env.local` pointing at dev is an assumption, not a guarantee — a stray `supabase link` or a copied env file is all it takes. Assert the target **before** constructing the client:

```ts
// This script must never touch production (nhxmumcvgnxlczjsgctz) or Rexiee
// (kbiszegobsbelzbyyfvo). Verify the target rather than trusting .env.local.
const DEV_PROJECT_REF = "fnfvwzwrdsnmwxunciti";
const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!configuredUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required.");

if (new URL(configuredUrl).hostname !== `${DEV_PROJECT_REF}.supabase.co`) {
  throw new Error(
    "Refusing to run: the custom-domain preflight is restricted to EduEnroll-dev.",
  );
}
// Only now construct the admin client.
```

The script must never print `SUPABASE_SERVICE_ROLE_KEY` or any env contents beyond the host→slug mapping it is reporting on.

**Be honest about what this buys.** Restricted to dev, the script validates two of three things: that the env value parses under the real parser, and that the slugs exist *in dev*. It **cannot** confirm the slug maps to the right school in production — dev and prod hold different tenants. That last check is a **human step via superadmin** (see Deployment). The script narrows the window; it does not close it.

**Files:**
- Create: `scripts/verify-custom-domains.ts`

- [ ] **Step 1: Write the script**

Read-only. Follow `scripts/create-scanner-key.ts` for client setup and import style. It must:

1. Parse `TENANT_CUSTOM_DOMAINS` via the exported `parseTenantCustomDomains()` from Task 1 — **never a second parser**, or preflight and runtime can disagree, and a preflight that passes while runtime rejects is worse than none.
2. Print every entry in `issues` with its reason. This is an explicit operator command on a local machine, so printing hosts and slugs is fine here — unlike the runtime warning, which stays counts-only.
3. For each host in `map`, `SELECT id, name FROM tenants WHERE subdomain = <slug>` against **dev**.
4. Print `host → slug → tenant name`.
5. Exit non-zero if any slug has no tenant in dev, or if `issues` is non-empty.
6. Print a closing reminder that dev tenants are not prod tenants, and that the production mapping still needs the superadmin check in the Deployment section.

Imports use **relative `.ts` paths**, not the `@/` alias — plain Node does not resolve TypeScript path aliases:

```ts
import { parseTenantCustomDomains } from "../src/lib/tenant.ts";
import { createAdminClient } from "../src/lib/supabase/admin.ts";
```

- [ ] **Step 2: Run against dev**

`tsx` is **not** installed (verified: absent from `package.json`, no binary in `node_modules/.bin`). Use the repository's established runner, as in `scripts/seed-e2e.ts`:

```bash
node --env-file=.env.local --experimental-strip-types scripts/verify-custom-domains.ts
```

`.env.local` points at dev. Expected: each configured host prints its resolved tenant name; exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-custom-domains.ts
git commit -m "feat: add read-only preflight for the custom domain map"
```

---

## Task 7: Document the env var

**Files:** `.env.local.example`

- [ ] **Step 1: Add the documented var** (below `NEXT_PUBLIC_APP_URL`, line 10)

```bash
# Optional. Maps client-owned domains to tenant slugs, as JSON host → slug.
# The domain serves that tenant's student-facing pages only; staff stay on the
# tenant's kuunyi subdomain. Each host must also be added to the Vercel project.
# One domain per tenant. kuunyi.com/*.kuunyi.com/*.vercel.app are rejected.
# Invalid entries are dropped (a count is warned, never the values) rather than
# breaking the deployment — run scripts/verify-custom-domains.ts before deploying.
# Example: TENANT_CUSTOM_DOMAINS={"flashtic.com":"flashtic"}
TENANT_CUSTOM_DOMAINS=
```

- [ ] **Step 2: Commit**

```bash
git add .env.local.example
git commit -m "docs: document TENANT_CUSTOM_DOMAINS"
```

---

## Task 8: Open the PR

- [ ] **Step 1: Recheck git state** — it drifts; verify rather than trusting this document.

```bash
git fetch origin dev && git rev-list --left-right --count origin/dev...dev
```

Per `CLAUDE.md`: branch off `dev`, PR for human review, never self-merge.

- [ ] **Step 2: Review the diff**

Run: `git diff origin/dev...HEAD`
Expected: `src/lib/tenant.ts`, `src/lib/origin.ts`, `src/middleware.ts`, the abank and mmpay payment routes, four test files, `scripts/verify-custom-domains.ts`, `.env.local.example`. No secrets.

**`hitpay/route.ts` must NOT appear** — it belongs to prerequisites P2/P3, not this PR. Its presence means F1 was attempted against code that doesn't exist.

The PR description must state that **merging this does not unblock deployment**: P1, P2 and P3 are still required before DNS.

- [ ] **Step 3: Open the PR**

Body should state: one canonical resolver (middleware duplicate deleted); the resolver is now an allowlist and no longer infers tenants from unknown hosts; `?tenant=` closed on custom domains; callbacks pinned to `platformOrigin()`; existing tenants unaffected when the map is unset; no schema or secret changes.

**This repo is public.** Describe behaviour, not exploit recipes.

---

## Deployment (manual — owner performs after merge)

**Prerequisites — all three must be merged AND deployed before any step below:**

- **P1 — ABank callback verification** (PR #163)
- **P2 — Base HitPay redirect allowlist** (not yet written)
- **P3 — F1: HitPay tenant custom-origin extension** (blocked on P2)

**"The HitPay PR" is ambiguous and means two changes — do not treat P2 as sufficient.** Configuring DNS after P2 but before P3 leaves HitPay *correctly* rejecting `flashtic.com` returns, breaking card payments on the very domain this work exists to enable.

Order matters. **Ship the code before DNS resolves.**

- [ ] **1. Preflight against dev.** Run the script with the intended `TENANT_CUSTOM_DOMAINS` value:
  ```bash
  node --env-file=.env.local --experimental-strip-types scripts/verify-custom-domains.ts
  ```
  This validates that the value parses under the real parser and that no entry is silently dropped. **It does not validate production** — dev and prod hold different tenants. Never point this script at prod: `CLAUDE.md` marks `nhxmumcvgnxlczjsgctz` OFF LIMITS.
- [ ] **2. Confirm the production mapping by hand — this is the step that catches a wrong slug.** In the **superadmin UI on production**, look up the tenant whose subdomain is `flashtic` and read its **school name**. Confirm it is the client who owns `flashtic.com`. A slug that exists but belongs to a different school is the failure mode here, and only a human comparing the name to the domain can see it. No approved automated production check exists; if one is wanted later, it belongs in CI or an internal admin workflow, not direct DB access.
- [ ] **3. Vercel — add domains.** Settings → Domains → add `flashtic.com` and `www.flashtic.com`. "Invalid Configuration" until DNS is set is expected.
- [ ] **4. Vercel — add env var.** Production: `TENANT_CUSTOM_DOMAINS={"flashtic.com":"flashtic"}`. **Redeploy** — env changes do not apply to existing deployments. Use `printf`, not `echo`, via CLI.
- [ ] **5. Namecheap — DNS.** Domain List → Manage → Advanced DNS.
  - **Delete the default records first**: `CNAME www → parkingpage.namecheap.com` and the URL Redirect on `@`. Leaving these is the most common failure mode.
  - **ALIAS Record**, host `@` (Namecheap supports ALIAS; no apex A record needed).
  - **CNAME Record**, host `www`.
  - Use the exact targets from Vercel's domain screen — region-specific and changed over time; the dashboard is authoritative. TTL: Automatic.
- [ ] **6. Wait for TLS.** Automatic once DNS resolves. Minutes typically; allow a few hours.

### Verification

- [ ] `https://flashtic.com/enroll` serves **flashtic's** enrollment index with flashtic's branding — not "KuuNyi", which is what a wrong slug looks like
- [ ] `https://www.flashtic.com/enroll` serves the same
- [ ] `https://flashtic.com/` → 307 → `https://flashtic.com/enroll`
- [ ] `https://flashtic.com/enroll?tenant=nihon-moment` still shows **flashtic** — the core security assertion
- [ ] `https://kuunyi.com/enroll?tenant=flashtic` does **not** grant tenant context (Task 3). If you have a spare host pointed at the deployment, confirm the same for an unknown domain; otherwise the middleware tests cover it and Vercel refuses unassigned hosts anyway
- [ ] `https://flashtic.com/admin` → 307 → `https://flashtic.kuunyi.com/admin`
- [ ] `https://flashtic.com/register` → 307 → `https://kuunyi.com/register`
- [ ] `https://flashtic.com/api/admin/students` → 404
- [ ] `https://flashtic.kuunyi.com/admin` works; staff can log in
- [ ] `https://nihon-moment.kuunyi.com` and `https://kuunyi.com` unaffected
- [ ] Reload `/enroll` on `flashtic.com` several times — branding must never flip to "KuuNyi". That flip is the header-propagation failure this plan exists to prevent.
- [ ] **ABank** payment on `flashtic.com` completes; confirm the callback arrived at **kuunyi.com**
- [ ] **MMQR** payment on `flashtic.com` completes; same check
- [ ] **PayPay/Stripe** (whichever this tenant uses): customer returns to `flashtic.com`; payment reaches `confirmed`
- [ ] **HitPay — only after P2 and P3 are deployed.** Card payment on `flashtic.com` returns to `flashtic.com` and reaches `confirmed`; a tampered `redirectUrl` → 400, never a redirect; another tenant's custom origin → 400. **With P2 deployed but not P3, HitPay card returns to `flashtic.com` will be rejected** — that is P2 working correctly, and it is why P3 is a prerequisite rather than a nicety

---

## Out of Scope / Deferred

| Item | Why deferred |
|---|---|
| `tenantOrigin()` returning the custom domain | Student emails/SMS/Telegram still link to `flashtic.kuunyi.com/status`. Functional, unbranded. Touches 6 call sites and live outbound messaging. Follow-up PR. Task 5's `platformOrigin()` exists precisely so that PR **cannot** move callbacks by accident. |
| Tenant-aware `app/page.tsx` | The better answer for `/` than a redirect: a real branded homepage. A new page design, larger than this plan. |
| 301 from `flashtic.kuunyi.com/enroll/*` → `flashtic.com/enroll/*` | Same pages on two origins (duplicate content). Tidiness. Pairs with the `tenantOrigin()` work. |
| Auditing existing `verified` ABank payments | Whether any were confirmed without a settled transaction is a data question for PR #163, not this plan. |
| Moving the map from env to `tenants.custom_domain` | A DB lookup on the resolution path runs per request in middleware **and** every server layout, needs the service-role key in the edge runtime, and needs caching. Project notes record middleware DB queries as unreliable here. The env map costs one redeploy per domain — acceptable at current scale. Task 6's preflight plus the manual superadmin check narrow the correctness gap. |
| Multiple custom domains per tenant | Parse-time uniqueness makes the reverse lookup unambiguous. Revisit with a canonical flag if a tenant needs aliases. |

---

## Rollback

**`platformOrigin()` (Task 4) is what makes rollback safe.** Callbacks land on `kuunyi.com` regardless of what happens to the client's DNS, so in-flight payments settle either way.

1. Clear `TENANT_CUSTOM_DOMAINS` in Vercel, redeploy. Every path reverts; `flashtic.com` stops resolving to a tenant. No migration, no data change, no secret rotation.
2. **Leave DNS and the Vercel domain in place for a drain period.** Customer *return* URLs still point at `flashtic.com` for in-flight payments. Those settle via the pinned callback, but a student mid-checkout would land on a dead page. Pull DNS once nothing references it.

If rollback is needed because the domain resolved to the **wrong tenant**, treat it as an incident: clearing the env var is the immediate fix, but check whether enrollments or payments were written against the wrong tenant first.
