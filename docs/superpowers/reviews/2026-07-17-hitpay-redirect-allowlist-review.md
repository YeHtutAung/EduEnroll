# HitPay Redirect Allowlist Plan Review

**Plan reviewed:** `docs/superpowers/plans/2026-07-17-hitpay-redirect-allowlist.md`  
**Review date:** 2026-07-17  
**Verdict:** Revise before implementation

## Summary

The overall design is sound, and rejecting an invalid supplied redirect with `400` is the correct choice. However, two assumptions leave the redirect boundary incomplete: one real card caller does not send `redirectUrl` and therefore relies on the Host-derived fallback, and the non-production exception trusts the request origin without restricting it to recognized development hosts.

## Findings

| Severity | Finding | Required change |
|---|---|---|
| **High** | The plan says both card callers send `redirectUrl`, but `src/app/(public)/enroll/payment/[ref]/page.tsx:1181` sends only `{ enrollmentRef, method: "card" }`. It actively relies on the Host-derived fallback. Leaving that fallback out of scope means the redirect vulnerability is not fully closed. | Update this caller to send its return URL. Make the absent-value fallback server-derived from `tenantOrigin(subdomain)`, never from `Host`. |
| **Medium** | Off production, `allowedOrigins()` accepts `requestOrigin` without checking its hostname. If `VERCEL_ENV=preview` and both candidate and request origin are `https://evil.com`, the proposed helper returns `true`. This is weaker than the custom-domain plan, where non-production fallback is also restricted to recognized development hosts. | Permit the request origin only when its normalized hostname is `localhost`, `*.localhost`, a valid development IP, or `*.vercel.app`. Add a test where an unknown request origin attempts to allow itself. |
| **Low** | The existing fallback uses the untrimmed client `enrollmentRef`. The database lookup trims it, but the resulting URL does not. | Construct fallback paths using `enrollment.enrollment_ref`, the canonical database value. |

## Critical Factual Correction

The plan currently says:

> The client always sends its own origin. Both callers...

That is false. The generic payment page currently sends:

```ts
body: JSON.stringify({
  enrollmentRef: params.ref,
  method: "card",
})
```

Therefore these plan statements must also change:

- "Both current callers always send one."
- "The host-derived fallback is server-constructed, not client input."
- The Host-derived fallback being listed as out of scope.

The fallback is assembled by the server, but its origin comes from the inbound `Host`, which is still request data.

## Recommended Design

### Supplied redirect

When `redirectUrl` is present:

1. Require a string and absolute URL.
2. Reject credentials.
3. Compare the normalized origin exactly.
4. Reject invalid or disallowed values with `400`.
5. Do not call HitPay or create a payment record.

### Missing redirect

Use a trusted fallback:

```ts
const fallbackRedirectUrl =
  `${tenantOrigin(enrollment.tenants.subdomain)}` +
  `/enroll/payment/${encodeURIComponent(enrollment.enrollment_ref)}` +
  `?hitpay=success`;
```

Do not use `Host` for this fallback.

Also update the generic payment page to send:

```ts
const redirectUrl =
  `${window.location.origin}/enroll/payment/` +
  `${encodeURIComponent(params.ref)}?hitpay=success`;
```

This preserves preview behavior for the normal caller, while the canonical fallback safely covers older or unusual clients.

### Non-production exception

The policy should match the custom-domain plan:

```text
VERCEL_ENV !== production
AND request hostname is a recognized development host
```

Add this missing pure-helper test:

```ts
it("does not let an unknown request origin allow itself off production", () => {
  process.env.VERCEL_ENV = "preview";

  expect(
    isAllowedRedirect(
      "https://evil.com/phish",
      TENANT,
      "https://evil.com",
    ),
  ).toBe(false);
});
```

Route-level coverage should also prove that a spoofed Host cannot influence the absent-value fallback.

## Design Decisions Confirmed

The following decisions are correct:

- Production allows only `tenantOrigin(subdomain)`.
- `platformOrigin()` should not be included.
- Exact `URL.origin` comparison handles scheme, hostname, and port.
- Credential-bearing URLs need explicit rejection.
- Malformed URLs should produce `400`, not `500`.
- Invalid supplied redirects should be rejected rather than silently replaced.
- PayNow should ignore `redirectUrl`.
- Fetching the subdomain through the existing enrollment join is appropriate.
- The staging environment check is necessary; fix `NEXT_PUBLIC_APP_URL` if misconfigured rather than widening production policy.
- Pure helper tests plus route wiring tests are appropriate.

## Required Plan Revisions

- [ ] Correct the claim that both card callers already send `redirectUrl`.
- [ ] Add `redirectUrl` to `src/app/(public)/enroll/payment/[ref]/page.tsx`.
- [ ] Replace the Host-derived missing-value fallback with `tenantOrigin(subdomain)`.
- [ ] Build the fallback path from `enrollment.enrollment_ref`.
- [ ] Restrict the non-production request-origin exception to recognized development hosts.
- [ ] Add a pure test where an unknown request origin attempts to allow itself.
- [ ] Add a route test proving a spoofed Host cannot influence the fallback.
- [ ] Keep the staging environment verification as a pre-deployment requirement.

## Final Recommendation

Revise the plan before implementation. Once the fallback and non-production host constraint are corrected, the focused four-task approach is appropriate and implementation can proceed.
