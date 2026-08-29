# Tenant Custom Domains V3.3 Review

## Overall Verdict

**V3.3 is conditionally ready for implementation, but it is not ready for production rollout.**

The plan now cleanly separates the eight custom-domain tasks from the two HitPay changes and acknowledges the real agent-authentication collision. Deferring the tenant-header/agent migration to F2 is a defensible scope decision because the custom-domain resolver overwrites the header on configured custom domains and does not create the existing root-host behavior.

Before implementation, correct the environment-variable documentation and make the agent compatibility check executable. Before deployment, fix the stale deployment prerequisite sentence so P3 cannot be skipped.

Verified plan state:

- Eight numbered tasks.
- 69 unchecked checklist items and zero checked items.
- No tracked application files under `src/`, `scripts/`, `package.json`, or `.env.local.example` were changed by V3.3.
- The plan and review directory remain untracked, so they will need deliberate staging rather than a broad `git add`.

## Findings

| Severity | Finding | Impact | Required correction |
|---|---|---|---|
| **High** | The Deployment section still says only PR #163 and “the HitPay allowlist PR” are prerequisites, while the plan's authoritative prerequisite table requires P1, P2, and P3. | An operator following the deployment section could configure DNS after P2 but before P3, causing legitimate HitPay custom-domain return URLs to be rejected. | Replace the Deployment prerequisite sentence with the three explicit names: P1 ABank callback verification, P2 base HitPay redirect allowlist, and P3 F1 tenant custom-origin extension. |
| **Medium** | V3.3 says `VERCEL_ENV` may contain custom environment names. Current Vercel documentation assigns custom environment names to `VERCEL_TARGET_ENV`; `VERCEL_ENV` remains `production`, `preview`, or `development`. | The proposed guard still works, but its rationale and future-environment guidance are factually inaccurate. | Restore the three-value description for `VERCEL_ENV`. If custom-environment identity is needed, read `VERCEL_TARGET_ENV`. Keep the current production-deny plus recognized-dev-host guard. |
| **Medium** | Task 3 says unknown hosts cannot acquire a tenant by “ANY route,” while V3.3 intentionally preserves inbound `x-tenant-slug` on unresolved hosts. | The test name and comments promise a stronger boundary than the implementation provides, making future audits likely to over-credit the fix. | Rename the test group and comments to say unknown production hosts cannot use query, cookie, or environment fallback. Explicitly reference F2 beside that limited assertion. |
| **Medium** | Step 6 says to verify the signed agent path still works but supplies no command, test file, fixture, or expected response. No existing test exercises signed agent authentication through middleware. | `npm test` can pass without proving the compatibility claim that justified removing header sanitization. | Add a focused middleware/auth regression test or provide a concrete test procedure with a safe fixture. At minimum, prove the root-host agent header remains available after Task 3 and that the fallback change does not rewrite it. |
| **Medium** | F2 is “filed” only as a non-task section inside this implementation plan. | The unsigned tenant selector can be forgotten when the custom-domain plan is completed or archived. | Create a separately tracked security task before merging this plan, with owner, priority, acceptance tests, and the host-derived contract as the preferred design. Link its identifier from F2. |
| **Low** | “It grants nothing today” is too absolute. A forged header selects tenant context for public routes backed by `createAdminClient()`, including enrollment, status, bank-account, upload, and payment-creation flows. | Those capabilities appear intentionally public and are already reachable through the tenant subdomain, so no incremental privilege escalation was confirmed; however, the wording hides a real trust-boundary effect. | Say “no additional capability beyond the tenant's public subdomain was identified,” and retain the list of affected consumers for F2 review. |

## Delta From V3.2 Review

| V3.2 concern | V3.3 status | Assessment |
|---|---|---|
| Agent authentication conflicts with tenant-header deletion | **Addressed by scope separation** | Acceptable for this PR if F2 becomes an independently tracked security item. |
| Header deletion was inside route-skip logic | **Removed from this plan and documented in F2** | Correctly records that future sanitization must occur before `shouldSkipTenant()`. |
| HitPay F1 absent but still expected in the current PR | **Resolved** | HitPay is removed from File Structure and Task 8's expected diff. |
| Base HitPay and custom-origin extension were conflated | **Mostly resolved** | P2 and P3 are clearly separated at the top and in verification; line 1340 of the Deployment section is still stale. |
| Custom Vercel environment behavior understated | **Changed, but now factually wrong** | `VERCEL_TARGET_ENV`, not `VERCEL_ENV`, carries a custom environment name. |

## Security Review

### Tenant resolution

The core custom-domain boundary is now sound in design:

- Custom hosts are accepted only through `TENANT_CUSTOM_DOMAINS`.
- Platform subdomains retain their existing explicit resolver rules.
- Arbitrary multi-label hosts no longer infer tenants from the first label.
- On a configured custom domain, middleware overwrites a forged tenant header with the configured tenant.
- In production, unknown hosts cannot use `?tenant=`, the tenant cookie, or `NEXT_PUBLIC_DEV_TENANT` as a fallback.

The plan must not describe this as complete header sanitization. On a root or unresolved host, the copied inbound `x-tenant-slug` still survives by design until F2.

### Existing header trust debt

The codebase confirms both sides of the F2 collision:

1. `src/lib/api.ts` requires `x-tenant-slug` for signed agent authentication and grants an owner-shaped agent context for the selected tenant.
2. The HMAC covers `chatId + "." + rawBody`, not the tenant slug.
3. The selected tenant is constrained by `allowed_chat_ids`, which mitigates but does not cryptographically bind tenant selection.
4. `resolveTenantId()` also trusts the header for numerous unauthenticated public routes using the service-role client.

No new cross-tenant privilege escalation was confirmed from this behavior because the public operations are already exposed on each tenant's intended subdomain, and privileged agent use still requires a valid signature plus a chat ID allowed for the selected tenant. It remains a genuine trust-boundary weakness and should not live only in this plan document.

The preferred F2 design remains host-derived tenant identity:

```text
bot -> https://<tenant>.kuunyi.com/api/admin/...
    -> middleware removes caller tenant header
    -> middleware derives tenant from controlled host
    -> requireAuth consumes internal tenant context
```

If the bot must supply a slug, the slug, method, path, timestamp, nonce, and body should be included in a versioned signed message with replay protection.

### Payment security

The payment split is now architecturally clear:

- ABank and MMPay provider callbacks are pinned to the stable platform origin.
- PayPay and Stripe customer return URLs remain tenant-branded.
- P2 rejects arbitrary HitPay redirect origins.
- P3 permits only the configured custom origin for the mapped tenant.
- Production DNS remains blocked until P1, P2, and P3 are deployed.

This follows the correct boundary: provider callbacks/webhooks remain on a platform-controlled origin, while customer return URLs may be branded only when the server validates and tenant-binds their origins.

### Environment guard correction

The implementation can remain:

```typescript
process.env.VERCEL_ENV !== "production" && isDevHost
```

Current Vercel documentation defines:

- `VERCEL_ENV`: `production`, `preview`, or `development`.
- `VERCEL_TARGET_ENV`: one of those standard values or the name of a custom environment.

Therefore custom Vercel environments normally remain non-production under the proposed `VERCEL_ENV` guard and are additionally constrained by `isDevHost`. If the project later needs per-custom-environment policy, use `VERCEL_TARGET_ENV` explicitly. See [Vercel system environment variables](https://vercel.com/docs/environment-variables/system-environment-variables).

## Required Plan Corrections

### 1. Fix the deployment gate

Replace:

```markdown
Prerequisites: PR #163 (ABank) and the HitPay allowlist PR must be merged and deployed first.
```

With:

```markdown
Prerequisites: P1 ABank callback verification, P2 base HitPay redirect
allowlist, and P3 F1 tenant custom-origin extension must all be merged and
deployed before DNS or production environment configuration.
```

### 2. Correct Vercel environment terminology

State that `VERCEL_ENV` has the three standard values. Mention `VERCEL_TARGET_ENV` only if custom-environment classification is required.

### 3. Narrow the Task 3 assertion

Replace “unknown hosts cannot acquire a tenant by ANY route” with:

```text
Unknown production hosts cannot acquire tenant context through the development
fallback: query parameter, cookie, or NEXT_PUBLIC_DEV_TENANT. Caller-supplied
x-tenant-slug remains an acknowledged F2 issue.
```

### 4. Make agent compatibility verifiable

Step 6 needs an actual assertion. A minimal middleware regression test can document current compatibility:

```typescript
it("preserves the current root-host agent tenant header pending F2", async () => {
  process.env.VERCEL_ENV = "production";
  const res = await middleware(
    new NextRequest(
      new Request("https://kuunyi.com/api/admin/payments/payment-id/verify", {
        headers: {
          "x-agent-signature": "test-signature",
          "x-chat-id": "123",
          "x-tenant-slug": "flashtic",
        },
      }),
    ),
  );

  expect(
    res.headers.get("x-middleware-request-x-tenant-slug"),
  ).toBe("flashtic");
});
```

The test should be explicitly temporary and linked to F2, where its expectation will be replaced by host-derived tenant behavior.

## Impact Summary

| Area | Expected impact |
|---|---|
| Existing KuuNyi subdomains | No intended behavior change. |
| Configured custom domains | Student pages and approved public APIs resolve to the mapped tenant. |
| Unknown production hosts | Generic host inference and development fallback are denied; caller tenant header remains deferred debt. |
| Staff/admin surfaces | Redirected to the tenant's KuuNyi subdomain or platform root as appropriate. |
| ABank/MMQR callbacks | Stabilized on the platform origin. |
| HitPay | Custom-domain rollout blocked until both P2 and P3 are deployed. |
| Agent payment verification | Preserved under the current root-host/header contract; migration deferred to F2. |
| Database | No schema change; preflight reads EduEnroll-dev only. |
| Operations | Code may merge before prerequisites, but DNS and production configuration must wait for P1–P3. |

## Final Recommendation

**Approve the eight-task implementation after the four plan corrections above. Do not approve deployment yet.**

V3.3 resolves the substantive custom-domain architecture issues from V3.2. The remaining high-severity item is a stale deployment instruction rather than an implementation flaw. F2 may remain out of this PR, but it should become a separately owned security task before the custom-domain work is merged.
