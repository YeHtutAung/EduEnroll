# Tenant Custom Domains V3.2 Review

## Overall Verdict

**V3.2 is substantially safer and more executable than V3.1, but it is not implementation-ready yet.**

The five V3.1 findings were addressed correctly in the plan: the tenant header is explicitly removed, the preflight enforces the exact EduEnroll-dev Supabase host before creating an admin client, HitPay was removed from the numbered task sequence, parser issues can identify a host, and test environment variables are restored with delete-aware handling.

Current plan-state verification:

- Eight numbered tasks are present.
- All 70 checklist items are unchecked.
- No implementation files were changed by this plan update.
- The worktree is not clean: `.claude/settings.local.json` is modified, and the plan, review directory, `AGENTS.md`, and a design directory are untracked. These appear outside the V3.2 implementation scope but must be separated before a feature commit.

Two release-blocking design inconsistencies remain. One was exposed only by comparing V3.2's stronger header rule with the existing agent-authentication code.

## Findings

| Severity | Finding | Impact | Required correction |
|---|---|---|---|
| **High** | V3.2 says nothing sends `x-tenant-slug` inbound, but `requireAuth()` explicitly requires that inbound header for signed KuuNyi agent requests. | The proposed middleware deletion changes an existing API contract. Agent payment-verification calls can fail with `400`, or become dependent on which hostname the external bot calls. | Define the agent request contract before implementation. Prefer deriving tenant from a trusted host and documenting/testing the agent URL. If the agent must supply the slug, include it in the HMAC payload and sanitize/reinject it only on an explicit agent route after signature verification. |
| **High** | HitPay F1 is outside the eight executable tasks, but the File Structure, Task 8 expected diff, deployment prerequisites, and production verification still assume the HitPay custom-origin change is present. | Executing Tasks 1–8 can produce a PR that does not support safe HitPay return URLs on the custom domain, while the plan may still appear complete. | Make F1 a distinct hard deployment prerequisite by name, after the base HitPay allowlist PR, and remove `hitpay/route.ts` from the current PR's expected diff. Alternatively, rewrite F1 after the base PR merges and add it back as an executable task before declaring this plan ready. |
| **Medium** | The header removal is described as unconditional, but its proposed placement is inside `if (!shouldSkipTenant(pathname))`. | Requests under skipped prefixes retain caller-supplied `x-tenant-slug`. Today this intersects with `requireAuth()` on `/api/messenger/*`; future readers under a skipped prefix could silently reopen the trust boundary. | Delete the copied tenant header immediately after `new Headers(request.headers)`, before route skipping. Then reintroduce only host-derived or otherwise cryptographically bound tenant context. Add a regression test for at least one skipped prefix. |
| **Medium** | The current agent signature covers `chatId + "." + rawBody`, not the tenant slug. | Simply preserving the inbound slug for signed agent calls would leave tenant selection outside the authenticated message. The allowed-chat check reduces exposure but is not a substitute for binding tenant identity into the signature. | If tenant remains client-supplied, version the signed payload to include tenant slug, update the bot and server together, use timing-safe verification, and add cross-tenant replay tests. |
| **Low** | The V3.2 prose describes `VERCEL_ENV` as only `production`, `preview`, or `development`. Vercel can also expose custom environment names. | The implementation intentionally treats any non-production `.vercel.app` host as eligible for fallback; the prose understates that behavior. | State the actual policy: production is denied; preview, development, and approved custom Vercel environments are allowed only on recognized development hosts. Add a custom-environment test if those environments are used. |

## Release Blocker 1: Agent Authentication Contract

V3.2 correctly strengthens the previous review's incomplete deletion rule. Deleting only for an unknown non-root host would have left `kuunyi.com` vulnerable to an inbound copied header. Deleting the copied header before setting trusted tenant context is the right security direction.

However, the plan's supporting claim is contradicted by the codebase:

```typescript
// src/lib/api.ts
const slug = headersList.get("x-tenant-slug");
if (!slug) {
  return NextResponse.json(
    { error: "Bad Request", message: "x-tenant-slug header required." },
    { status: 400 },
  );
}
```

The agent path is exercised by `src/app/api/admin/payments/[id]/verify/route.ts`, which accepts `x-agent-signature`, pre-reads the request body, and calls `requireAuth(rawBody)`.

The plan must choose and test one contract:

### Recommended contract: host-derived tenant

1. The bot calls the tenant's platform subdomain, for example `https://flashtic.kuunyi.com/api/admin/payments/...`.
2. Middleware deletes any caller-provided `x-tenant-slug` at the top of the request.
3. Middleware resolves `flashtic` from the trusted host and injects the internal tenant header.
4. `requireAuth()` consumes the middleware-generated header.
5. An integration test proves a signed request works on the tenant subdomain and fails on the platform root or a different tenant host.

This avoids making the custom client-owned domain part of the bot's privileged API contract.

### Alternative contract: signed tenant slug

If the bot cannot call a tenant-specific host, the tenant slug must become part of the authenticated payload, for example a versioned canonical message containing method, path, chat ID, tenant slug, timestamp, nonce, and raw body. This requires a coordinated bot/server migration and replay protection; preserving the existing unsigned header is not an adequate fix.

### Required middleware placement

The sanitizer should run before `shouldSkipTenant()`:

```typescript
const requestHeaders = new Headers(request.headers);
requestHeaders.delete("x-tenant-slug");
```

Only trusted resolution should set it again. Otherwise the plan's “unconditional” statement is false for `/api/messenger/*`, `/api/events*`, `/api/saas/*`, and the other skipped prefixes.

## Release Blocker 2: HitPay Sequencing

Moving HitPay out of the numbered sequence was the right response to V3.1: the base allowlist code does not exist, so an exact patch cannot yet be trusted.

The rest of V3.2 was not fully updated to match that decision:

- **File Structure** still lists `src/app/api/public/payments/hitpay/route.ts` as modified.
- **Task 8** expects the HitPay route in the current PR diff.
- **Deployment prerequisites** name only “the HitPay allowlist PR,” which can be read as the base PR.
- **Verification** expects a custom-domain HitPay return and rejection of a tampered `redirectUrl`.

The base allowlist PR and F1 solve different problems:

| Change | Purpose |
|---|---|
| Base HitPay allowlist | Reject arbitrary client-provided redirect origins. |
| F1 custom-origin extension | Permit the configured custom origin for the correct tenant without permitting another tenant's origin. |

Therefore deployment needs **both** changes. The clearest plan correction is:

1. Keep Tasks 1–8 independent of HitPay and remove the HitPay route from their expected diff.
2. Rename the prerequisites explicitly: **Base HitPay redirect allowlist PR** and **F1 tenant custom-origin extension PR/task**.
3. State that DNS and production env configuration remain blocked until both are merged and deployed.
4. After the base PR merges, rewrite F1 against real code and require:
   - exact parsed-origin comparison;
   - configured custom origin accepted only for its mapped tenant;
   - another tenant's platform or custom origin rejected;
   - malformed, credential-bearing, non-HTTPS production, path-confused, and prefix-lookalike URLs rejected;
   - no open redirect fallback.

This matches secure payment-return handling: return destinations may be branded, but they must be server-allowlisted and tenant-bound; provider callbacks/webhooks remain pinned to a stable platform origin.

## Summary of V3.2 Changes and Impact

| Area | V3.2 result | Codebase impact |
|---|---|---|
| Canonical host resolver | Good | Removes duplicated resolution logic and prevents unknown hosts from being inferred as tenants. |
| Custom-domain allowlist parser | Good | Adds deterministic, testable parsing and actionable local preflight diagnostics. |
| Development fallback | Good with one documentation caveat | Production fallback is closed while local, LAN, and Vercel preview workflows remain available. |
| Header trust boundary | Direction is good; integration contract unresolved | Closes header spoofing for normal routes but can break or bypass the existing agent flow depending on placement. |
| Staff/platform surface split | Good | Keeps admin and platform-only routes on controlled KuuNyi origins; reduces custom-domain session and phishing exposure. |
| Payment callbacks | Good | ABank and MMPay callbacks become stable and independent of client-controlled DNS. |
| HitPay return URL | Blocked | Cannot safely support the custom origin until the base allowlist and F1 are both implemented. |
| Preflight | Good | Enforces the permitted development project before service-role access and leaves production ownership confirmation manual. |
| Operational rollout | Mostly good | Code-before-DNS, explicit Vercel mapping, TLS wait, and tenant-brand verification reduce misrouting risk. |

## Security Assessment

### Security improvements delivered by the plan

- Unknown and unconfigured hosts no longer infer a tenant from their first DNS label.
- Query parameters, cookies, environment fallback, and inbound tenant headers cannot select a tenant in Vercel production on normal matched routes.
- Custom domains are explicit configuration, not an open wildcard.
- Runtime parser logs avoid leaking the configured host map while the local preflight remains actionable.
- Admin, login, onboarding, registration, superadmin, and privileged API surfaces are separated from the client-controlled domain.
- ABank and MMPay provider callbacks are pinned to the platform origin.
- The preflight refuses non-dev Supabase hosts before constructing the service-role client.
- Production tenant/domain ownership is confirmed through the superadmin UI instead of direct production database access.

### Remaining threat scenarios to test

| Scenario | Expected result |
|---|---|
| Forged `x-tenant-slug` on `kuunyi.com` | Header removed; no tenant context. |
| Forged header on a configured custom domain | Ignored and replaced with the host-mapped tenant. |
| Forged header on a skipped route | Removed before skip logic. |
| Signed agent request on correct tenant platform host | Succeeds and resolves only that tenant. |
| Same signed request replayed on another tenant host | Rejected. |
| Signed agent request with a changed tenant slug | Rejected or irrelevant because the slug is host-derived. |
| `?tenant=other-school` on a custom domain | Ignored; configured host mapping wins. |
| Wrong but valid slug in production mapping | Caught by the required human ownership check before DNS. |
| HitPay redirect to another tenant/custom host | `400`; never silently replaced with an attacker-controlled destination. |
| Removal of client DNS after payment begins | Provider callback still reaches the stable platform origin. |

## Required Plan Edits Before Implementation

1. Add an explicit agent-auth compatibility decision and integration tests.
2. Move `requestHeaders.delete("x-tenant-slug")` before all route-skip logic.
3. If tenant slug remains client-supplied for agents, bind it into a versioned HMAC payload and add replay defenses.
4. Remove HitPay from the current eight-task File Structure and Task 8 expected diff.
5. Name both HitPay changes as separate deployment prerequisites, with F1 still blocked until it is rewritten against merged code.
6. Clarify the non-production `VERCEL_ENV` policy, especially if custom Vercel environments are used.

## Final Recommendation

**Revise once more before implementation.** V3.2 resolves all previously reported plan defects, but codebase comparison reveals that its strongest security change conflicts with a real privileged integration. Once the agent tenant contract and the two-stage HitPay prerequisite are made internally consistent, the remaining eight-task implementation plan is well scoped and has a strong security posture.
