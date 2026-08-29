# HitPay Redirect Allowlist Plan V4 Review

**Plan reviewed:** `docs/superpowers/plans/2026-07-17-hitpay-redirect-allowlist.md`  
**Plan version:** V4  
**Review date:** 2026-07-17  
**Result:** Security design approved; one mechanical correction before execution

## Executive Summary

V4 has converged. The plan contains **six tasks and 29 unchecked items**, and all prior branch, PayNow, request-origin, baseline, conditional-fixture, expected-diff, and PowerShell execution findings are resolved.

No executable command relies on `&&`; the remaining textual occurrences only document why chaining is prohibited. Branch creation occurs before any edit, the known test baseline is recorded directly, verification commands run independently, the conditional fixture has an explicit commit path, and the final expected diff is complete.

One pre-commit command still omits a newly staged test file. This is a one-line mechanical correction, not another architecture revision.

## Finding

| Severity | Location | Finding | Required correction |
|---|---|---|---|
| **Medium** | Task 4 Step 6, lines 509–510 | Task 4 stages three files, including the new `src/__tests__/payments/redirect-allowlist.test.ts`, but `git diff --cached` lists only `tenant.ts` and `redirect-allowlist.ts`. The new security test is therefore still committed without its staged contents being reviewed. | Add `src/__tests__/payments/redirect-allowlist.test.ts` to the Task 4 cached-diff command. |

Use:

```powershell
git diff --cached -- src/lib/tenant.ts src/lib/payments/redirect-allowlist.ts src/__tests__/payments/redirect-allowlist.test.ts
```

## Non-blocking Fail-closed Guard

The proposed route uses:

```ts
const subdomain = enrollment.tenants?.subdomain ?? "";
```

The database column is non-null, but the plan already acknowledges that the runtime Supabase join shape must be confirmed. If the relation is unexpectedly absent or shaped differently, the empty string makes `tenantOrigin("")` return the platform root—the exact origin the plan intentionally excludes because no enrollment page exists there.

Prefer failing before creating the HitPay request:

```ts
const subdomain = enrollment.tenants?.subdomain;
if (!subdomain) {
  return NextResponse.json(
    { error: "Internal Server Error", message: "Tenant origin could not be resolved." },
    { status: 500 },
  );
}
```

Add a route test asserting that a missing joined subdomain creates no HitPay request. This is defensive correctness rather than a confirmed exploit, so it does not reopen the approved allowlist design.

## Prior Findings Verification

| Finding | V4 status |
|---|---|
| Feature branch created after implementation commits | **Resolved** — Task 1 branches from verified `dev` before editing. |
| PayNow accidentally validated | **Resolved** — redirect handling is structurally inside the card branch. |
| Manual protocol inference broke local and LAN origins | **Resolved** — route uses `request.nextUrl.origin` with route-level environment tests. |
| Known failing test prevented lint/build | **Resolved** — baseline is recorded and all final commands run independently. |
| Expected final diff omitted intended files | **Resolved** — six mandatory files and the conditional fixture are listed. |
| Conditional `hitpay-create.test.ts` fixture had no commit path | **Resolved** — Task 3 conditionally stages and reviews it. |
| Pre-commit checks did not display untracked test files | **Resolved in Task 5; one Task 4 path omission remains**. |
| Baseline pipeline depended on `tail` | **Resolved** — Task 1 runs `npm test` directly. |
| Red-phase expectation covered only one untrusted path | **Resolved** — supplied redirects and fallback behavior are both named. |
| Final unrelated working-tree state was incomplete | **Resolved** — Task 6 repeats the full known state. |

## Security Design Approval

The following design is approved unchanged:

- Exact normalized-origin comparison.
- Production allows only the tenant canonical origin.
- `platformOrigin()` is excluded.
- Non-production request origins require both a non-production environment and a recognized development hostname.
- Credentials and malformed URLs are rejected.
- Invalid supplied card redirects return `400` without creating a HitPay request.
- PayNow ignores and never forwards the redirect field.
- The missing-value fallback is derived from trusted tenant configuration and the canonical database enrollment reference.
- The inbound Host never determines the fallback.
- P3 custom-domain expansion remains separate.
- Staging misconfiguration must be fixed in configuration rather than by widening the allowlist.

## Final Recommendation

Add the missing Task 4 test path to `git diff --cached`. After that one-line correction, the plan has a **go** for implementation and does not need another architecture review. The missing-subdomain fail-closed guard should be included during implementation as a defensive improvement.
