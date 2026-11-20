# Staff Password Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff (owner, staff, superadmin) can reach admin data only from a session created by a password sign-in, so turning on email-code sign-in for buyers can never open a staff account with just its inbox.

**Architecture:** The database is the main gate: `get_my_tenant_id()` and `get_my_role()` return NULL unless the JWT's `amr` claim shows a `password` sign-in, so every RLS policy built on them follows. The four policies that read `public.users` directly are rewritten to go through the same check. The app adds a second layer: `requireAuth`, `requireSuperadmin`, middleware and the admin and superadmin layouts refuse a session whose access token has no `password` method.

**Tech Stack:** Next.js 14 App Router, Supabase (Postgres RLS, GoTrue JWT `amr` claim), `@supabase/ssr`, Vitest (`npm test`, `npm run test:db`).

**Spec:** `docs/superpowers/specs/2026-11-20-account-bound-tickets-design.md`, section 4.4 ("Email codes and staff accounts") and section 12 step 3.

---

## Plan series

The spec is split into four plans. Each one ships and is tested on its own, in this order:

| # | Plan | Depends on | Status |
|---|---|---|---|
| 1 | **Staff password sessions** (this file) | nothing | ready |
| 2 | Buyer accounts: `buyer_profiles`, `requireBuyer`, email-code sign-in, Resend SMTP | Plan 1 merged; mobile spec + #451 updated to email; private advisories closed | written after its blockers clear |
| 3 | Ticket protection core: `intakes.ticket_protection`, `ticket_devices` + bind function, `k2` QR, `/api/scans` protected path | Plan 2; kuunyi-scanner sends `token` | after Plan 2 |
| 4 | Checkout, closing QR surfaces (web + mobile API), `/account` pages, admin controls, deletion | Plan 3 | after Plan 3 |

Plans 2–4 are not written yet on purpose: Plan 2's API shape depends on the mobile spec update that the app team still has to make.

---

## Before you start

- Work in a fresh worktree off `origin/dev` (global rule: branch from the remote ref):
  ```bash
  git fetch origin
  git worktree add ../EduEnroll-wt-staff-pw -b fix/staff-password-sessions origin/dev
  cd ../EduEnroll-wt-staff-pw
  git config user.email   # must print the personal address; stop otherwise
  npm ci                  # real install; do NOT junction node_modules into a worktree
  ```
- Never run `npm run build` while a dev server is running from the same folder (it corrupts `.next`).
- `next build` inside a nested worktree skips lint. Run `npm run lint` separately.
- Judge every command by its exit code, not by how the output reads.
- `npm run test:db` needs the local Supabase stack (`npx supabase start`). If ports 54321–54323 fail
  while containers look healthy, check Windows port exclusions (`netsh int ipv4 show excludedportrange tcp`).

## File map

| File | Responsibility |
|---|---|
| Create `src/lib/authMethod.ts` | Read the sign-in methods from an already-verified access token |
| Create `src/__tests__/lib/authMethod.test.ts` | Unit tests for it |
| Modify `src/lib/api.ts` (`requireAuth`, session path ~lines 153–206) | 403 for a non-password staff session |
| Create `src/__tests__/lib/require-auth-password.test.ts` | Cookie and Bearer paths, password vs code |
| Modify `src/lib/superadminAuth.ts` | 403 for a non-password session |
| Create `src/__tests__/lib/superadmin-auth-password.test.ts` | Tests for it |
| Modify `src/middleware.ts` (~lines 203–232) | `/login`, `/admin`, `/onboarding` treat a non-password session as signed out |
| Modify `src/__tests__/middleware.test.ts` | Configurable auth mock + new cases |
| Modify `src/app/admin/layout.tsx`, `src/app/superadmin/layout.tsx` | Redirect a non-password session to `/login` |
| Modify `src/app/api/auth/verify-tenant/route.ts` | 403 for a non-password session (it authorizes staff without `requireAuth`) |
| Create `supabase/migrations/20261120120000_staff_password_sessions.sql` | `is_password_session()`, helper functions, four policies |
| Create `supabase/rollbacks/20261120120000_staff_password_sessions.down.sql` | Exact restore of the previous definitions |
| Create `src/__tests__/db/staff-password-session.db.test.ts` | Helper results per `amr`, and policy wiring |

---

### Task 1: Confirm the `amr` claim shape on the local stack

The whole plan assumes Supabase access tokens carry `amr: [{ "method": "password", "timestamp": … }]`
after `signInWithPassword`, and `"otp"` after an email code. Confirm before writing code. Local only.
Never print a token.

**Files:** none (scratch script outside the repo)

- [ ] **Step 1: Start the local stack**

Run: `npx supabase start`
Expected: exit 0, prints the local API URL (`http://127.0.0.1:54321`) and keys.

- [ ] **Step 2: Create a throwaway user and print only the `amr` claim**

Write this to `tmp/amr-probe.mjs` **inside the worktree** (`tmp/` is gitignored; Node resolves
`@supabase/supabase-js` from the script's own folder, so a script outside the repo can't import it).
Run it with the local URL and keys from Step 1 exported as `LOCAL_URL`, `LOCAL_ANON_KEY`,
`LOCAL_SERVICE_KEY`. Staff live on refreshed tokens, so it checks a refreshed token too:

```js
import { createClient } from "@supabase/supabase-js";
const url = process.env.LOCAL_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) throw new Error("local stack only");
const admin = createClient(url, process.env.LOCAL_SERVICE_KEY, { auth: { persistSession: false } });
const email = `amr-probe-${Date.now()}@example.test`;
const password = crypto.randomUUID();
const { data: created, error: e1 } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (e1) throw e1;
const anon = createClient(url, process.env.LOCAL_ANON_KEY, { auth: { persistSession: false } });
const { data, error: e2 } = await anon.auth.signInWithPassword({ email, password });
if (e2) throw e2;
const amrOf = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).amr;
console.log("password sign-in amr:", JSON.stringify(amrOf(data.session.access_token)));
const { data: refreshed, error: e3 } = await anon.auth.refreshSession({ refresh_token: data.session.refresh_token });
if (e3) throw e3;
console.log("after refresh amr:   ", JSON.stringify(amrOf(refreshed.session.access_token)));
await admin.auth.admin.deleteUser(created.user.id);
```

Run: `node tmp/amr-probe.mjs` from the worktree root, then delete `tmp/amr-probe.mjs`.
Expected: both lines print `[{"method":"password","timestamp":<number>}]`.

- [ ] **Step 3: Record the result**

If the shape differs (for example plain strings `["password"]`), the helper in Task 2 already accepts
both. If there is no `amr` at all, or the refreshed token loses `password`, **stop and report**: the
plan's approach would lock every staff member out within an hour and needs a different signal.

The spec also requires confirming `amr` on the hosted dev project. That needs a real staff sign-in, so
it is an owner step (Task 9 step 1), done before the PR is merged.

---

### Task 2: `authMethod` helper

**Files:**
- Create: `src/lib/authMethod.ts`
- Test: `src/__tests__/lib/authMethod.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { isPasswordSession, sessionAuthMethods } from "@/lib/authMethod";

// Builds an unsigned token with the given payload. The helper only decodes;
// signature checking is getUser()'s job, done before this is ever called.
function token(payload: unknown): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}.sig`;
}

describe("sessionAuthMethods", () => {
  it("reads object-form amr entries", () => {
    expect(sessionAuthMethods(token({ amr: [{ method: "password", timestamp: 1 }] }))).toEqual(["password"]);
  });

  it("reads string-form amr entries", () => {
    expect(sessionAuthMethods(token({ amr: ["otp"] }))).toEqual(["otp"]);
  });

  it("returns [] for a missing amr, a non-array amr, or junk", () => {
    expect(sessionAuthMethods(token({ sub: "x" }))).toEqual([]);
    expect(sessionAuthMethods(token({ amr: "password" }))).toEqual([]);
    expect(sessionAuthMethods("not-a-jwt")).toEqual([]);
    expect(sessionAuthMethods("a.%%%.c")).toEqual([]);
    expect(sessionAuthMethods(null)).toEqual([]);
    expect(sessionAuthMethods(undefined)).toEqual([]);
  });

  it("decodes base64url payloads that need padding", () => {
    // A payload whose base64url length is not a multiple of 4.
    expect(sessionAuthMethods(token({ amr: [{ method: "password" }], x: "ab" }))).toEqual(["password"]);
  });
});

describe("isPasswordSession", () => {
  it("is true only when password is among the methods", () => {
    expect(isPasswordSession(token({ amr: [{ method: "password" }] }))).toBe(true);
    expect(isPasswordSession(token({ amr: [{ method: "otp" }, { method: "password" }] }))).toBe(true);
    expect(isPasswordSession(token({ amr: [{ method: "otp" }] }))).toBe(false);
    expect(isPasswordSession(token({ amr: [{ method: "magiclink" }] }))).toBe(false);
    expect(isPasswordSession(token({ amr: [{ method: "recovery" }] }))).toBe(false);
    expect(isPasswordSession(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/lib/authMethod.test.ts`
Expected: FAIL, cannot resolve `@/lib/authMethod`.

- [ ] **Step 3: Implement**

```ts
// ─── Which sign-in method produced a Supabase session ───────────────────────
//
// Supabase access tokens carry an `amr` claim, e.g.
//   [{ "method": "password", "timestamp": 1763600000 }]
// Staff must sign in with a password. Buyers will sign in with an email code,
// and email codes work for every account in the project, so a staff account
// opened with a code must not reach admin.
//
// DECODES ONLY. It never proves a token is genuine. Call it only with the
// access token of a session that supabase.auth.getUser() has just accepted.
// Uses atob (not Buffer) so it also runs in the middleware's edge runtime.

export function sessionAuthMethods(accessToken: string | null | undefined): string[] {
  if (!accessToken) return [];
  const parts = accessToken.split(".");
  if (parts.length !== 3) return [];
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { amr?: unknown };
    if (!Array.isArray(claims.amr)) return [];
    return claims.amr
      .map((m) => (m && typeof m === "object" ? (m as { method?: unknown }).method : m))
      .filter((m): m is string => typeof m === "string");
  } catch {
    return [];
  }
}

export function isPasswordSession(accessToken: string | null | undefined): boolean {
  return sessionAuthMethods(accessToken).includes("password");
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/__tests__/lib/authMethod.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/authMethod.ts src/__tests__/lib/authMethod.test.ts
git commit -m "feat(auth): read the sign-in method from a verified session token

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `requireAuth` refuses non-password staff sessions

**Files:**
- Modify: `src/lib/api.ts` (session path, after the agent branch)
- Test: `src/__tests__/lib/require-auth-password.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// ─── requireAuth session path: password sessions only ───────────────────────
// The agent path is covered in api-auth.test.ts; nothing here sends
// x-agent-signature.

function token(amr: unknown): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "HS256" })}.${enc({ sub: "u1", amr })}.sig`;
}
const PASSWORD = token([{ method: "password", timestamp: 1 }]);
const CODE = token([{ method: "otp", timestamp: 1 }]);

const headerMap = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: () => ({ get: (k: string) => headerMap.get(k.toLowerCase()) ?? null }),
}));

const profile = { id: "u1", tenant_id: "t1", role: "owner", email: "o@example.test" };
function profileQuery() {
  const q: Record<string, unknown> = {};
  q.select = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  q.single = vi.fn(async () => ({ data: profile, error: null }));
  return q;
}

const cookieClient = {
  auth: {
    getUser: vi.fn(),
    getSession: vi.fn(),
  },
  from: vi.fn(() => profileQuery()),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: () => cookieClient }));

const bearerClient = {
  auth: { getUser: vi.fn() },
  from: vi.fn(() => profileQuery()),
};
vi.mock("@supabase/supabase-js", () => ({ createClient: () => bearerClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { requireAuth } from "@/lib/api";

beforeEach(() => {
  vi.clearAllMocks();
  headerMap.clear();
  cookieClient.auth.getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
  bearerClient.auth.getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
});

describe("requireAuth — cookie session", () => {
  it("accepts a password session", async () => {
    cookieClient.auth.getSession.mockResolvedValue({ data: { session: { access_token: PASSWORD } } });
    const auth = await requireAuth();
    expect(auth).not.toBeInstanceOf(NextResponse);
  });

  it("returns 403 for an email-code session and never reads the profile", async () => {
    cookieClient.auth.getSession.mockResolvedValue({ data: { session: { access_token: CODE } } });
    const auth = await requireAuth();
    expect(auth).toBeInstanceOf(NextResponse);
    expect((auth as NextResponse).status).toBe(403);
    expect(cookieClient.from).not.toHaveBeenCalled();
  });

  it("returns 403 when no session token can be read", async () => {
    cookieClient.auth.getSession.mockResolvedValue({ data: { session: null } });
    const auth = await requireAuth();
    expect((auth as NextResponse).status).toBe(403);
  });

  it("still returns 401 when there is no user at all", async () => {
    cookieClient.auth.getUser.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
    const auth = await requireAuth();
    expect((auth as NextResponse).status).toBe(401);
  });
});

describe("requireAuth — Bearer token", () => {
  it("accepts a password token", async () => {
    headerMap.set("x-supabase-auth", `Bearer ${PASSWORD}`);
    const auth = await requireAuth();
    expect(auth).not.toBeInstanceOf(NextResponse);
  });

  it("returns 403 for an email-code token", async () => {
    headerMap.set("authorization", `Bearer ${CODE}`);
    const auth = await requireAuth();
    expect((auth as NextResponse).status).toBe(403);
    expect(bearerClient.from).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/lib/require-auth-password.test.ts`
Expected: FAIL. The three 403 cases (cookie code session, cookie with no token, Bearer code token)
get an AuthContext back, because no check exists yet.

- [ ] **Step 3: Implement**

In `src/lib/api.ts`, add the import next to the others:

```ts
import { isPasswordSession } from "@/lib/authMethod";
```

In the session branch of `requireAuth`, track the token. Replace the block from
`let supabase: SupabaseClient<Database>;` through the `if (!authUser) { … }` return with:

```ts
  let supabase: SupabaseClient<Database>;
  let authUser: { id: string } | null = null;
  let accessToken: string | null = null;

  if (authHeader?.startsWith("Bearer ")) {
    // Bearer token auth (API clients, CI) — create a client with the user's
    // token so RLS works correctly via auth.uid(). No service role key needed.
    const token = authHeader.substring(7);
    const tokenClient = createBareClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    const { data, error } = await tokenClient.auth.getUser(token);
    if (!error && data.user) {
      authUser = data.user;
      accessToken = token;
    }
    supabase = tokenClient;
  } else {
    // Cookie-based auth (browser)
    supabase = createClient();
    const { data, error } = await supabase.auth.getUser();
    if (!error && data.user) {
      authUser = data.user;
      // getUser() has just accepted this session, so its token is genuine.
      const { data: sessionData } = await supabase.auth.getSession();
      accessToken = sessionData.session?.access_token ?? null;
    }
  }

  if (!authUser) {
    return NextResponse.json(
      { error: "Unauthorized", message: "Valid session required." },
      { status: 401 },
    );
  }

  // Staff must sign in with a password. Email codes (for buyers) work for every
  // account in the project, so a code session must not open a staff account.
  // The database enforces the same rule (is_password_session()); this answers
  // early and clearly. Spec: account-bound tickets, section 4.4.
  if (!isPasswordSession(accessToken)) {
    return NextResponse.json(
      { error: "Forbidden", message: "Staff must sign in with a password." },
      { status: 403 },
    );
  }
```

- [ ] **Step 4: Run the new test and the existing auth tests**

Run: `npx vitest run src/__tests__/lib/require-auth-password.test.ts src/__tests__/lib/api-auth.test.ts`
Expected: PASS for both files. (`api-auth.test.ts` uses the agent path only and must be unaffected.)

- [ ] **Step 5: Run every API route test that goes through `requireAuth`**

Run: `npx vitest run src/__tests__/api`
Expected: PASS. If a route test fails because its mocked cookie client has no `auth.getSession`,
add `getSession: async () => ({ data: { session: { access_token: <password token> } } })` to that
test's mock using the same `token([{ method: "password" }])` helper. Do not weaken the check.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/__tests__/lib/require-auth-password.test.ts src/__tests__/api
git commit -m "fix(auth): requireAuth accepts only password staff sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `requireSuperadmin` refuses non-password sessions

**Files:**
- Modify: `src/lib/superadminAuth.ts`
- Test: `src/__tests__/lib/superadmin-auth-password.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

function token(amr: unknown): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "HS256" })}.${enc({ sub: "s1", amr })}.sig`;
}

const client = {
  auth: { getUser: vi.fn(), getSession: vi.fn() },
  from: vi.fn(() => {
    const q: Record<string, unknown> = {};
    q.select = vi.fn(() => q);
    q.eq = vi.fn(() => q);
    q.single = vi.fn(async () => ({ data: { id: "s1", role: "superadmin" }, error: null }));
    return q;
  }),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: () => client }));

import { requireSuperadmin } from "@/lib/superadminAuth";

beforeEach(() => {
  vi.clearAllMocks();
  client.auth.getUser.mockResolvedValue({ data: { user: { id: "s1" } } });
});

describe("requireSuperadmin", () => {
  it("accepts a superadmin password session", async () => {
    client.auth.getSession.mockResolvedValue({
      data: { session: { access_token: token([{ method: "password" }]) } },
    });
    const auth = await requireSuperadmin();
    expect("profile" in auth).toBe(true);
  });

  it("returns 403 for an email-code session without reading the profile", async () => {
    client.auth.getSession.mockResolvedValue({
      data: { session: { access_token: token([{ method: "otp" }]) } },
    });
    const auth = await requireSuperadmin();
    expect("error" in auth && auth.error.status).toBe(403);
    expect(client.from).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/lib/superadmin-auth-password.test.ts`
Expected: FAIL on the 403 case.

- [ ] **Step 3: Implement**

In `src/lib/superadminAuth.ts`, add the import and the check right after the `if (!user)` block:

```ts
import { isPasswordSession } from "@/lib/authMethod";
```

```ts
  // Password sign-ins only; see src/lib/authMethod.ts.
  const { data: sessionData } = await supabase.auth.getSession();
  if (!isPasswordSession(sessionData.session?.access_token)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/__tests__/lib/superadmin-auth-password.test.ts`
Expected: PASS, 2 tests. Then run `npx vitest run src/__tests__/api/superadmin` (if the folder
exists) and fix any mock missing `getSession` as in Task 3 Step 5.

- [ ] **Step 5: Commit**

```bash
git add src/lib/superadminAuth.ts src/__tests__/lib/superadmin-auth-password.test.ts src/__tests__/api
git commit -m "fix(auth): requireSuperadmin accepts only password sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Middleware treats a non-password session as signed out for staff pages

**Files:**
- Modify: `src/middleware.ts` (the block after `await supabase.auth.getUser()`)
- Modify: `src/__tests__/middleware.test.ts`

- [ ] **Step 1: Make the existing auth mock configurable**

At the top of `src/__tests__/middleware.test.ts`, replace the `vi.mock("@supabase/ssr", …)` block
with:

```ts
// Middleware calls Supabase auth.getUser() and, for a signed-in user,
// auth.getSession(). Stub both so these stay offline and deterministic.
// Default: signed out. Tests that need a session set authState and the
// afterEach below resets it.
const authState = vi.hoisted(() => ({
  user: null as null | { id: string },
  accessToken: null as string | null,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: authState.user } }),
      getSession: async () => ({
        data: { session: authState.accessToken ? { access_token: authState.accessToken } : null },
      }),
    },
  }),
}));
```

and extend the existing `afterEach`:

```ts
afterEach(() => {
  for (const k of ENV_KEYS) restoreEnv(k);
  authState.user = null;
  authState.accessToken = null;
});
```

Run: `npx vitest run src/__tests__/middleware.test.ts`
Expected: PASS (no behaviour change yet; this proves the mock refactor is neutral).

- [ ] **Step 2: Write the failing tests**

Append to `src/__tests__/middleware.test.ts`:

```ts
// ─── Staff pages need a password session (account-bound tickets spec §4.4) ───
describe("middleware — staff pages need a password session", () => {
  function sessionToken(method: string): string {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    return `${enc({ alg: "HS256" })}.${enc({ sub: "u1", amr: [{ method, timestamp: 1 }] })}.sig`;
  }
  function signIn(method: string) {
    authState.user = { id: "u1" };
    authState.accessToken = sessionToken(method);
  }
  function devGet(path: string) {
    process.env.NEXT_PUBLIC_DEV_TENANT = "nihon-moment";
    return middleware(middlewareRequest(`http://localhost:3005${path}`));
  }
  const location = (res: Response) => res.headers.get("location");

  it("lets a password session into /admin", async () => {
    signIn("password");
    const res = await devGet("/admin/dashboard");
    expect(location(res)).toBeNull();
  });

  it("sends an email-code session from /admin to /login", async () => {
    signIn("otp");
    const res = await devGet("/admin/dashboard");
    expect(location(res)).toContain("/login");
  });

  it("redirects a password session away from /login", async () => {
    signIn("password");
    const res = await devGet("/login");
    expect(location(res)).toContain("/admin/dashboard");
  });

  it("leaves an email-code session on /login so the person can sign in with a password", async () => {
    signIn("otp");
    const res = await devGet("/login");
    expect(location(res)).toBeNull();
  });

  it("sends an email-code session from /onboarding to /login", async () => {
    signIn("otp");
    const res = await devGet("/onboarding");
    expect(location(res)).toContain("/login");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/__tests__/middleware.test.ts -t "password session"`
Expected: FAIL on the three email-code cases ("sends … to /login", "leaves … on /login", onboarding).

- [ ] **Step 4: Implement**

In `src/middleware.ts`, add the import with the others:

```ts
import { isPasswordSession } from "@/lib/authMethod";
```

Directly after

```ts
  const {
    data: { user },
  } = await supabase.auth.getUser();
```

add:

```ts
  // Staff pages need a password sign-in. Email codes (buyer sign-in) work for
  // every account, so a code session is "signed out" as far as staff pages go.
  // getUser() above has verified the session; getSession() only hands us its
  // token to read the sign-in method. Spec: account-bound tickets, §4.4.
  let staffSession = false;
  if (user) {
    const { data: sessionData } = await supabase.auth.getSession();
    staffSession = isPasswordSession(sessionData.session?.access_token);
  }
```

Then change exactly three conditions:

- `if (user && pathname === "/login") {` → `if (staffSession && pathname === "/login") {`
- `if (!user && pathname.startsWith("/admin")) {` → `if (!staffSession && pathname.startsWith("/admin")) {`
- `if (!user && pathname.startsWith("/onboarding")) {` → `if (!staffSession && pathname.startsWith("/onboarding")) {`

- [ ] **Step 5: Run the whole middleware suite**

Run: `npx vitest run src/__tests__/middleware.test.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 6: Commit**

```bash
git add src/middleware.ts src/__tests__/middleware.test.ts
git commit -m "fix(auth): staff pages treat a non-password session as signed out

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Admin and superadmin layouts

Server components; there is no unit harness for them in this repo. They are covered by the
database rule (Task 7) and the staging check (Task 9).

**Files:**
- Modify: `src/app/admin/layout.tsx`
- Modify: `src/app/superadmin/layout.tsx`

- [ ] **Step 1: Admin layout**

Add `import { isPasswordSession } from "@/lib/authMethod";` and, directly after
`if (!user) { redirect("/login"); }`:

```ts
  // Password sign-ins only; see src/lib/authMethod.ts.
  const { data: sessionData } = await supabase.auth.getSession();
  if (!isPasswordSession(sessionData.session?.access_token)) {
    redirect("/login");
  }
```

- [ ] **Step 2: Superadmin layout**

Same import and the same block, directly after its `if (!user) { redirect("/login"); }`.

- [ ] **Step 3: `GET /api/auth/verify-tenant`**

`src/app/api/auth/verify-tenant/route.ts` authorizes staff without `requireAuth`. The database rule
already makes its `users` read come back empty for a code session; add the same app-level check so
this layer is complete. Add the import and, directly after its `if (authError || !user) { … }`
block:

```ts
  // Password sign-ins only; see src/lib/authMethod.ts.
  const { data: sessionData } = await supabase.auth.getSession();
  if (!isPasswordSession(sessionData.session?.access_token)) {
    return NextResponse.json(
      { error: "Forbidden", message: "Staff must sign in with a password." },
      { status: 403 },
    );
  }
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/layout.tsx src/app/superadmin/layout.tsx src/app/api/auth/verify-tenant/route.ts
git commit -m "fix(auth): admin layouts and verify-tenant require a password session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Database rule — staff helpers only for password sessions

**Files:**
- Create: `supabase/migrations/20261120120000_staff_password_sessions.sql`
- Create: `supabase/rollbacks/20261120120000_staff_password_sessions.down.sql`
- Test: `src/__tests__/db/staff-password-session.db.test.ts`

Before writing: run `ls supabase/migrations | tail -3` and make sure `20261120120000` is later
than the newest file on `origin/dev`. If not, use a later timestamp everywhere below.

- [ ] **Step 1: Write the failing DB test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, Client } from "pg";
import { randomUUID } from "crypto";

// ─── Staff helpers answer only for password sessions ─────────────────────────
// get_my_tenant_id() and get_my_role() back almost every staff RLS policy.
// They must return NULL unless the JWT's amr shows a password sign-in, so an
// email-code session (buyer sign-in, project-wide) never opens staff data.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

const userId = randomUUID();
let tenantId = "";

beforeAll(async () => {
  await sql(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [userId, `pw-${userId}@example.test`]);
  const [t] = await sql<{ id: string }>(
    `INSERT INTO public.tenants (name, subdomain) VALUES ('PW probe', $1) RETURNING id`,
    [`pw-${Date.now()}`],
  );
  tenantId = t.id;
  await sql(
    `INSERT INTO public.users (id, tenant_id, email, role) VALUES ($1, $2, $3, 'owner')`,
    [userId, tenantId, `pw-${userId}@example.test`],
  );
});

afterAll(async () => {
  await sql(`DELETE FROM public.users WHERE id = $1`, [userId]);
  await sql(`DELETE FROM public.tenants WHERE id = $1`, [tenantId]);
  await sql(`DELETE FROM auth.users WHERE id = $1`, [userId]);
  await pool.end();
});

async function asUser(claims: Record<string, unknown>) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: "authenticated", ...claims }),
    ]);
    const { rows } = await client.query(
      `SELECT public.get_my_tenant_id() AS tenant, public.get_my_role()::text AS role`,
    );
    return rows[0] as { tenant: string | null; role: string | null };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

describe("staff helpers and sign-in method", () => {
  it("answer for a password session (object form)", async () => {
    expect(await asUser({ amr: [{ method: "password", timestamp: 1 }] })).toEqual({
      tenant: tenantId,
      role: "owner",
    });
  });

  it("answer for a password session (string form)", async () => {
    expect((await asUser({ amr: ["password"] })).tenant).toBe(tenantId);
  });

  it.each([
    ["an email code", { amr: [{ method: "otp", timestamp: 1 }] }],
    ["a magic link", { amr: [{ method: "magiclink", timestamp: 1 }] }],
    ["no amr", {}],
  ])("return NULL for %s", async (_label, claims) => {
    expect(await asUser(claims)).toEqual({ tenant: null, role: null });
  });

  it("every staff policy that used to read users directly now goes through the rule", async () => {
    const policies = await sql<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }>(
      `SELECT tablename, policyname, qual, with_check FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('class_channels', 'intake_form_fields')
          AND policyname <> 'intake_form_fields_public_read'`,
    );
    expect(policies.length).toBe(5);
    for (const p of policies) {
      const text = `${p.qual ?? ""} ${p.with_check ?? ""}`;
      expect(text, `${p.tablename}.${p.policyname}`).toMatch(/get_my_tenant_id|is_password_session/);
      if (p.tablename === "class_channels") {
        // No direct users lookup left beside the helper.
        expect(text, `${p.tablename}.${p.policyname}`).not.toMatch(/FROM\s+(public\.)?users/i);
      }
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:db -- src/__tests__/db/staff-password-session.db.test.ts` against the local stack
as it is (no new migration yet).
Expected: FAIL. The "return NULL" cases get the tenant back, and the policy test finds direct
`users` lookups.

- [ ] **Step 3: Write the migration**

`supabase/migrations/20261120120000_staff_password_sessions.sql`:

```sql
-- ─── Staff database access only from a password sign-in ─────────────────────
-- Buyers will sign in with an email code (account-bound tickets spec §4.1).
-- Email codes work for every account in the project, staff included, so the
-- staff helpers must not answer for a session that was not a password sign-in.
-- Supabase puts the sign-in method in the JWT's amr claim, normally
-- [{"method":"password","timestamp":…}]; the plain-string form is accepted too.

CREATE OR REPLACE FUNCTION public.is_password_session()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(
    (auth.jwt() -> 'amr') @> '[{"method":"password"}]'::jsonb
    OR (auth.jwt() -> 'amr') @> '["password"]'::jsonb,
    false
  );
$$;

-- Called directly by intake_form_fields_manage (no TO clause), so every API
-- role runs it with its own rights. Grant explicitly rather than rely on
-- default privileges.
GRANT EXECUTE ON FUNCTION public.is_password_session() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_my_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id
  FROM   public.users
  WHERE  id = auth.uid()
    AND  public.is_password_session()
  LIMIT  1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM   public.users
  WHERE  id = auth.uid()
    AND  public.is_password_session()
  LIMIT  1;
$$;

-- These four read public.users directly instead of using the helpers.
DROP POLICY IF EXISTS "class_channels_select" ON public.class_channels;
DROP POLICY IF EXISTS "class_channels_insert" ON public.class_channels;
DROP POLICY IF EXISTS "class_channels_update" ON public.class_channels;
DROP POLICY IF EXISTS "class_channels_delete" ON public.class_channels;

CREATE POLICY "class_channels_select" ON public.class_channels
  FOR SELECT USING (tenant_id = public.get_my_tenant_id());
CREATE POLICY "class_channels_insert" ON public.class_channels
  FOR INSERT WITH CHECK (tenant_id = public.get_my_tenant_id());
CREATE POLICY "class_channels_update" ON public.class_channels
  FOR UPDATE USING (tenant_id = public.get_my_tenant_id());
CREATE POLICY "class_channels_delete" ON public.class_channels
  FOR DELETE USING (tenant_id = public.get_my_tenant_id());

DROP POLICY IF EXISTS "intake_form_fields_manage" ON public.intake_form_fields;
CREATE POLICY "intake_form_fields_manage"
  ON public.intake_form_fields FOR ALL
  USING (
    public.is_password_session()
    AND EXISTS (
      SELECT 1 FROM public.intakes i
      JOIN public.tenants t ON t.id = i.tenant_id
      JOIN public.users u ON u.tenant_id = t.id
      WHERE i.id = intake_form_fields.intake_id
        AND u.id = auth.uid()
        AND u.role IN ('owner', 'staff')
    )
  )
  WITH CHECK (
    public.is_password_session()
    AND EXISTS (
      SELECT 1 FROM public.intakes i
      JOIN public.tenants t ON t.id = i.tenant_id
      JOIN public.users u ON u.tenant_id = t.id
      WHERE i.id = intake_form_fields.intake_id
        AND u.id = auth.uid()
        AND u.role IN ('owner', 'staff')
    )
  );
```

Note: `users_select` / `users_update` keep `OR id = auth.uid()`, but they are ANDed with
`tenant_id = public.get_my_tenant_id()`, which is now NULL for a code session, so they deny too.

- [ ] **Step 4: Write the rollback**

`supabase/rollbacks/20261120120000_staff_password_sessions.down.sql` — restores the definitions from
`000_combined_schema.sql`, `015_staff_policies.sql`, `022_fix_form_fields_rls.sql` and
`060_class_channels.sql` exactly:

```sql
-- Run by hand only (see MIGRATIONS.md). Restores the pre-20261120120000 state.

CREATE OR REPLACE FUNCTION public.get_my_tenant_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id FROM public.users WHERE id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS user_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM public.users WHERE id = auth.uid() LIMIT 1;
$$;

DROP POLICY IF EXISTS "class_channels_select" ON public.class_channels;
DROP POLICY IF EXISTS "class_channels_insert" ON public.class_channels;
DROP POLICY IF EXISTS "class_channels_update" ON public.class_channels;
DROP POLICY IF EXISTS "class_channels_delete" ON public.class_channels;
CREATE POLICY "class_channels_select" ON public.class_channels
  FOR SELECT USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));
CREATE POLICY "class_channels_insert" ON public.class_channels
  FOR INSERT WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));
CREATE POLICY "class_channels_update" ON public.class_channels
  FOR UPDATE USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));
CREATE POLICY "class_channels_delete" ON public.class_channels
  FOR DELETE USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

DROP POLICY IF EXISTS "intake_form_fields_manage" ON public.intake_form_fields;
CREATE POLICY "intake_form_fields_manage"
  ON public.intake_form_fields FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM intakes i
      JOIN tenants t ON t.id = i.tenant_id
      JOIN users u ON u.tenant_id = t.id
      WHERE i.id = intake_form_fields.intake_id
        AND u.id = auth.uid()
        AND u.role IN ('owner', 'staff')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM intakes i
      JOIN tenants t ON t.id = i.tenant_id
      JOIN users u ON u.tenant_id = t.id
      WHERE i.id = intake_form_fields.intake_id
        AND u.id = auth.uid()
        AND u.role IN ('owner', 'staff')
    )
  );

DROP FUNCTION IF EXISTS public.is_password_session();
```

- [ ] **Step 5: Apply locally and run the DB test**

Run: `npx supabase migration up --local` (applies only pending migrations to the local stack; do
**not** use `db reset`, which CLAUDE.md forbids without the owner's explicit confirmation), then
`npm run test:db -- src/__tests__/db/staff-password-session.db.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the whole DB suite**

Run: `npm run test:db`
Expected: PASS. Any DB test that sets `request.jwt.claims` for a staff user without `amr` will now
fail: add `amr: [{ method: "password", timestamp: 1 }]` to its claims (that is what a real staff
session carries). Do not loosen the helper.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20261120120000_staff_password_sessions.sql \
        supabase/rollbacks/20261120120000_staff_password_sessions.down.sql \
        src/__tests__/db/staff-password-session.db.test.ts src/__tests__/db
git commit -m "fix(db): staff helpers and policies only for password sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification and PR

- [ ] **Step 1: Look for any other session source**

Run: `git grep -n "signInWithOtp\|signInWithIdToken\|signInWithOAuth\|setSession\|exchangeCodeForSession\|verifyOtp" -- src`
Expected: no matches outside tests (staff only sign in with `signInWithPassword` today). Any match
means a staff path this plan doesn't cover: stop and report it.

- [ ] **Step 2: Full checks, judged by exit code**

Run each, one at a time, with no dev server running:
- `npm test` → exit 0
- `npx tsc --noEmit` → exit 0
- `npm run lint` → exit 0
- `npm run build` → exit 0

- [ ] **Step 3: Review the diff**

Run: `git status` and `git diff origin/dev --stat`, then read `git diff origin/dev`.
Expected: only the files in the file map, `src/app/api/auth/verify-tenant/route.ts` (Task 6), plus
any test mocks updated in Tasks 3, 4 and 7.

- [ ] **Step 4: Push the branch and open a PR into `dev`**

```bash
git fetch origin
git rebase origin/dev
git push -u origin fix/staff-password-sessions
gh pr create --base dev --title "fix(auth): staff access only from password sign-ins" --body-file <body file>
```

The PR body must not describe how to exploit anything (public repo). Say what changed and why in
terms of the coming buyer email sign-in, list the migration, and include the human steps from
Task 9. End it with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

### Task 9: Human steps (owner) — after review, not by the implementer

1. **Required, before merging.** Confirm `amr` on the hosted project (spec §4.4). Sign in to the
   staging admin with your staff password, wait more than an hour (so the token has refreshed), then
   in that tab's browser console decode **only** the `amr` of your own token and confirm it lists
   `password`. Don't paste or share the token itself. If `password` is missing, stop: merging would
   lock staff out.
2. **Required.** Before merging, read the migration SQL in the PR. On the dev project, run this
   read-only query and confirm the current helper bodies still match what the rollback restores:
   ```sql
   select pg_get_functiondef('public.get_my_tenant_id()'::regprocedure);
   select pg_get_functiondef('public.get_my_role()'::regprocedure);
   ```
3. **Required.** Apply the migration to the dev project (which staging also reads) per
   `MIGRATIONS.md`, with `db push --dry-run` first.
4. **Required.** Staging check, signed in with a staff password: admin dashboard, an intake's form
   fields page, class channels, **uploading a class or intake image** (the browser writes straight
   to storage, whose policies go through `get_my_tenant_id()`), settings (including password
   change), guide, and the superadmin area all still work. A failure here means a staff path reads
   data with a non-password token: report it before going further.
5. **Required before production.** The migration goes to production **before** the code, as part of
   the normal staging → main promotion.
6. **Optional.** In the Supabase dashboard (Authentication → Providers → Email), note whether email
   code / magic-link sign-in is currently enabled on dev and production. This plan makes it safe
   either way, but the answer tells you whether this fixes something that already exists or only
   prepares for Plan 2.

## Not covered by this plan

- Buyer sign-in itself, `requireBuyer`, and every ticket change (Plans 2–4).
- Client-side admin pages (`settings`, `guide`, `onboarding`) do their own `getUser()` reads in the
  browser. They are covered by the database rule, not by app code: a code session sees no rows.
