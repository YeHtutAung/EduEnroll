# Tenant Custom Domains V3.1 Review

## Overall Verdict

V3.1 successfully addresses all major V3 review findings. The architecture is now implementation-ready after two small but important plan corrections.

Verification confirmed:

- Nine tasks are present.
- All 68 checklist items remain unchecked.
- No tracked files under `src/`, `scripts/`, or `package.json` were modified by V3.1.
- The current branch contains the separate committed ABank pull-request work.
- Only `.claude/settings.local.json` has an unrelated tracked working-tree modification.

## Findings

| Severity | Finding | Required correction |
|---|---|---|
| High | The plan treats inbound `x-tenant-slug` survival as conditional, but it survives because middleware initially copies every request header. | Explicitly remove it when an unknown non-root host fails tenant resolution. Keep the regression test. |
| High | The dev-only preflight relies on `.env.local` pointing to EduEnroll-dev but does not require the script to verify the project reference. | Before creating the admin client, fail unless the Supabase hostname contains the exact allowed dev ref `fnfvwzwrdsnmwxunciti`. |
| Medium | HitPay Task 6 is intentionally unimplementable until its prerequisite exists. | Keep deployment blocked, or remove Task 6 from the executable sequence until the prerequisite merges and the task is rewritten. |
| Low | `DomainMapIssue` contains only an entry number and reason. | Consider including a normalized hostname so the preflight can identify a rejected entry without reparsing JSON. |
| Low | Test environment restoration can leak `"undefined"` strings and `NEXT_PUBLIC_DEV_TENANT` between tests. | Save and restore all modified environment variables, using `delete` when the original value was absent. |

## Required Inbound Header Correction

The plan currently says to delete the inbound tenant header "if it can survive." It will survive because middleware begins with:

```typescript
const requestHeaders = new Headers(request.headers);
```

If tenant resolution and the approved development fallback both return `null`, the copied `x-tenant-slug` header remains in `requestHeaders` and is forwarded to server components and route handlers.

After resolution and the development fallback, add an explicit removal for unknown non-root hosts:

```typescript
if (!tenantSlug && !isRootDomain) {
  requestHeaders.delete("x-tenant-slug");
}

if (tenantSlug) {
  requestHeaders.set("x-tenant-slug", tenantSlug);
}
```

This preserves:

- Trusted tenant headers generated from configured custom domains.
- KuuNyi subdomain resolution.
- Preview and local development fallbacks.
- Existing root-domain behavior.

It removes attacker-supplied tenant context from unknown hosts.

### Required tests

For an unknown host in production, assert that no tenant request header is forwarded when tenant context is supplied through:

- `?tenant=flashtic`
- An inbound `x-tenant-slug` header
- An `x-tenant-slug` cookie
- `NEXT_PUBLIC_DEV_TENANT`

Also preserve tests for:

- `localhost`
- `tenant.localhost`
- Approved LAN development addresses
- Vercel preview deployments

## Required EduEnroll-Dev Guard

Task 7 correctly states that the preflight is restricted to EduEnroll-dev. That restriction must be enforced by code rather than relying on `.env.local` being configured correctly.

Before creating the service-role client:

```typescript
const DEV_PROJECT_REF = "fnfvwzwrdsnmwxunciti";
const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

if (!configuredUrl) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL is required.");
}

const hostname = new URL(configuredUrl).hostname;

if (hostname !== `${DEV_PROJECT_REF}.supabase.co`) {
  throw new Error(
    "Refusing to run: custom-domain preflight is restricted to EduEnroll-dev.",
  );
}
```

Only create the admin client after this check passes.

The script must never:

- Accept a project ref or connection string argument.
- Print `SUPABASE_SERVICE_ROLE_KEY`.
- Print environment-variable contents unnecessarily.
- Query the production or Rexiee projects.

## VERCEL_ENV Decision

Using `VERCEL_ENV` instead of `NODE_ENV` is justified because Vercel preview deployments run production builds while remaining distinct from the production environment.

The proposed guard:

```typescript
process.env.VERCEL_ENV !== "production"
```

preserves preview fallback behavior while disabling it for the production environment.

If custom Vercel environments are introduced later, each should be classified explicitly instead of assuming every non-production environment may use the development fallback.

## Shared Parser and Preflight

V3.1 correctly introduces one exported parser:

```typescript
export function parseTenantCustomDomains(
  raw: string,
): ParsedTenantDomains;
```

This resolves the V3 inconsistency where runtime and preflight could not share validation logic.

The parser now provides:

- A validated `Map<string, string>`.
- Structured rejection issues.
- Pure parsing without reading `process.env`.
- No request-path database access.
- Runtime logging limited to counts.

### Optional improvement

The current issue structure contains only:

```typescript
interface DomainMapIssue {
  entry: number;
  reason: string;
}
```

Consider including a normalized hostname:

```typescript
interface DomainMapIssue {
  entry: number;
  host?: string;
  reason: string;
}
```

Runtime code should continue logging only counts. The explicit local preflight may print sanitized hostnames and reasons to make configuration errors actionable.

## Script Execution

V3.1 correctly replaces unavailable `tsx` usage with the repository's established Node command:

```bash
node --env-file=.env.local --experimental-strip-types scripts/verify-custom-domains.ts
```

The script should use relative `.ts` imports:

```typescript
import {
  parseTenantCustomDomains,
} from "../src/lib/tenant.ts";

import {
  createAdminClient,
} from "../src/lib/supabase/admin.ts";
```

It should not use the `@/` alias because plain Node does not resolve TypeScript path aliases.

## HitPay Prerequisite

Task 6 appropriately acknowledges that its target code does not exist yet. However, an unimplementable provisional task should not be treated like the other executable tasks.

### Required sequence

1. Implement and review the base HitPay redirect allowlist.
2. Merge it into `dev`.
3. Rebase the custom-domain branch.
4. Inspect the actual merged handler and tenant-subdomain lookup.
5. Rewrite Task 6 against that implementation.
6. Add custom-origin acceptance and cross-tenant rejection tests.
7. Implement the rewritten task.

If the prerequisite is unavailable, deployment must remain blocked unless HitPay card payments are explicitly disabled through a concrete, tested mechanism.

Simply stating that card payments should be disabled is insufficient unless the plan specifies:

- The configuration or feature flag used to disable them.
- The UI behavior when cards are unavailable.
- An API-side rejection so bypassing the UI cannot create a card payment.
- A verification test.

## Test Environment Hygiene

Tests mutate several process environment variables:

- `VERCEL_ENV`
- `TENANT_CUSTOM_DOMAINS`
- `NEXT_PUBLIC_DEV_TENANT`
- `NEXT_PUBLIC_APP_URL`

Assigning `undefined` back to `process.env` can produce a string value rather than removing the variable. Use an explicit helper:

```typescript
function restoreEnv(
  key: string,
  original: string | undefined,
) {
  if (original === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = original;
  }
}
```

Restore every mutated variable in `afterEach()` to prevent order-dependent failures in the full test suite.

## What V3.1 Fixed

- Resolver and complete request path are now both allowlist-oriented.
- Unknown-host query, cookie, and development fallbacks are addressed.
- Vercel preview behavior is preserved.
- Shared parsing now supports runtime and preflight consumers.
- Production direct database access was removed.
- The established Node TypeScript script runner is used.
- Platform and tenant redirect targets are separated.
- `307` behavior is described correctly.
- Machine callbacks use stable platform origins.
- HitPay dependency uncertainty is explicitly acknowledged.
- Production mapping verification moves to the superadmin UI.
- Rollback includes a payment drain period.
- Invalid host and slug handling is testable through one pure parser.
- Unknown IP addresses no longer infer tenant slugs.

## Expected Impact

### Security impact

- Unknown hosts can no longer infer or request arbitrary tenant context.
- Custom domains remain pinned to their configured tenants.
- Machine callbacks remain independent of tenant-controlled DNS.
- Invalid mappings fail closed.
- Production database access remains prohibited.
- HitPay custom returns cannot ship before the base redirect allowlist exists.

### Runtime impact

- One cached canonical domain parser is used.
- Middleware adds root-route handling without a Supabase round trip.
- Preview deployments retain their development tenant fallback.
- Runtime warnings expose counts only, not configuration values.
- Server layouts retain reliable host-based fallback resolution.

### Operational impact

- The dev preflight validates parsing and dev tenant existence.
- A human validates the production slug and school name through superadmin.
- HitPay remains a deployment prerequisite unless card payments are explicitly disabled.
- Existing inferred arbitrary domains stop working and must be inventoried first.
- Each custom-domain addition requires a Vercel environment update and redeployment.

### Payment impact

- ABank and MMQR callbacks use the stable platform origin.
- Stripe, PayPay, and HitPay customer returns remain branded.
- HitPay custom-domain returns depend on the prerequisite allowlist.
- Rollback preserves machine callbacks while customer return URLs drain.

## Prerequisites

### ABank callback verification

- Pull request: `#163`
- Branch: `fix/abank-callback-verification`
- Base: `dev`
- State at review time: open
- CI `Lint & Build`: passed
- Vercel checks: passed
- Recorded review decision at review time: none

The current local branch contains this committed work. It is separate from the custom-domain plan.

### HitPay redirect allowlist

- Status in V3.1: not yet written
- Deployment remains blocked until it is reviewed, merged, and deployed, unless a complete server-enforced card-disable path is implemented.

## Required V3.2 Adjustments

1. Replace the conditional inbound-header note with explicit `requestHeaders.delete("x-tenant-slug")` behavior for unresolved unknown hosts.
2. Require the preflight script to validate the exact EduEnroll-dev project hostname before creating its admin client.
3. Restore all test environment variables using delete-aware cleanup.
4. Optionally add the normalized hostname to `DomainMapIssue`.
5. Rewrite the provisional HitPay task after its prerequisite merges, or define a concrete server-enforced card-disable task.

## Final Assessment

| Area | Result |
|---|---|
| Architecture | Approved |
| Resolver design | Approved |
| Middleware fallback | Approved after explicit header deletion |
| Parser/preflight interface | Approved |
| Dev-only database safety | Needs an enforced project-ref guard |
| Payment callback design | Approved |
| ABank security prerequisite | Separate open PR at review time |
| HitPay integration | Blocked on prerequisite |
| Production mapping verification | Compliant through manual superadmin check |
| Rollback design | Approved |
| Implementation readiness | Nearly ready |
| Deployment readiness | Blocked by prerequisites |

## Recommendation

Make the inbound-header deletion and exact EduEnroll-dev project guard explicit in the plan.

After those corrections:

- Tasks 1–5 and 7–9 are ready to execute.
- Task 6 must be rewritten after the HitPay prerequisite merges.
- Deployment must remain blocked until both payment-security prerequisites are satisfied or HitPay card payments are disabled through a concrete server-enforced mechanism.

