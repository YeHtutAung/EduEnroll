# Tenant Custom Domains V3.4 Review

## Overall Verdict

**V3.4 resolves the V3.3 policy and rollout findings, but it is not implementation-ready because the proposed middleware test harness does not model the request shape used by the real middleware.**

The live deployment instructions are now clean: P1, P2, and P3 are named separately, HitPay remains outside Tasks 1–8, `VERCEL_ENV` and `VERCEL_TARGET_ENV` are described correctly, the fallback claim is narrowed, and agent compatibility has a concrete assertion.

However, direct execution against the installed Next.js runtime confirmed that:

```text
new NextRequest(new Request("https://flashtic.com/enroll"))
  .headers.get("host") === null
```

The production middleware resolves tenants from `request.headers.get("host")`, not `request.nextUrl.hostname`. Therefore the plan's middleware tests do not currently exercise the hostnames in their URLs. Task 3 also runs the new test file before its imports and Supabase mock are introduced in Task 4.

Verified plan state:

- Eight numbered tasks.
- 69 unchecked items and zero checked items.
- No tracked implementation files under `src/`, `scripts/`, `package.json`, or `.env.local.example` were changed by V3.4.
- The plan and review directory remain untracked.

## Findings

| Severity | Finding | Impact | Required correction |
|---|---|---|---|
| **High** | Every proposed middleware helper constructs `NextRequest(new Request(url))` without explicitly setting `Host`. In the installed runtime, that request has no `host` header. | The middleware sees `host === ""`. Custom-domain, KuuNyi-subdomain, root-domain, preview-host, and LAN-host tests can fail or pass for the wrong reason. The suite does not prove production behavior. | Create one shared request factory that derives and sets the `host` header from the test URL while preserving caller headers. Use it in Tasks 3 and 4. |
| **High** | Task 3 creates and runs `src/__tests__/middleware.test.ts`, but its snippet has no imports and no `@supabase/ssr` mock. The required mock appears only in Task 4. | Task 3 cannot reliably reach its intended red/green assertions: it may fail to compile or fail inside `createServerClient()`/`auth.getUser()` before testing tenant fallback. | Move the complete imports, Supabase mock, environment setup, and request factory into Task 3 Step 1. Task 4 should append only its new test cases. |
| **Medium** | Task 4 introduces a second environment setup using `process.env.TENANT_CUSTOM_DOMAINS = original`. | If the original value is absent, this restores the string `"undefined"`, reintroducing the exact order-dependent leak fixed elsewhere in V3.4. It also duplicates Task 3's `afterEach`. | Delete Task 4's duplicate imports/setup and reuse Task 3's delete-aware `ENV_KEYS` restoration. |
| **Medium** | The live F2 section at line 1250 still says “It grants nothing today.” This is not only a revision-history quotation. | The statement contradicts V3.4's own accepted correction: a forged header selects tenant context for service-role-backed public routes, though no additional capability beyond the tenant subdomain was identified. | Replace the live F2 sentence with the narrower, evidence-backed wording from the V3.4 revision entry. |
| **Low** | F2 references `task_47d00374`, but no matching artifact exists in the repository and its ownership cannot be verified from this workspace. | The security debt could still be lost if that identifier belongs only to a temporary planning system. | Before merge, verify the task exists in the team's durable tracker and record its owner/link, not only an opaque identifier. |

## V3.3 Findings Recheck

| V3.3 finding | V3.4 result | Status |
|---|---|---|
| Deployment gate omitted P3 | Deployment now explicitly lists P1, P2, and P3 and warns that P2 alone breaks HitPay returns. | **Resolved** |
| Incorrect custom-environment description | `VERCEL_ENV` is restored to the three standard values; `VERCEL_TARGET_ENV` is identified for custom names. | **Resolved** |
| Task 3 claimed “ANY route” | Live test comments and group name are narrowed to query, cookie, and environment fallback. | **Resolved** |
| Agent check was non-executable prose | A temporary middleware regression assertion is provided and linked to F2. | **Partially resolved** — assertion is conceptually correct but currently uses the broken request factory. |
| F2 existed only inside the plan | An independent task identifier is recorded with a pre-merge durability requirement. | **Provisionally resolved** — tracker existence was not verifiable locally. |
| “It grants nothing today” was too absolute | Revision history accepts the correction, but the live F2 section retains the old sentence. | **Not fully resolved** |

## Required Test Harness Correction

Task 3 should create the complete test-file scaffold before any middleware test is run:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null } }),
    },
  }),
}));

const ENV_KEYS = [
  "VERCEL_ENV",
  "TENANT_CUSTOM_DOMAINS",
  "NEXT_PUBLIC_DEV_TENANT",
  "NEXT_PUBLIC_APP_URL",
] as const;

const ORIGINAL = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnv(key: (typeof ENV_KEYS)[number]) {
  const original = ORIGINAL[key];
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

afterEach(() => {
  for (const key of ENV_KEYS) restoreEnv(key);
});

function middlewareRequest(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(url).host);

  return new NextRequest(
    new Request(url, {
      ...init,
      headers,
    }),
  );
}
```

Then replace every occurrence of:

```typescript
new NextRequest(new Request(url, init))
```

with:

```typescript
middlewareRequest(url, init)
```

This is necessary because middleware currently reads:

```typescript
const host = request.headers.get("host") ?? "";
```

The URL hostname and the HTTP `Host` header are separate values in the unit-test runtime.

### Required assertions after the correction

The same helper should drive all of these cases:

| Request | Expected internal tenant header |
|---|---|
| `https://flashtic.com/enroll` | `flashtic` |
| `https://www.flashtic.com/enroll` | `flashtic` |
| `https://nihon-moment.kuunyi.com/enroll` | `nihon-moment` |
| Unknown production host plus `?tenant=` | `null` |
| Unknown production host plus tenant cookie | `null` |
| Localhost/LAN off production | configured development tenant |
| Preview `.vercel.app` host | configured preview tenant |
| Root-host agent request pending F2 | preserves current inbound tenant header |

For spoofing tests, the helper must overwrite any caller-provided `host` header with the hostname from the URL. Otherwise a test can accidentally evaluate a host different from the one named in its title.

## Live F2 Wording Correction

The following live sentence remains at line 1250:

```text
It grants nothing today: headers can only be set on one's own request...
```

Replace it with:

```text
No additional capability beyond the tenant's public subdomain was identified.
A forged header still selects tenant context for service-role-backed public
enrollment, status, bank-account, upload, and payment routes. The custom-domain
work neither creates nor widens that behavior, while fixing it requires a
coordinated agent-contract migration tracked in F2.
```

This preserves the legitimate scope decision without understating the trust-boundary effect.

## Security and Operational Impact

### What V3.4 gets right

- Configured custom domains are an explicit host-to-tenant allowlist.
- Unknown production hosts cannot use query, cookie, or environment development fallbacks.
- A configured custom domain overwrites a forged tenant header with its configured tenant.
- Staff, superadmin, onboarding, registration, and privileged API surfaces stay on platform-controlled domains.
- ABank and MMPay callbacks are pinned to the stable platform origin.
- HitPay deployment requires both the base redirect allowlist and the tenant custom-origin extension.
- The preflight refuses any Supabase hostname other than EduEnroll-dev before creating the admin client.
- Production tenant/domain ownership remains a manual superadmin check without direct production database access.

### Why the test defect matters to security

Host resolution is the primary security boundary in this feature. Tests that populate only `request.url` while production code reads `request.headers.host` do not test that boundary. A green suite under the current plan could therefore provide false confidence about:

- custom-host allowlisting;
- forged-header replacement;
- root-domain redirects;
- unknown-host fallback denial;
- separation of student and staff surfaces.

The payment architecture remains sound, but production DNS must stay blocked until the corrected host-aware tests pass and P1–P3 are all deployed.

## Impact Summary

| Area | V3.4 assessment |
|---|---|
| Resolver/parser design | Ready |
| Middleware implementation design | Ready |
| Middleware test design | **Blocked pending host-aware shared scaffold** |
| Agent compatibility decision | Acceptable temporary scope, pending durable F2 |
| Payment callback design | Ready |
| HitPay rollout | Correctly blocked on P2 and P3 |
| Preflight safety | Ready |
| Production deployment | Blocked on corrected tests and P1–P3 |

## Final Recommendation

**Revise the middleware test setup once more before implementation.**

V3.4's live operational instructions are substantially clean, and the underlying feature design is now strong. The remaining implementation blocker is concentrated in one test file: Task 3 must own a complete, offline, host-aware scaffold, and Task 4 must reuse it without duplicate environment restoration. After that correction—and replacement of the one stale live F2 sentence—the eight-task plan is ready to execute. Production rollout must still wait for P1, P2, and P3.
