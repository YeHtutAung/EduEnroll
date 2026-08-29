# Tenant Custom Domains V2 Review

## Overall Verdict

V2 is substantially better than V1 and fixes most previously identified architectural problems.

However, it should be revised before implementation because two significant security issues remain:

1. The ABank callback can currently be forged to confirm an unpaid enrollment.
2. The generic three-part hostname fallback can bypass the new custom-domain allowlist.

The first issue is pre-existing, but V2 directly modifies and relies on that payment callback flow.

## V2 Summary

The revised proposal introduces:

- One canonical host-to-tenant resolver in `src/lib/tenant.ts`.
- Removal of the duplicate middleware resolver.
- A validated and cached `TENANT_CUSTOM_DOMAINS` map.
- Custom domains restricted to student-facing pages.
- Staff pages redirected to KuuNyi origins.
- `/` and `/register` added to the middleware matcher.
- ABank and MMQR callbacks moved away from client-controlled domains.
- Branded customer return URLs retained for Stripe, HitPay, and PayPay.
- A safer rollback procedure that accounts for pending payments.
- No database migrations or separate Vercel projects.

## What V2 Fixed Correctly

| Previous problem | V2 status |
|---|---|
| Middleware-only custom-domain resolution | Fixed by modifying the shared resolver |
| Duplicate domain resolvers | Fixed by deleting middleware's copy |
| Missing `/` and `/register` matcher entries | Fixed |
| Prototype-property lookup in plain objects | Fixed by using `Map` |
| Malformed environment variable taking down middleware | Fixed with fail-closed parsing |
| Missing hostname and slug validation | Mostly fixed |
| Host-derived ABank/MMQR callbacks | Addressed, although the implementation should be revised |
| Unsafe immediate DNS rollback | Addressed with a drain period |
| Admin API blocklist treated as the security boundary | Correctly reframed as hygiene |

## Security Findings

| Severity | Finding | Impact | Required action |
|---|---|---|---|
| Critical | The ABank callback is unauthenticated and trusts query parameters. | Anyone with an `orderId` can potentially mark an unpaid enrollment as confirmed. The public payment route returns the order ID to the student. | Before updating a payment, perform a server-to-server `enquiryOrder()` and verify the order ID, provider status, amount, and transaction reference. Use callback signatures if ABank supports them. |
| High | The canonical resolver still accepts arbitrary unconfigured three-part domains. | `flashtic.attacker.com` resolves as tenant `flashtic` even when absent from `TENANT_CUSTOM_DOMAINS`. | Remove the generic fallback and return `null` for unknown domains. Add a test for `flashtic.evil.com`. |
| Medium-High | The HitPay open redirect remains deferred. | A card-payment request accepts an arbitrary client `redirectUrl`, enabling payment-themed phishing redirects. | Fix it before enabling HitPay cards on custom domains. Compare parsed origins against a trusted tenant-origin allowlist. |
| Medium | Task 4's callback implementation is incomplete and uses a future-mutable helper. | Neither payment route currently has `tenantInfo`; adding it requires another query. A future custom-domain-aware `tenantOrigin()` could move callbacks back to client-controlled domains. | Introduce an explicit stable platform-origin helper for machine callbacks. |
| Medium | Redirect destinations conflict with the routing table. | The code sends `/register` and `/superadmin` to the tenant subdomain, although they are root-platform surfaces. | Redirect `/register` and `/superadmin` to `https://kuunyi.com`; redirect `/admin`, `/login`, and tenant onboarding to the tenant subdomain. |
| Medium | Tenant existence is verified only manually after deployment. | A valid but incorrect slug could route enrollment and payment operations to another real tenant. | Add a read-only pre-deployment validation step or require an explicit two-person configuration review. |
| Low | Slug validation permits a trailing hyphen. | Values such as `school-` pass the proposed expression. | Require the slug to end in an alphanumeric character. |
| Low | Invalid entries are silently discarded. | Configuration errors may appear only as generic branding or tenant-not-found responses. | Add a redacted initialization warning or standalone validation command without logging environment values. |

## Critical: ABank Payment Confirmation Bypass

The current ABank callback:

- Accepts a public `GET` request.
- Parses `orderId`, `status`, amount, and transaction information from query parameters.
- Looks up the payment by `payment_ref`.
- Treats any non-empty `status` as successful.
- Marks the payment verified and the enrollment confirmed.
- Does not verify a signature.
- Does not call ABank to confirm the transaction.
- Does not compare the paid amount with the expected amount.

The public order-creation route returns the `orderId`, so it must not be treated as secret.

### Required secure flow

```text
ABank callback received
        |
        v
Look up local pending payment
        |
        v
Call ABank enquiryOrder(orderId)
        |
        v
Verify provider status is successful
        |
        v
Verify provider order ID and amount
        |
        v
Atomically mark payment and enrollment confirmed
```

Callback URL pinning improves availability, but it does not authenticate the callback.

## Custom-Domain Allowlist Bypass

The proposed resolver still ends with:

```typescript
return parts.length >= 3 ? parts[0] : null;
```

After introducing an explicit custom-domain map, arbitrary-domain inference should be removed:

```typescript
// Known KuuNyi, Vercel, and localhost cases are handled above.
// Every other domain must be explicitly configured.
return null;
```

Add these tests:

```typescript
expect(extractSubdomainFromHost("flashtic.evil.com")).toBeNull();
expect(extractSubdomainFromHost("www.evil.com")).toBeNull();
expect(extractSubdomainFromHost("unknown.example.org")).toBeNull();
```

Vercel domain assignment provides some external protection, but application-level tenant isolation should not depend exclusively on hosting configuration.

## Recommended Payment Callback Design

V2 correctly distinguishes between machine callbacks and customer return URLs. Machine callbacks should use an explicitly stable platform origin rather than `tenantOrigin()`.

```typescript
export function platformOrigin(): string {
  const configured =
    process.env.NEXT_PUBLIC_APP_URL ?? "https://kuunyi.com";

  return new URL(configured).origin;
}
```

ABank usage:

```typescript
const callbackUrl =
  `${platformOrigin()}/api/webhooks/abank`;
```

MMQR usage:

```typescript
const callbackUrl =
  `${platformOrigin()}${callbackPath}`;
```

This avoids:

- An additional tenant query.
- Trusting the inbound `Host` header.
- Dependence on tenant-controlled DNS.
- Future behavior changes to `tenantOrigin()`.
- Per-tenant callback allowlists at payment providers.

The webhook handlers locate payments using provider identifiers, so they do not require a tenant hostname.

## Customer Return URL Security

Stripe, PayPay, and HitPay currently derive return URLs from the inbound host. A safer helper should return the custom-domain origin only when that host is explicitly mapped to the resolved tenant. Otherwise, it should return the trusted KuuNyi tenant origin.

For HitPay, remove unrestricted client control or validate the parsed origin:

```typescript
const parsed = new URL(clientRedirectUrl);

if (!allowedOrigins.has(parsed.origin)) {
  return badRequest("Invalid redirect origin.");
}
```

Do not use `startsWith()` for origin validation.

## Routing Impact

The expected routing should be clarified as follows:

| Path | Custom-domain behavior |
|---|---|
| `/` | Redirect to the same custom domain at `/enroll` |
| `/enroll/*` | Serve normally |
| `/status` | Serve normally |
| `/api/public/*` | Serve normally |
| `/admin/*` | Redirect to the tenant KuuNyi subdomain |
| `/login` | Redirect to the tenant KuuNyi subdomain |
| `/onboarding` | Redirect to the tenant KuuNyi subdomain |
| `/register` | Redirect to platform root `kuunyi.com` |
| `/superadmin` | Redirect to platform root `kuunyi.com` |
| `/api/admin/*` | Return `404` |
| `/api/saas/*` | Return `404` |
| `/api/superadmin/*` | Return `404` |

## Expected Impact

### Positive impact

- Tenants receive branded enrollment and payment URLs.
- Custom domains are pinned to one tenant.
- The `?tenant=` override cannot switch tenants on configured custom domains.
- Existing KuuNyi tenant subdomains continue working.
- No schema or production database changes are required.
- Middleware and server components use the same resolver.
- Machine callbacks become independent of custom-domain DNS.

### Runtime impact

- The environment map is parsed once per changed raw value and cached.
- Middleware no longer duplicates resolver logic.
- `/` enters middleware, but the early return avoids a Supabase authentication request.
- Server layouts and public APIs gain reliable custom-domain fallback resolution.

### Operational impact

Every custom domain requires:

1. Vercel domain assignment.
2. Domain ownership verification.
3. Environment-map update.
4. Application redeployment.
5. DNS configuration.
6. TLS provisioning.
7. Tenant-resolution verification.
8. Provider-specific payment testing.

### Product impact

- Student pages receive custom branding.
- Staff remain on KuuNyi subdomains.
- Outbound email, SMS, Messenger, and Telegram links remain on KuuNyi initially.
- Public content remains available on both origins, creating duplicate SEO content.
- The configuration supports only one normalized custom domain per tenant.

## Required Changes Before Approval

1. Remove generic arbitrary-domain tenant extraction.
2. Secure the ABank callback using server-side payment enquiry or provider signature verification.
3. Use a dedicated stable platform origin for machine callbacks.
4. Fix the HitPay redirect allowlist, or disable HitPay card payments for the initial custom-domain rollout.
5. Separate tenant-staff redirects from root-platform redirects.
6. Tighten slug and hostname validation.
7. Add a read-only configuration preflight for domain-to-tenant mapping.
8. Add automated callback URL tests instead of relying only on grep and live payments.

## Final Assessment

| Area | Assessment |
|---|---|
| Architecture | Good |
| Tenant-resolution design | Good after removing the generic fallback |
| Middleware coverage | Good |
| Configuration hardening | Good, with minor validation gaps |
| Payment callback availability | Improved |
| Payment callback security | Not acceptable for ABank yet |
| Redirect security | HitPay issue remains |
| Rollback design | Good |
| Implementation readiness | Not yet |

**Recommendation:** Approve the general V2 architecture, but revise the proposal once more before implementation. The ABank confirmation vulnerability and arbitrary-domain fallback are release blockers.

