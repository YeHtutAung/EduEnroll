# Tenant Custom Domains V3.6 Review

## Overall Verdict

**V3.6 is architecturally ready and almost execution-ready. One concrete Task 5 test-harness gap remains before implementation.**

The two V3.5 findings are resolved correctly:

- Task 1 restores `TENANT_CUSTOM_DOMAINS` with delete-aware logic.
- Task 5 repairs the existing `origin.test.ts` cleanup before adding the fallback test and gives the new callback test delete-aware cleanup for both mutated variables.

Tasks 1–4 and 6–8 now have coherent setup, red/green verification, full-suite checks, and scoped commits. The host-aware middleware factory remains correct, and the P1–P3 deployment gate remains explicit.

Task 5 still omits one dependency required to run its route handlers offline: `resolveTenantId()`. Both ABank and MMPay call it before parsing the request or creating an admin client. Directly invoking the route without mocking `@/lib/api` attempts to use Next.js request-scoped `headers()` outside a request context, so the test can fail before reaching the callback assertion.

Verified plan state:

- Eight numbered tasks.
- 70 unchecked items and zero checked items.
- No tracked implementation files under `src/`, `scripts/`, `package.json`, or `.env.local.example` were changed by V3.6.
- The plan and review directory remain untracked.

## Findings

| Severity | Finding | Impact | Required correction |
|---|---|---|---|
| **Medium** | Task 5 Step 6 instructs the implementer to mock the admin client and payment providers but not `@/lib/api`. Both target routes call `resolveTenantId()` first. | The new callback test can fail in `next/headers()` before reaching either provider spy, so its red/green result would not prove callback-origin behavior. | Add `vi.mock("@/lib/api", () => ({ resolveTenantId: vi.fn().mockResolvedValue("tenant-1") }))` before importing either route. |
| **Medium** | The concrete callback assertion covers ABank only; MMPay is described as “the equivalent” without a required assertion. | ABank can pass while MMPay continues deriving callbacks from the inbound host. Grep is useful defense in depth but is weaker than exercising the second route. | Require at least one MMPay provider-spy assertion and verify the expected sandbox or production callback path. |
| **Low** | Task 5 references `postTo()` and chainable provider/database fixtures without defining their minimum contract. | An implementer can lose time or accidentally build a test that returns early on invalid JSON, missing enrollment, or tenant resolution. | State that `postTo()` must send a valid POST JSON body and that the admin stub must return a pending enrollment before accepting payment insertion. |

## V3.5 Findings Recheck

| V3.5 finding | V3.6 result | Status |
|---|---|---|
| Task 1 restored an absent env variable as `"undefined"` | Delete-aware cleanup is now part of Task 1 Step 2. | **Resolved** |
| Existing origin tests had unsafe cleanup | Task 5 Step 1 repairs the cleanup before adding new tests. | **Resolved** |
| Callback tests lacked environment cleanup | Step 6 restores both `NEXT_PUBLIC_APP_URL` and `TENANT_CUSTOM_DOMAINS` delete-aware. | **Resolved** |
| F2 was not durably tracked | Plan still requires a real owned tracker issue and URL before merge. | **Maintained as merge gate** |

## Required Task 5 Addition

Add this mock to `src/__tests__/payments/callback-urls.test.ts` before dynamically importing the route modules:

```typescript
vi.mock("@/lib/api", () => ({
  resolveTenantId: vi.fn().mockResolvedValue("tenant-1"),
}));
```

This matches the established repository pattern in tests such as:

- `src/__tests__/payments/hitpay-create.test.ts`
- `src/__tests__/payments/hitpay-status.test.ts`
- `src/__tests__/enrollment/enroll.test.ts`
- `src/__tests__/tickets/enrollmentTickets.test.ts`

The request helper must reach the payment-provider call rather than return early:

```typescript
function postTo(url: string) {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: new URL(url).host,
    },
    body: JSON.stringify({ enrollmentRef: "ENR-TEST-001" }),
  });
}
```

The admin-client fixture must provide a pending enrollment with enough class or cart data to calculate a fee, followed by a successful payment insert. Otherwise the handler returns `404`, `409`, or `500` before invoking the provider.

### Required ABank assertion

```typescript
expect(createOrderSpy).toHaveBeenCalledWith(
  expect.objectContaining({
    callbackUrl: "https://kuunyi.com/api/webhooks/abank",
  }),
);
```

### Required MMPay assertion

With `MMPAY_MODE` absent or set to sandbox:

```typescript
expect(sandboxPaySpy).toHaveBeenCalledWith(
  expect.objectContaining({
    callbackUrl: "https://kuunyi.com/api/sandbox/payments/webhook",
  }),
);
```

If the test mutates `MMPAY_MODE`, add it to the delete-aware environment cleanup. Alternatively, test the default sandbox branch without mutating it and add a separate production-path test only if that distinction is important to this change.

The red phase should prove that both provider spies receive the inbound custom or spoofed host today. The green phase should prove that both receive `platformOrigin()` after Step 8.

## Sequential Execution Assessment

| Task | Assessment |
|---|---|
| Task 1 — resolver | Complete red/green sequence, cleanup fixed, full suite before commit. |
| Task 2 — duplicate removal | Precondition comparison, replacement, reference scan, full verification, commit. |
| Task 3 — fallback restriction | Complete offline host-aware scaffold, red/green checks, agent compatibility, full verification. |
| Task 4 — surface split | Correctly reuses Task 3 scaffold, verifies redirects/matcher, full verification. |
| Task 5 — callbacks | Cleanup and implementation order are correct; route-test dependency and MMPay assertion remain incomplete. |
| Task 6 — preflight | Dev-host guard precedes admin client construction; explicit run and commit. |
| Task 7 — documentation | Scoped env documentation and commit. |
| Task 8 — PR | State check, expected diff, explicit exclusion of HitPay, human-reviewed PR workflow. |

## Security Assessment

No new architectural security blocker was found in V3.6.

### Tenant isolation

- Custom hosts resolve only through the configured allowlist.
- Unknown hosts cannot infer tenant identity from arbitrary DNS labels.
- Production denies query, cookie, and environment development fallback on unknown hosts.
- Configured custom domains overwrite forged tenant headers with host-derived tenant context.
- The existing root-host tenant-header trust debt remains accurately documented in F2 and requires durable tracking before merge.

### Payment boundaries

- ABank and MMPay machine callbacks move to `platformOrigin()`.
- Customer-facing PayPay and Stripe returns remain tenant-branded.
- HitPay deployment remains blocked until both P2 and P3 are deployed.
- P1–P3 must all be merged and deployed before DNS or production environment configuration.

The remaining Task 5 issue is test completeness, but it matters: both payment providers must have executable proof that client-controlled hosts cannot influence machine callback destinations.

### Operational safety

- Preflight access is restricted to the exact EduEnroll-dev Supabase hostname before service-role client creation.
- No production database access is proposed.
- The production host-to-school mapping requires manual superadmin confirmation.
- Code is deployed before DNS is pointed at the application.
- Environment changes require redeployment and no secrets are added to the repository.

## Impact Summary

| Area | Assessment |
|---|---|
| Resolver and parser | Ready |
| Middleware and surface routing | Ready |
| Middleware tests | Ready |
| ABank callback implementation | Ready; test needs tenant-resolution mock |
| MMPay callback implementation | Ready; explicit provider assertion still needed |
| HitPay | Correctly excluded and deployment-blocked on P2/P3 |
| Preflight | Ready and dev-only |
| F2 agent/header debt | Correctly deferred; durable issue required before merge |
| Production rollout | Blocked on implementation verification and P1–P3 |

## Final Recommendation

**Add the `resolveTenantId()` mock and an explicit MMPay callback assertion to Task 5, then approve V3.6 for implementation.**

The plan's architecture, security boundaries, task ordering, and operational rollout are otherwise ready. This is one localized test-harness correction, not another design revision. Production deployment must still wait for P1, P2, and P3 and for the durable F2 issue to have an owner and URL.
