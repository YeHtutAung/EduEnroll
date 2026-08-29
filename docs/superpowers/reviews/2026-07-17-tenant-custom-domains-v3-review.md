# Tenant Custom Domains V3 Review

## Overall Verdict

V3 is a strong improvement and resolves the V2 findings, but it still needs a small V3.1 revision before implementation.

The overall architecture is approved. Implementation and deployment remain conditional on the corrections and prerequisites below.

## Remaining Findings

| Severity | Finding | Required change |
|---|---|---|
| High | The resolver becomes an allowlist, but middleware still applies `?tenant=`, cookie, and `NEXT_PUBLIC_DEV_TENANT` fallbacks to every unknown non-root host. | Restrict the fallback to explicit development hosts in non-production environments. Add a middleware test proving `https://flashtic.evil.com/enroll?tenant=flashtic` does not receive a tenant header. |
| High | Task 6 cannot be implemented as written. `domainMap()` is private and retains only a rejection count, while the preflight must reuse it and report individual rejection reasons. | Extract an exported pure parser returning `{ map, issues }`. Runtime uses the map and warns only with counts; preflight prints the issues. |
| High | Deployment instructs running the preflight directly against the production database. | This violates `AGENTS.md` and `CLAUDE.md`, where the production database is off limits. Run the agent-operated script against EduEnroll-dev only and verify production through an approved application, admin, or CI/CD workflow. |
| Medium | The HitPay prerequisite is not yet written, but Task 5 depends on its exact code structure and `subdomain` variable. | Merge or rebase the prerequisite first, then revise Task 5 against the actual implementation. |
| Low | `npx tsx` is not currently available in the project. | Use the established command: `node --env-file=.env.local --experimental-strip-types scripts/verify-custom-domains.ts`, with relative `.ts` imports. |
| Low | The plan says a `307` can degrade a POST request to GET. | A `307` preserves the method and body. Returning `404` for platform APIs remains a reasonable surface policy, but the explanation should be corrected. |

## Release Blocker: Unknown-Host Middleware Fallback

Removing generic domain inference from `extractSubdomainFromHost()` is necessary but not sufficient.

The current middleware fallback is guarded by:

```typescript
if (!tenantSlug && !isRootDomain) {
  tenantSlug =
    request.nextUrl.searchParams.get("tenant") ??
    request.cookies.get("x-tenant-slug")?.value ??
    process.env.NEXT_PUBLIC_DEV_TENANT ??
    null;
}
```

Despite the comment describing it as a localhost fallback, this condition applies to every unknown non-root hostname.

Consequently, a request such as:

```text
https://flashtic.evil.com/enroll?tenant=flashtic
```

can still acquire the `flashtic` tenant context after the canonical resolver returns `null`.

Vercel domain assignment offers external protection, but V3 explicitly aims to make the application itself an allowlist. The middleware fallback must follow the same rule.

### Recommended correction

```typescript
const isLocalDevHost =
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);

if (
  !tenantSlug &&
  process.env.NODE_ENV !== "production" &&
  isLocalDevHost
) {
  tenantSlug =
    request.nextUrl.searchParams.get("tenant") ??
    request.cookies.get("x-tenant-slug")?.value ??
    process.env.NEXT_PUBLIC_DEV_TENANT ??
    null;
}
```

### Required regression tests

For an unknown production host, verify that none of the following can establish tenant context:

- `?tenant=flashtic`
- An `x-tenant-slug` request header
- An existing `x-tenant-slug` cookie
- `NEXT_PUBLIC_DEV_TENANT`

Also verify that the same development conveniences continue to work on:

- `localhost`
- `tenant.localhost`
- The approved LAN development host pattern

## Preflight Parser Design Problem

Task 6 requires the preflight to:

1. Use the exact same parser as runtime.
2. Report every rejected entry and its reason.
3. Query each surviving tenant slug.

The proposed runtime implementation exposes only:

```typescript
export function tenantForCustomHost(host: string): string | null;
```

Its internal `domainMap()` is private and retains only a dropped-entry count. The preflight cannot both reuse this function and report rejection reasons.

### Recommended parser structure

```typescript
export interface DomainMapIssue {
  entry: number;
  reason: string;
}

export interface ParsedTenantDomains {
  map: Map<string, string>;
  issues: DomainMapIssue[];
}

export function parseTenantCustomDomains(
  raw: string,
): ParsedTenantDomains {
  // The only implementation of parsing, normalization, validation,
  // reserved-host checks, and uniqueness checks.
}
```

The cached runtime function then delegates to it:

```typescript
function domainMap(): Map<string, string> {
  const raw = process.env.TENANT_CUSTOM_DOMAINS ?? "";
  if (raw === cachedRaw) return cachedMap;

  cachedRaw = raw;
  const { map, issues } = parseTenantCustomDomains(raw);

  if (issues.length > 0) {
    console.warn(
      `[tenant-domains] Ignored ${issues.length} invalid entries; ${map.size} active.`,
    );
  }

  cachedMap = map;
  return cachedMap;
}
```

The runtime warning should contain counts only. The local preflight may print sanitized entry names and rejection reasons because it is an explicit operator command.

## Production Database Rule Conflict

The V3 deployment checklist says to run the preflight against the production database. Project rules explicitly prohibit direct production database access:

```text
NEVER access production DB (Mumbai) directly
PROD DB ref: nhxmumcvgnxlczjsgctz — OFF LIMITS
```

The plan must not instruct an agent to run the script against production.

### Recommended workflow

1. Run parser and tenant-existence checks against EduEnroll-dev.
2. Verify the production tenant slug and school name through an approved existing production application or superadmin workflow.
3. Have a human review the intended `host -> slug -> school name` mapping before changing the Vercel environment.
4. If automated production validation is required, implement it through an approved CI/CD or internal application workflow rather than direct database access.

## Script Execution Command

The repository does not currently include `tsx`. Existing TypeScript operations scripts use Node's type-stripping support and relative `.ts` imports.

Use:

```bash
node --env-file=.env.local --experimental-strip-types scripts/verify-custom-domains.ts
```

The script should import the shared parser using a real relative path:

```typescript
import {
  parseTenantCustomDomains,
} from "../src/lib/tenant.ts";
```

It should not use the `@/` alias because plain Node does not resolve TypeScript path aliases.

## HitPay Prerequisite

Task 5 appropriately stops when the base HitPay allowlist has not been merged. However, the task assumes that the prerequisite will provide:

- `platformOrigin()` in the allowlist.
- `tenantOrigin(subdomain)` in the allowlist.
- A locally available `subdomain` value.
- Parsed-origin comparison rather than prefix matching.

Because that prerequisite is not yet implemented, Task 5 cannot be considered final. After the prerequisite lands:

1. Rebase the custom-domain branch.
2. Inspect the actual HitPay handler.
3. Update the test and patch instructions to match the merged implementation.
4. Verify a tampered redirect receives `400`.
5. Verify the configured custom origin is accepted only for its mapped tenant.

Alternatively, disable HitPay card payments for the initial custom-domain rollout.

## What V3 Now Gets Right

- Removes arbitrary three-part-domain tenant inference.
- Uses one canonical tenant resolver.
- Adds a stable `platformOrigin()` for machine callbacks.
- Separates platform-root and tenant-staff redirects.
- Tightens slug validation.
- Adds callback URL tests.
- Adds configuration preflight planning.
- Accounts for HitPay redirect security.
- Provides a safe payment-drain rollback process.
- Correctly makes ABank and HitPay fixes deployment prerequisites.
- Adds tests for bare IP addresses and malicious host suffixes.
- Preserves branded customer return URLs.
- Avoids request-path database queries in middleware.

## Prerequisite Status at Review Time

### ABank callback verification

- Pull request: `#163`
- Branch: `fix/abank-callback-verification`
- Base: `dev`
- State: open
- CI `Lint & Build`: passed
- Vercel checks: passed
- Recorded review decision: none

The current local branch contains the committed ABank verification work. V3 itself did not introduce additional tracked source-code changes.

### HitPay redirect allowlist

- Status in V3: not yet written
- Deployment remains blocked until it is reviewed, merged, and deployed, unless HitPay card payments are disabled for the initial rollout.

## Expected Impact

### Architecture impact

- Host resolution becomes explicit and allowlist-based.
- Middleware and server components use the same resolver.
- Unknown hosts stop receiving inferred tenant context.
- Machine callbacks become independent of tenant-controlled DNS.

### Runtime impact

- The custom-domain environment map is parsed lazily and cached.
- Invalid configuration produces a redacted count warning.
- `/` enters middleware but returns before the Supabase authentication request.
- Server layouts retain reliable host-based fallback resolution.

### Payment impact

- ABank and MMQR callbacks use `kuunyi.com` regardless of the student's domain.
- Stripe, PayPay, and HitPay customer returns remain branded.
- HitPay custom-domain returns depend on the prerequisite allowlist.
- Rollback can preserve provider settlement while custom-domain DNS drains.

### Operational impact

Each custom domain requires:

1. Parser validation.
2. Tenant mapping verification.
3. Vercel domain assignment.
4. Environment update and redeployment.
5. DNS configuration.
6. TLS provisioning.
7. Routing verification.
8. Provider-specific payment testing.

### Behavioral compatibility impact

Any existing domain that currently depends on the generic three-part-host fallback will stop resolving. V3 correctly requires checking the domains assigned to Vercel before removing that behavior.

## Required V3.1 Changes

1. Restrict tenant query, cookie, and development fallbacks to explicit development hosts outside production.
2. Add unknown-host middleware security tests.
3. Extract an exported parser returning both the validated map and structured issues.
4. Rewrite the preflight to consume that parser through a relative `.ts` import.
5. Replace `npx tsx` with the repository's established Node execution command.
6. Remove direct production database access from the deployment instructions.
7. Reconcile Task 5 after the HitPay prerequisite is merged.
8. Correct the explanation of `307` redirect behavior.

## Final Assessment

| Area | Assessment |
|---|---|
| Architecture | Approved |
| Canonical resolver | Approved |
| Host allowlist | Incomplete until middleware fallback is restricted |
| Middleware route coverage | Good |
| Configuration parser | Good runtime design, insufficient preflight interface |
| Payment callback origin | Good |
| ABank security prerequisite | Open PR; checks pass; review pending |
| HitPay security prerequisite | Not implemented |
| Production preflight | Conflicts with project rules |
| Rollback design | Good |
| Implementation readiness | Requires V3.1 corrections |
| Deployment readiness | Blocked by prerequisites |

## Recommendation

Approve V3's architecture, but revise the document before implementation.

The primary release blocker inside the custom-domain plan is the middleware fallback: changing the resolver to an allowlist does not make the complete request path an allowlist while unknown hosts can still receive tenant context from query parameters, cookies, or development configuration.

Deployment must also remain blocked until:

- ABank PR `#163` is reviewed, merged, and deployed.
- The HitPay allowlist is reviewed, merged, and deployed, or HitPay card payments are disabled.
- The production preflight procedure is changed to comply with the repository's database-access rules.

