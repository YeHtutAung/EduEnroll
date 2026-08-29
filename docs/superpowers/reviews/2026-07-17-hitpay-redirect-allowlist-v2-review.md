# HitPay Redirect Allowlist Plan V2 Review

**Plan reviewed:** `docs/superpowers/plans/2026-07-17-hitpay-redirect-allowlist.md`  
**Plan version:** V2  
**Review date:** 2026-07-17  
**Result:** Revise before implementation

## Executive Summary

V2 resolves all three findings from the first review:

- The generic card caller now sends `redirectUrl`.
- The missing-value fallback is rebuilt from `tenantOrigin(subdomain)` and the canonical database enrollment reference.
- The non-production exception is constrained by a shared recognized-development-host classifier.

The document also contains exactly **26 unchecked items** across five tasks.

However, a second-pass sequence and wiring review found three implementation blockers. The proposed route code contradicts its PayNow test, its request-origin construction breaks two development environments the helper claims to support, and the feature branch is not created until after four tasks have already committed.

## Findings

| Severity | Location | Finding | Required revision |
|---|---|---|---|
| **High** | Task 5 Step 1, around line 575 | The plan creates or checks the feature branch only after Tasks 1–4 have already made four commits. In the current checkout, that would place P2 commits on `fix/abank-callback-verification`, not on a feature branch created from `dev`. This also violates the repository rule requiring feature branches to originate from `dev`. | Move branch preparation before Task 1 performs any edit. Check `git status`, fetch `origin/dev`, create a new feature branch from the verified `dev` commit, and only then begin Task 1. Keep Task 5 for final recheck and PR creation. |
| **Medium** | Task 4 Step 3, around lines 528–535 | The proposed `if (clientRedirectUrl !== undefined)` validation runs for both card and PayNow. Therefore the planned `postPayNow("https://evil.com/phish")` test at line 460 returns `400`, contradicting the stated requirement that PayNow ignore the field. | Gate redirect construction and validation on `hitpayMethod === "card"`. For PayNow, leave the effective HitPay `redirectUrl` as `undefined` regardless of the body field. |
| **Medium** | Task 4 Step 3, around lines 517–519 | `host.startsWith("localhost") ? "http" : "https"` does not support the environments Task 3 claims to allow. `tenant.localhost:3005` and `192.168.50.3:3005` are treated as HTTPS, while their browser origin is normally HTTP, so their supplied redirect fails exact-origin comparison. Pure helper tests do not exercise this route wiring. | Use the normalized external request origin, such as `request.nextUrl.origin`, rather than guessing the protocol from the Host string. Add route tests for `tenant.localhost` and the LAN development origin. |
| **Medium** | Task 4 Step 6, lines 561–562 | The plan says the full suite must pass, but the current `dev` baseline has the known unrelated scanner event fixture failure. The sequence will stop at `npm test` and never run lint or build when chained. | Record the known baseline explicitly and require no new failures, or land the scanner fix first. Run test, lint, and build as separate steps so all results are collected. |
| **Low** | Task 5 Step 2, lines 583–584 | The expected final diff lists only four files, but the plan intentionally changes at least six: the generic payment page, `tenant.ts`, the HitPay route, the helper, and two new test files. `hitpay-create.test.ts` may also change for the joined tenant fixture. | List the complete expected file set, including any modified fixture. Treat unexpected files as a stop condition. |
| **Low** | Commit steps throughout | Repository instructions require `git status` before committing and `git diff` before each commit. The plan only performs a final diff after all four commits. | Add scoped `git status` and `git diff -- <task files>` checks before every commit. |

## Verification of Previous Findings

| Previous finding | V2 status | Evidence |
|---|---|---|
| Generic card caller omitted `redirectUrl` | **Resolved in plan** | Task 1 adds a return URL based on `window.location.origin`. |
| Host-derived fallback remained active | **Resolved in plan** | Task 4 builds the fallback from `tenantOrigin(subdomain)` and `enrollment.enrollment_ref`. |
| Non-production request origin could allow itself | **Resolved in helper** | Task 3 requires both non-production and `isDevHost()`, with direct self-allow and lookalike-host tests. |
| Raw client enrollment reference used in fallback | **Resolved in plan** | Task 4 uses the database value `enrollment.enrollment_ref`. |

## Required Code-Plan Correction for PayNow

The card-only boundary should be structurally explicit:

```ts
let redirectUrl: string | undefined;

if (hitpayMethod === "card") {
  redirectUrl = fallbackRedirectUrl;

  if (clientRedirectUrl !== undefined) {
    if (
      typeof clientRedirectUrl !== "string" ||
      !isAllowedRedirect(clientRedirectUrl, subdomain, requestOrigin)
    ) {
      return NextResponse.json(
        { error: "Bad Request", message: "Invalid redirect origin." },
        { status: 400 },
      );
    }

    redirectUrl = clientRedirectUrl;
  }
}
```

Then pass `redirectUrl` directly to `createPaymentRequest`. This guarantees that PayNow cannot accidentally begin validating or forwarding the body field.

## Request-Origin Correction

The helper recognizes these non-production hosts:

- `localhost`
- `*.localhost`
- bare IPv4 addresses
- `*.vercel.app`

The route must preserve the real request scheme for each of them. The proposed manual rule handles only bare `localhost` correctly.

Prefer:

```ts
const requestOrigin = request.nextUrl.origin;
```

The recognized-host check remains mandatory. `request.nextUrl.origin` fixes protocol/port correctness; it does not replace the allowlist.

Add route-level cases demonstrating that these client redirects are accepted off production:

```text
http://tenant.localhost:3005
http://192.168.50.3:3005
https://<deployment>.vercel.app
```

## Correct Task Order

1. Inspect working-tree status and preserve unrelated files.
2. Fetch `origin/dev`.
3. Create the P2 feature branch from the verified `dev` base.
4. Implement Tasks 1–4 sequentially.
5. Before every commit, run scoped status and diff checks.
6. Run focused tests, the full suite comparison, lint, and build separately.
7. Review the complete diff and open the PR without merging it.

## Correct Expected Diff

At minimum:

```text
src/app/(public)/enroll/payment/[ref]/page.tsx
src/app/api/public/payments/hitpay/route.ts
src/lib/tenant.ts
src/lib/payments/redirect-allowlist.ts
src/__tests__/payments/redirect-allowlist.test.ts
src/__tests__/payments/hitpay-redirect.test.ts
```

Potentially also:

```text
src/__tests__/payments/hitpay-create.test.ts
```

if its enrollment fixture must be updated for `tenants(subdomain)`.

## Decisions Still Approved

- Reject an invalid supplied card redirect with `400`; do not silently fall back.
- Allow only the tenant canonical origin in production.
- Do not include `platformOrigin()`.
- Reject credential-bearing and malformed URLs.
- Compare normalized origins exactly.
- Keep PayNow unaffected.
- Use the existing enrollment query to obtain the tenant subdomain.
- Keep the fallback independent of the inbound Host.
- Fix staging configuration rather than widening the production allowlist.
- Use pure security-decision tests plus route-level wiring tests.

## Final Recommendation

Do not implement V2 exactly as written. Correct the branch order, card-only validation gate, and request-origin construction first. After those revisions, the plan is implementation-ready; the original security findings are otherwise resolved.
