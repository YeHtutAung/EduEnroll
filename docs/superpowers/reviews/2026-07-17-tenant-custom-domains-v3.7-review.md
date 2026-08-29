# Tenant Custom Domains V3.7 Review

## Overall Verdict

**Approved for implementation.**

V3.7 closes the remaining Task 5 test-harness gaps from V3.6. The eight-task plan is now coherent, sequential, codebase-aligned, and security-conscious. No implementation-blocking finding remains.

One low-risk test determinism improvement is recommended: explicitly control and restore `MMPAY_MODE` in the callback test instead of assuming it is absent. It is absent in the current shell, but tests should not depend on inherited developer or CI environment state.

Verified plan state:

- Eight numbered tasks.
- 70 unchecked items and zero checked items.
- No tracked implementation files under `src/`, `scripts/`, `package.json`, or `.env.local.example` were changed by V3.7.
- The plan and review directory remain untracked and should be staged deliberately.

## Findings

| Severity | Finding | Impact | Recommendation |
|---|---|---|---|
| **Low** | The MMQR callback test exercises the sandbox branch by assuming `MMPAY_MODE` is unset, but it does not delete or restore that variable. | An inherited `MMPAY_MODE=production` value would call `mmpay.pay` instead of `sandboxPay` and use `/api/payments/webhook`, causing an environment-dependent failure unrelated to the feature. | Add `MMPAY_MODE` to the test's saved environment values, set or delete it explicitly before the sandbox assertion, and restore it delete-aware. |

No High or Medium findings remain.

## V3.6 Findings Recheck

| V3.6 finding | V3.7 result | Status |
|---|---|---|
| `resolveTenantId()` was not mocked | Task 5 now explicitly mocks `@/lib/api` before route execution, matching existing repository test patterns. | **Resolved** |
| Only ABank had a concrete provider assertion | MMQR now has an explicit `sandboxPay` assertion with the expected platform callback path. | **Resolved** |
| `postTo()` and fixtures were underspecified | The plan defines a valid JSON POST helper and requires a payable enrollment plus successful payment insert. | **Resolved** |

## Optional Determinism Edit

Extend the callback test cleanup:

```typescript
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

Force the intended branch in the MMQR test:

```typescript
delete process.env.MMPAY_MODE;
```

Alternatively set it to a non-production value such as `"sandbox"`; the route selects production only when the value is exactly `"production"`.

This recommendation does not block implementation.

## Sequential Execution Assessment

| Task | Assessment |
|---|---|
| Task 1 — resolver | Complete precheck, failing tests, implementation, passing tests, full suite, scoped commit. |
| Task 2 — duplicate removal | Confirms equivalence before deletion, imports the canonical resolver, scans references, verifies build/tests. |
| Task 3 — fallback restriction | Complete offline host-aware scaffold, red/green tests, temporary agent-contract assertion, full verification. |
| Task 4 — surface split | Reuses Task 3's scaffold, tests redirects and matcher coverage, runs full verification. |
| Task 5 — callbacks | Repairs cleanup first, tests `platformOrigin`, exercises both payment handlers offline, replaces callbacks, verifies both tests and source scan. |
| Task 6 — preflight | Enforces exact EduEnroll-dev hostname before client construction, runs read-only validation, commits separately. |
| Task 7 — environment documentation | Documents mapping syntax, behavior, and deployment requirements in a scoped commit. |
| Task 8 — PR | Rechecks branch state, reviews the expected diff, excludes HitPay, and opens a human-reviewed PR without merging. |

## Security Assessment

### Tenant resolution

- Configured custom domains are explicit allowlisted mappings.
- Unknown domains cannot infer a tenant from their first DNS label.
- Production unknown hosts cannot use query, cookie, or environment development fallback.
- Configured custom domains and KuuNyi tenant subdomains overwrite a forged tenant header with host-derived context.
- The root-host tenant-header/agent contract debt is accurately separated into F2 and must receive a durable issue owner before merge.

### Surface separation

- Student-facing enrollment and approved public routes remain available on the custom domain.
- Admin, login, onboarding, superadmin, registration, and privileged API surfaces remain on platform-controlled KuuNyi hosts.
- Middleware matcher changes cover paths that previously bypassed middleware.

### Payment security

- ABank and MMQR machine callbacks are pinned to `platformOrigin()`.
- Both callback changes now have executable provider-spy coverage.
- PayPay and Stripe customer return URLs remain tenant-branded.
- HitPay remains outside this PR because its base allowlist does not yet exist.
- P2 closes the HitPay open redirect; P3 separately permits the mapped tenant custom origin.
- P1, P2, and P3 must all be merged and deployed before DNS or production environment configuration.

This matches the correct payment boundary: machine callbacks and webhooks use platform-controlled origins; customer return destinations may be branded only when server-validated and tenant-bound.

### Database and operational safety

- No schema migration is proposed.
- The preflight rejects every Supabase host except EduEnroll-dev before constructing a service-role client.
- No production database access is automated.
- A human verifies the production slug-to-school ownership mapping in the superadmin UI.
- Code is deployed before DNS is changed, and environment changes require redeployment.
- No secrets or environment values are added to source control.

## Impact Summary

| Area | Expected impact |
|---|---|
| Existing KuuNyi tenants | No intended routing or payment behavior change. |
| Configured custom-domain tenant | Student-facing pages and allowed public APIs resolve to the mapped tenant. |
| Unknown hosts | No generic tenant inference or production development fallback. |
| Staff and platform routes | Redirected or rejected so they remain on controlled platform hosts. |
| ABank/MMQR | Provider callbacks use the stable platform origin. |
| PayPay/Stripe | Customer returns remain on the branded tenant origin. |
| HitPay | Custom-domain deployment remains blocked until P2 and P3. |
| Database | Read-only dev preflight; no migration. |
| Agent integration | Existing behavior preserved temporarily; secure contract migration remains F2. |

## Final Recommendation

**Proceed with implementation of Tasks 1–8.**

Add the optional `MMPAY_MODE` cleanup while creating the callback test, then execute each task's red/green/full-suite checks exactly as written. Do not begin production DNS or environment configuration until P1, P2, and P3 are all merged and deployed. Before merging the custom-domain PR, replace the temporary F2 task chip with a durable owned issue URL.
