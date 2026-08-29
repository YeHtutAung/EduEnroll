# Tenant Custom Domains V3.5 Review

## Overall Verdict

**V3.5 resolves the V3.4 implementation blockers. The plan is ready after one small, mechanical test-environment correction covering Tasks 1 and 5.**

The revised middleware scaffold was checked against the installed Next.js runtime. Its host-aware factory works as intended:

```json
{"host":"flashtic.com","hostname":"flashtic.com"}
```

Task 3 now owns a complete offline test scaffold, Task 4 reuses it, the agent compatibility assertion is executable, the live F2 wording is accurate, and the P1–P3 deployment gate remains explicit.

The claim that all remaining `afterEach` matches are prose warnings is not fully correct. Task 1 still contains a live unsafe restoration at lines 209–211, and the existing origin test modified by Task 5 contains the same pattern without a planned correction.

Verified plan state:

- Eight numbered tasks.
- 69 unchecked items and zero checked items.
- No tracked implementation files under `src/`, `scripts/`, `package.json`, or `.env.local.example` were changed by V3.5.
- The plan and review directory remain untracked.

## Findings

| Severity | Finding | Impact | Required correction |
|---|---|---|---|
| **Medium** | Task 1's live test code saves `TENANT_CUSTOM_DOMAINS` and restores it with `process.env.TENANT_CUSTOM_DOMAINS = original`. | When the variable was originally absent, the test leaves the string `"undefined"` in the environment. Resolver tests can become order-dependent and exercise a malformed map instead of an absent map. | Replace Task 1's restoration with delete-aware logic. |
| **Medium** | Task 5 modifies `src/__tests__/lib/origin.test.ts`, whose current `afterEach` restores `NEXT_PUBLIC_APP_URL` with the same unsafe assignment. The plan adds tests that explicitly delete and mutate that variable but does not repair the existing cleanup. | The `platformOrigin()` fallback test can leak state into later tests, and later tests may observe `"undefined"` as a URL. | Make the origin test's cleanup delete-aware as part of Task 5. Give the new callback test equivalent cleanup for `NEXT_PUBLIC_APP_URL` and `TENANT_CUSTOM_DOMAINS`. |
| **Low** | F2 now correctly admits that `task_47d00374` is not durable and requires a real owned issue before merge. | This is no longer misleading, but the security debt is not yet durably tracked. | Treat the real issue URL and owner as a merge prerequisite, exactly as the live plan now states. |

## V3.4 Findings Recheck

| V3.4 finding | V3.5 result | Status |
|---|---|---|
| Middleware requests omitted the `Host` header | One shared factory derives `host` from the URL and overwrites any caller-supplied value. Runtime check passed. | **Resolved** |
| Task 3 lacked imports and Supabase mocking | Task 3 now creates the complete imports, mock, environment scaffold, and request factory before running tests. | **Resolved** |
| Task 4 duplicated setup and unsafe cleanup | Task 4 now appends test cases only and explicitly reuses Task 3's setup. | **Resolved** |
| Live F2 retained “It grants nothing today” | Live F2 now states that no additional capability was identified while listing the real service-role-backed consumers. | **Resolved** |
| F2 task identifier was not durably verifiable | The plan now labels it as a session-only chip and requires a real owned issue before merge. | **Resolved as a process gate** |

## Required Test Cleanup

### Task 1: tenant resolver tests

Replace:

```typescript
const original = process.env.TENANT_CUSTOM_DOMAINS;
afterEach(() => {
  process.env.TENANT_CUSTOM_DOMAINS = original;
});
```

With:

```typescript
const original = process.env.TENANT_CUSTOM_DOMAINS;

afterEach(() => {
  if (original === undefined) {
    delete process.env.TENANT_CUSTOM_DOMAINS;
  } else {
    process.env.TENANT_CUSTOM_DOMAINS = original;
  }
});
```

### Task 5: origin tests

Task 5 should explicitly update the existing cleanup in `src/__tests__/lib/origin.test.ts`:

```typescript
const original = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  if (original === undefined) {
    delete process.env.NEXT_PUBLIC_APP_URL;
  } else {
    process.env.NEXT_PUBLIC_APP_URL = original;
  }
});
```

The new `callback-urls.test.ts` should save and restore both variables it mutates:

```typescript
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
const originalDomainMap = process.env.TENANT_CUSTOM_DOMAINS;

afterEach(() => {
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;

  if (originalDomainMap === undefined) delete process.env.TENANT_CUSTOM_DOMAINS;
  else process.env.TENANT_CUSTOM_DOMAINS = originalDomainMap;
});
```

This is a test-hygiene correction only; it does not change the feature architecture.

## Security Assessment

### Tenant boundary

The custom-domain security model is now coherent:

- Only configured custom hosts map to tenants.
- Unknown hosts cannot infer a tenant from a DNS label.
- Query, cookie, and environment development fallbacks are denied in production on unknown hosts.
- A configured custom domain or KuuNyi tenant subdomain overwrites a forged tenant header with host-derived context.
- The unresolved root-host header trust issue is accurately separated into F2 with a preferred host-derived agent contract.

### Middleware verification

The corrected test factory now exercises the same input the middleware reads:

```typescript
function middlewareRequest(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(url).host);
  return new NextRequest(new Request(url, { ...init, headers }));
}
```

This makes the custom-host resolution, unknown-host rejection, surface split, and forged-header replacement assertions meaningful rather than URL-only simulations.

### Payment boundary

The payment design remains sound:

- Provider callbacks for ABank and MMPay are pinned to the stable platform origin.
- Customer-facing PayPay and Stripe returns remain tenant-branded.
- P2 rejects arbitrary HitPay redirect destinations.
- P3 permits the mapped custom origin for the correct tenant.
- DNS and production configuration remain blocked until P1, P2, and P3 are all merged and deployed.

The Stripe/payment security guidance reinforces this split: machine callbacks and webhooks belong on platform-controlled endpoints, while branded customer return destinations must be server-validated and tenant-bound.

### Preflight and operations

- The preflight checks the exact EduEnroll-dev Supabase hostname before creating the service-role client.
- It cannot accept an arbitrary project reference or connection string.
- Production ownership confirmation remains a manual superadmin comparison rather than direct production database access.
- Code ships before DNS, reducing the risk of traffic reaching an unprepared deployment.

## Impact Summary

| Area | Assessment |
|---|---|
| Resolver/parser | Ready |
| Middleware implementation | Ready |
| Middleware tests | Ready; host-aware factory verified locally |
| Tenant-header/agent debt | Correctly deferred, real tracker still required before merge |
| Payment callbacks | Ready |
| HitPay custom returns | Deployment-blocked on P2 and P3 |
| Preflight | Ready and dev-only |
| Test isolation | Two small cleanup corrections remain in Tasks 1 and 5 |
| Production rollout | Blocked on P1–P3 and normal post-implementation verification |

## Final Recommendation

**Apply the two delete-aware cleanup edits, then approve the eight-task plan for implementation.**

No architectural or release-security blocker remains in V3.5. The remaining corrections are localized test isolation fixes, but they should be written into the plan before execution because the plan explicitly promises deterministic full-suite verification. Production rollout must still wait for P1, P2, and P3, and the F2 security issue must have a durable owner and tracker URL before merge.
