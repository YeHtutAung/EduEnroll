# Buyer Accounts (Email-Code Sign-In) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A buyer can sign in on a tenant's website with a 6-digit email code and gets one `buyer_profiles` row, created by the single shared server function that the KuuNyi app's `POST /api/mobile/v1/me` will also use. Every Auth email goes through our own Send Email Hook, which enforces per-email limits.

**Architecture:** Email-code sign-in is Supabase Auth email OTP. Supabase calls our Send Email Hook (`POST /api/internal/auth/send-email`) for every Auth email. The hook checks the Standard Webhooks signature, counts against per-email caps in `mobile_rate_limits`, and sends through Resend. A profile is created only by `ensureBuyerProfile()`, which:
1. accepts only an email-code (`amr` `otp`) session;
2. takes a database claim;
3. resets the account's password to a random value and ends every other session;
4. inserts the profile.

`requireBuyer()` is the guard for every buyer route. It asks the Auth server (never a local JWT check), separates a real rejection (401) from an Auth outage (503), and refuses staff (403). The `/account` page is the web sign-in.

**Tech Stack:** Next.js 14 App Router, Supabase Auth (email OTP, Send Email Hook, Before User Created hook), Postgres (RLS, `SECURITY DEFINER` RPCs), `@supabase/ssr` + `@supabase/supabase-js`, Resend (`src/lib/email.ts`), Node `crypto`, Vitest (`npm test`, `npm run test:db`).

**Specs:**
- `docs/superpowers/specs/2026-11-20-account-bound-tickets-design.md`, sections 4.1–4.5 and 12 step 3 ("the design").
- The KuuNyi mobile backend spec, `kuunyi-app/docs/specs/eduenroll-mobile-backend.md` at Rexienomous/kuunyi-app#311 head `c1bc526` ("the mobile spec"): sections 4.1–4.5, 12 steps 1, 1a and the `buyer_profile_claims` part of step 2, and 14.

**Where they differ, the mobile spec wins.** It was reviewed later (KN-162). The one known case is email change: the design says `auth.updateUser({ email })` is blocked for buyers, but Supabase can't switch it off. This plan follows the mobile spec: "Secure email change" stays on, and an `auth.users` trigger keeps `buyer_profiles.email` equal to the auth email. Task 11 corrects the design.

---

## Plan series

| # | Plan | Depends on | Status |
|---|---|---|---|
| 1 | Staff password sessions (`2026-11-20-staff-password-sessions.md`) | nothing | **done**: #471 on dev, staging via #488; migration on the dev DB |
| 2 | **Buyer accounts** (this file) | Plan 1; mobile spec at #311 | ready |
| 3 | Ticket protection core: `intakes.ticket_protection`, `ticket_devices` + bind, `k2` QR, `/api/scans` protected path | Plan 2; kuunyi-scanner sends `token` | after Plan 2 |
| 4 | Protected checkout, closing QR surfaces (web + mobile API), `/account/tickets`, admin controls, deletion | Plan 3 | after Plan 3 |

**In this plan:**
- Tables: `buyer_profiles`, `buyer_profile_claims` and `mobile_rate_limits`.
- RPCs: the claim, create and rate-limit RPCs.
- The `auth.users` email-sync trigger.
- The Before User Created hook, if Task 1 shows it can work.
- The Send Email Hook route.
- The Auth-error classifier, `requireBuyer` and `ensureBuyerProfile`.
- The web profile route and the `/account` sign-in page.
- Example env hygiene: every value in `.env.local.example` is an obvious placeholder.

**Not in this plan:**
- Mobile `/api/mobile/v1/*` routes: #451, which reuses `requireBuyer` and `ensureBuyerProfile` from here.
- The App Review reviewer (`REVIEWER_EMAIL`, `is_reviewer` repair, demo tenant): waits on Q11 / KN-164.
- `requireBuyerForDeletion` and account deletion: Plan 4.
- `enrollments.buyer_id`: Plan 4, or #451 if it lands first.
- Removing web guest checkout (mobile spec Q9): a separate change.
- Anything on `main` or production. The owner froze releases to `main` on 2026-11-21.

**There is no separate "email codes" switch in Supabase.** Email OTP works whenever the Email provider is on, and it already is, for staff password sign-in. That is why Plan 1 had to come first. What buyers actually get is decided by two controls: the **Send Email Hook** (on means every Auth email is our 6-digit code email) and whether **`/account` is deployed**. Task 1 confirms this locally.

**Gates before the Send Email Hook is switched on in any Supabase project** (owner steps, Task 12):
1. Plan 1 is on that project. Dev: yes.
2. The open private security advisories that #451 lists as prerequisites are resolved and closed (details in the repository's Security tab, owner only).
3. The hook route is live on the deployment Supabase calls.
4. The project-wide "Rate limit for sending emails" is raised, if Task 1 shows it still applies with the hook on. Otherwise one shared hourly cap would block every buyer.

---

## Before you start

- Work in a fresh worktree off `origin/dev`:
  ```bash
  git fetch origin
  git worktree add ../EduEnroll-wt-buyer-accounts -b feat/buyer-accounts origin/dev
  cd ../EduEnroll-wt-buyer-accounts
  git config user.email   # must print the personal address; stop otherwise
  npm ci                  # real install; never junction node_modules into a worktree
  ```
- Never run `npm run build` while a dev server is running from the same folder (it corrupts `.next`).
- Never print, log or commit a key, token, password or sign-in code. Refer to secrets by name only.
- **The local stack is not faithful to hosted grants.** PostgREST answers 42501 on public tables locally. Use `pg` (as `src/__tests__/db/*` do) for database tests. Local results are not evidence about the dev project.
- Migrations: next free timestamp after `20261121130000`. Each migration gets a rollback in `supabase/rollbacks/<name>.down.sql`. Any hash guard on a function body must strip `chr(13)`.
- Buyer routes answer errors in the mobile spec's shape, `{ "error": { "code": "…", "message": "…" } }`, with codes `UNAUTHENTICATED`, `FORBIDDEN`, `CONFLICT`, `DELETION_IN_PROGRESS`, `VALIDATION`, `RATE_LIMITED` and `SERVER`.

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/20261122120000_buyer_accounts.sql` | Tables, RPCs, trigger, grants |
| `supabase/rollbacks/20261122120000_buyer_accounts.down.sql` | Exact reverse |
| `supabase/migrations/20261122120100_before_user_created_hook.sql` | Only if Task 1 says the hook can tell the cases apart |
| `src/lib/authMethod.ts` (modify) | Add `tokenClaim()` and `isEmailCodeSession()` |
| `src/lib/buyers/authErrors.ts` | `classifyAuthError()`: rejected vs unavailable |
| `src/lib/buyers/errors.ts` | `buyerError(status, code, message)` → `NextResponse` |
| `src/lib/buyers/requireBuyer.ts` | `requireBuyer()` |
| `src/lib/api.ts` (modify) | Re-export `requireBuyer` (the mobile spec names `src/lib/api.ts`) |
| `src/server/buyers/adminClient.ts` | Service-role client whose every request aborts after 5 s |
| `src/server/buyers/ensureBuyerProfile.ts` | The one place that creates a profile |
| `src/app/api/account/profile/route.ts` | Web: `GET` (current buyer) and `POST` (ensure profile) |
| `src/lib/auth/standardWebhook.ts` | Verifies Supabase's hook signature |
| `src/lib/auth/authEmailCopy.ts` | Bilingual Auth email subjects and bodies |
| `src/lib/auth/authEmailLimits.ts` | Type groups, caps, HMAC keys |
| `src/app/api/internal/auth/send-email/route.ts` | The Send Email Hook |
| `src/app/(public)/account/page.tsx` + `AccountSignIn.tsx` | Web sign-in, signed-in view, sign-out |
| `src/middleware.ts` (modify) | Add `/account` to the matcher so the session refreshes |
| `src/types/database.ts` (modify) | Types for the new tables and RPCs |
| `supabase/config.toml` (modify) | Local: confirmations on, 10-minute codes, hook settings |
| `.env.local.example` (modify) | Placeholders only; new secret names as placeholders |

---

### Task 1: Spike — confirm Auth behaviour on the local stack

Decisions later in this plan depend on facts that aren't documented well enough to trust. Find them out locally, write them into this plan's **Findings** section (at the end), and commit that change alone. Don't build anything else in this task.

**Files:**
- Modify: `docs/superpowers/plans/2026-11-21-buyer-accounts.md` (Findings section)
- Scratch only, not committed: a throwaway route or script under the scratch folder

- [ ] **Step 1: Start the local stack with email confirmations on, the hook OFF**

  Edit `supabase/config.toml` in place (Step 6 restores it):
  - `[auth.email] enable_confirmations = true`, `otp_expiry = 600`;
  - `[auth.rate_limit] email_sent = 100`. The committed value is 2 per hour, and this task needs about 10 emails.

  Then run `npx supabase stop && npx supabase start`. With the hook off, local Auth emails land in the local mail catcher (Inbucket/Mailpit; `npx supabase status` prints its URL). Use only throwaway `@example.test` addresses.

  To get 6-digit codes rather than links, set the local magic-link and confirmation templates to show `{{ .Token }}` (`[auth.email.template.magic_link]` and `[auth.email.template.confirmation]` with a scratch HTML file). That is local only and not committed.

- [ ] **Step 2: Record the `amr` of a first-ever email-code session**

  Call `signInWithOtp({ email: "<new address>@example.test" })` with the anon key, read the 6-digit code in the mail catcher, and call `verifyOtp({ email, token, type: "email" })`. Decode the access token's `amr` with `sessionAuthMethods()`. Print only the method names, never the token.

  Expected: `["otp"]`. If it is anything else, **stop and report**: `ensureBuyerProfile`'s first rule depends on it.

  Also confirm there is no separate "email codes" setting: with the Email provider on, `signInWithOtp` already works. That fact is behind the gate wording at the top of this plan.

- [ ] **Step 2b: Switch the capture hook on for Step 3 only**

  Enable `[auth.hook.send_email]` pointing at a throwaway route in the dev server. The route logs only `Object.keys(body)`, `Object.keys(body.email_data)`, `email_data.email_action_type`, and the **length** of `email_data.token` / `token_new`; it answers `{}`. Keep the hook config's secret in a gitignored `supabase/.env`, in `v1,whsec_<base64>` form, generated with `node -e "console.log('v1,whsec_'+require('crypto').randomBytes(32).toString('base64'))"`, and never print it. Restart the stack.

  Record whether the project-wide `email_sent` limit still applies with the hook on. Set it back to 2, send 3 codes and see whether the third is refused. If it applies, the owner must raise it on the dev project (Task 12).

- [ ] **Step 3: Record which `email_action_type` each call produces**

  | Call | Type recorded |
  |---|---|
  | `signInWithOtp` for a new email | |
  | `signInWithOtp` for an existing email | |
  | `resetPasswordForEmail` | |
  | `auth.admin.inviteUserByEmail` | |
  | `updateUser({ email })` from a session | (and which of `token` / `token_new` belongs to the current vs the new address) |

  Expected types (mobile spec 4.1): `signup`, `magiclink`, `recovery`, `invite`, `email_change`. Note whether a `signup` or `magiclink` request carries a 6-digit `email_data.token`.

  **Then switch the capture hook off, set `email_sent` back to 100 and restart.** While the hook answers `{}`, no code reaches the mail catcher, and Step 5 needs real code sessions.

- [ ] **Step 4: Can a Before User Created hook tell the three creation paths apart?**

  Enable `[auth.hook.before_user_created]` with a scratch Postgres function that inserts the event JSON into a scratch table, with any value under `password` removed before storing. Create one user each way:
  1. `signUp({ email, password })` with the anon key;
  2. `signInWithOtp({ email })` for a new address;
  3. `auth.admin.createUser({ email, password, email_confirm: true })` with the service role.

  Record which fields differ. Decide:
  - **(A)** Some field reliably marks (1) apart from (2) and (3). Then Task 3 builds the hook with that rule.
  - **(B)** Nothing does. Then Task 3 is skipped. Mobile spec 4.1 allows this; `ensureBuyerProfile`'s password reset alone covers the risk. Say so in the PR.

- [ ] **Step 5: Record whether `auth.admin.signOut(jwt, "others")` ends a second session of the same user**

  Make two code sessions for one user, then call it with session 1's access token. Session 2's `refreshSession()` should fail, and session 1's should still work.

- [ ] **Step 6: Write the findings and commit**

  Fill in the Findings table at the end of this file, restore `supabase/config.toml` (`git checkout supabase/config.toml`), and delete the scratch route, the scratch templates and the scratch table.
  ```bash
  git add docs/superpowers/plans/2026-11-21-buyer-accounts.md
  git commit -m "docs(plan): buyer accounts — local Auth findings"
  ```

---

### Task 2: Example env values are placeholders

Every other secret in `.env.local.example` is an obvious placeholder; `MESSENGER_VERIFY_TOKEN` is not. Make it one, and add the two new secret names. **Don't print, copy or compare the old value.** The owner handles anything beyond the file (Task 12).

**Files:**
- Modify: `.env.local.example`
- Test: `src/__tests__/lib/envExample.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Example env files ship in a public repo. A value that isn't an obvious
// placeholder could be mistaken for, or be, a real secret.
const text = fs.readFileSync(path.join(process.cwd(), ".env.local.example"), "utf8");

function value(name: string): string | undefined {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).replace(/^"|"$/g, "");
}

const PLACEHOLDER = /^(<[^>]+>|(.)\2+|)$/; // <something>, a repeated character, or empty

// Booleans only: a failing toMatch() would print the value in the diff.
const isPlaceholder = (name: string) => {
  const v = value(name);
  return v !== undefined && PLACEHOLDER.test(v);
};

describe(".env.local.example", () => {
  it("uses a placeholder for MESSENGER_VERIFY_TOKEN", () => {
    expect(isPlaceholder("MESSENGER_VERIFY_TOKEN")).toBe(true);
  });

  it.each(["SUPABASE_SEND_EMAIL_HOOK_SECRET", "RATE_LIMIT_HMAC_SECRET"])(
    "names %s with a placeholder value",
    (name) => {
      expect(isPlaceholder(name)).toBe(true);
    },
  );
});
```

- [ ] **Step 2: Run it and confirm it fails**

  Run: `npx vitest run src/__tests__/lib/envExample.test.ts`
  Expected: FAIL. MESSENGER doesn't match, and the two new names are undefined.

- [ ] **Step 3: Edit the file**

  - Set `MESSENGER_VERIFY_TOKEN="<messenger-verify-token>"`. Edit only that line; don't open or echo the old value anywhere else.
  - Add these two lines with comments:
    ```
    # Supabase Send Email Hook secret (Auth > Hooks), without the "v1,whsec_" prefix is fine; code strips it
    SUPABASE_SEND_EMAIL_HOOK_SECRET="<send-email-hook-secret>"
    # 32+ random bytes; keys the per-email rate-limit HMAC
    RATE_LIMIT_HMAC_SECRET="<rate-limit-hmac-secret>"
    ```

- [ ] **Step 4: Run it and confirm it passes**

  Run: `npx vitest run src/__tests__/lib/envExample.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add .env.local.example src/__tests__/lib/envExample.test.ts
git commit -m "chore(env): placeholder for the Messenger verify token; name the buyer sign-in secrets"
```

---

### Task 3: Migration — buyer tables, claim RPCs, rate limits, email trigger

**Files:**
- Create: `supabase/migrations/20261122120000_buyer_accounts.sql`
- Create: `supabase/rollbacks/20261122120000_buyer_accounts.down.sql`
- Create (only if Task 1 Step 4 chose (A)): `supabase/migrations/20261122120100_before_user_created_hook.sql` and its rollback
- Test: `src/__tests__/migrations/buyerAccounts.test.ts` (static), `src/__tests__/db/buyer-accounts.db.test.ts` (database)

- [ ] **Step 1: Write the static test (fails: the files don't exist yet)**

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");
const UP = read("supabase", "migrations", "20261122120000_buyer_accounts.sql");
const DOWN = read("supabase", "rollbacks", "20261122120000_buyer_accounts.down.sql");

const FUNCTIONS = [
  "claim_buyer_profile",
  "buyer_profile_claim_held",
  "create_buyer_profile",
  "release_buyer_profile_claim",
  "consume_rate_limit",
  "sync_buyer_profile_email",
];

describe("buyer accounts migration", () => {
  it.each(["buyer_profiles", "buyer_profile_claims", "mobile_rate_limits"])(
    "turns RLS on for %s and grants API roles nothing",
    (table) => {
      expect(UP).toMatch(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, "i"));
      expect(UP).toMatch(new RegExp(`REVOKE ALL ON public\\.${table} FROM PUBLIC, anon, authenticated`, "i"));
      expect(UP).not.toMatch(new RegExp(`CREATE POLICY[^;]+ON public\\.${table}`, "i"));
    },
  );

  // The header of one function: from its CREATE to the start of its body.
  const header = (fn: string) => {
    const start = UP.search(new RegExp(`CREATE FUNCTION public\\.${fn}\\(`, "i"));
    expect(start).toBeGreaterThanOrEqual(0);
    return UP.slice(start, UP.indexOf("AS $$", start));
  };

  it("grants service_role DML on the three tables (local tables give it none by default)", () => {
    for (const t of ["buyer_profiles", "buyer_profile_claims", "mobile_rate_limits"]) {
      expect(UP).toMatch(new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON public\\.${t} TO service_role`, "i"));
    }
  });

  it.each(FUNCTIONS)("%s is SECURITY DEFINER with an empty search_path and no API-role execute", (fn) => {
    const body = header(fn);
    expect(body).toMatch(/SECURITY DEFINER/i);
    expect(body).toMatch(/SET search_path = ''/i);
    expect(UP).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`, "i"));
  });

  it("lets only service_role run the RPCs (not the trigger function)", () => {
    for (const fn of FUNCTIONS.filter((f) => f !== "sync_buyer_profile_email")) {
      expect(UP).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role`, "i"));
    }
    expect(UP).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.sync_buyer_profile_email/i);
  });

  it("sets a 5 s lock_timeout on the claim and create RPCs", () => {
    for (const fn of ["claim_buyer_profile", "create_buyer_profile"]) {
      expect(header(fn)).toMatch(/SET lock_timeout = '5s'/i);
    }
  });

  it("consume_rate_limit refuses bad arguments and sweeps old windows of every key", () => {
    const body = UP.slice(UP.search(/CREATE FUNCTION public\.consume_rate_limit\(/i));
    expect(body).toMatch(/p_window_seconds NOT BETWEEN 1 AND 86400/i);
    expect(body).toMatch(/ERRCODE = '22023'/i);
    // No per-key cleanup: rows of keys that never come back must expire too.
    expect(body.slice(0, body.indexOf("$$;"))).not.toMatch(/WHERE key = p_key AND window_start </i);
    expect(body).toMatch(/ORDER BY window_start\s+LIMIT 50\s+FOR UPDATE SKIP LOCKED/i);
    expect(UP).toMatch(/CREATE INDEX mobile_rate_limits_window_start_idx ON public\.mobile_rate_limits \(window_start\)/i);
  });

  it("syncs the profile email only when the auth email changes", () => {
    expect(UP).toMatch(/AFTER UPDATE OF email ON auth\.users/i);
    expect(UP).toMatch(/WHEN \(OLD\.email IS DISTINCT FROM NEW\.email/i);
  });

  it("rollback drops the trigger before its function, and every object", () => {
    expect(DOWN.search(/DROP TRIGGER/i)).toBeLessThan(DOWN.search(/DROP FUNCTION IF EXISTS public\.sync_buyer_profile_email/i));
    for (const name of [
      ...FUNCTIONS,
      "buyer_profiles",
      "buyer_profile_claims",
      "mobile_rate_limits",
      "mobile_rate_limits_window_start_idx",
    ]) {
      expect(DOWN).toContain(name);
    }
  });
});
```

  Run: `npx vitest run src/__tests__/migrations/buyerAccounts.test.ts`. Expected: FAIL (ENOENT).

- [ ] **Step 2: Write the migration**

```sql
-- Buyer accounts (account-bound tickets Plan 2; mobile spec 4.1, 4.2, 4.4, 12 steps 1, 1a, 2).
-- Every new object is service-role only: RLS on with no policies, functions
-- revoked from PUBLIC, anon and authenticated.

-- ─── buyer_profiles ─────────────────────────────────────────────────────────
CREATE TABLE public.buyer_profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text NOT NULL UNIQUE CHECK (email = lower(email)),
  phone_e164  text NULL,                -- unverified contact number; never used to sign in or find orders
  name        text NULL,
  locale      text NOT NULL DEFAULT 'my' CHECK (locale IN ('my', 'en')),
  is_reviewer boolean NOT NULL DEFAULT false,  -- set only by a superadmin or the reviewer repair
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz NULL
);
ALTER TABLE public.buyer_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.buyer_profiles TO service_role;

-- ─── buyer_profile_claims ───────────────────────────────────────────────────
CREATE TABLE public.buyer_profile_claims (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  token      uuid NOT NULL,
  claimed_at timestamptz NOT NULL
);
ALTER TABLE public.buyer_profile_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_profile_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.buyer_profile_claims TO service_role;

-- ─── mobile_rate_limits ─────────────────────────────────────────────────────
CREATE TABLE public.mobile_rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        int NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
ALTER TABLE public.mobile_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mobile_rate_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mobile_rate_limits TO service_role;
CREATE INDEX mobile_rate_limits_window_start_idx ON public.mobile_rate_limits (window_start);

-- Counts one event for p_key in the current fixed window and says whether it
-- is still within p_limit. The caller passes an already-hashed key; this never
-- sees an email address. Windows are 1 s to 1 day: a longer window would be
-- swept by the two-day cleanup below while still counting, and fail open.
CREATE FUNCTION public.consume_rate_limit(p_key text, p_window_seconds int, p_limit int)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_start timestamptz;
  v_count int;
BEGIN
  IF p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 1 AND 86400 OR p_limit IS NULL OR p_limit < 0 THEN
    RAISE EXCEPTION 'bad rate limit args' USING ERRCODE = '22023';
  END IF;

  -- Assigned after the check: in DECLARE it would divide by zero first.
  v_start := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);

  INSERT INTO public.mobile_rate_limits AS r (key, window_start, count)
  VALUES (p_key, v_start, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET count = r.count + 1
  RETURNING r.count INTO v_count;

  -- Rows expire whether or not their key comes back (a deleted account's keys
  -- included): each call drops up to 50 windows, of any key, older than two
  -- days, oldest first. SKIP LOCKED: two callers sweeping at once take
  -- different rows instead of waiting on each other.
  DELETE FROM public.mobile_rate_limits
  WHERE ctid = ANY (ARRAY(
    SELECT ctid FROM public.mobile_rate_limits
    WHERE window_start < now() - interval '2 days'
    ORDER BY window_start
    LIMIT 50
    FOR UPDATE SKIP LOCKED
  ));

  RETURN v_count <= p_limit;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_rate_limit(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(text, int, int) TO service_role;

-- ─── Profile claim (mobile spec 4.1 step 2) ─────────────────────────────────
-- Returns the new claim token, 'exists' when a profile row (live or being
-- deleted) is already there, or NULL when another caller holds a fresh claim.
-- The profile check is a separate statement after the claim, so under
-- READ COMMITTED it sees a profile committed in the meantime.
CREATE FUNCTION public.claim_buyer_profile(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_token uuid;
BEGIN
  INSERT INTO public.buyer_profile_claims AS c (user_id, token, claimed_at)
  VALUES (p_user_id, gen_random_uuid(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET token = gen_random_uuid(), claimed_at = now()
    WHERE c.claimed_at < now() - interval '30 seconds'
  RETURNING c.token INTO v_token;

  IF v_token IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM public.buyer_profiles WHERE id = p_user_id) THEN
    DELETE FROM public.buyer_profile_claims WHERE user_id = p_user_id AND token = v_token;
    RETURN 'exists';
  END IF;

  RETURN v_token::text;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_buyer_profile(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_buyer_profile(uuid) TO service_role;

CREATE FUNCTION public.buyer_profile_claim_held(p_user_id uuid, p_token uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.buyer_profile_claims WHERE user_id = p_user_id AND token = p_token
  );
$$;
REVOKE ALL ON FUNCTION public.buyer_profile_claim_held(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_profile_claim_held(uuid, uuid) TO service_role;

-- Returns 'created', 'existing' (a row was already there) or 'lost' (the
-- claim was taken over; nothing inserted).
CREATE FUNCTION public.create_buyer_profile(p_user_id uuid, p_token uuid, p_email text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_inserted int;
BEGIN
  PERFORM 1 FROM public.buyer_profile_claims
  WHERE user_id = p_user_id AND token = p_token
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'lost';
  END IF;

  -- ON CONFLICT (id) only: an email already used by ANOTHER user's profile
  -- must raise (unique_violation), not look like 'existing' for this user.
  INSERT INTO public.buyer_profiles (id, email)
  VALUES (p_user_id, lower(p_email))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  DELETE FROM public.buyer_profile_claims WHERE user_id = p_user_id AND token = p_token;

  RETURN CASE WHEN v_inserted = 1 THEN 'created' ELSE 'existing' END;
END;
$$;
REVOKE ALL ON FUNCTION public.create_buyer_profile(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_buyer_profile(uuid, uuid, text) TO service_role;

-- Deletes only the caller's own claim, never someone else's.
CREATE FUNCTION public.release_buyer_profile_claim(p_user_id uuid, p_token uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.buyer_profile_claims WHERE user_id = p_user_id AND token = p_token;
$$;
REVOKE ALL ON FUNCTION public.release_buyer_profile_claim(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_buyer_profile_claim(uuid, uuid) TO service_role;

-- ─── Email sync (mobile spec 4.2, 12 step 1a) ───────────────────────────────
-- Email change isn't offered, but Supabase can't switch updateUser({ email })
-- off. If both addresses confirm a change anyway, keep the profile equal to
-- the auth email in the same transaction. Does nothing else: an error here
-- would roll back the Auth update.
CREATE FUNCTION public.sync_buyer_profile_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.buyer_profiles
  SET email = lower(NEW.email), updated_at = now()
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sync_buyer_profile_email() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_buyer_profile_email() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER buyer_profile_email_sync
AFTER UPDATE OF email ON auth.users
FOR EACH ROW
WHEN (OLD.email IS DISTINCT FROM NEW.email AND NEW.email IS NOT NULL)
EXECUTE FUNCTION public.sync_buyer_profile_email();
```

- [ ] **Step 3: Write the rollback**

```sql
-- Reverse of 20261122120000_buyer_accounts.sql. Destroys buyer profiles:
-- run only with the owner's explicit confirmation.
DROP TRIGGER IF EXISTS buyer_profile_email_sync ON auth.users;
DROP FUNCTION IF EXISTS public.sync_buyer_profile_email();
DROP FUNCTION IF EXISTS public.release_buyer_profile_claim(uuid, uuid);
DROP FUNCTION IF EXISTS public.create_buyer_profile(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.buyer_profile_claim_held(uuid, uuid);
DROP FUNCTION IF EXISTS public.claim_buyer_profile(uuid);
DROP FUNCTION IF EXISTS public.consume_rate_limit(text, int, int);
DROP INDEX IF EXISTS public.mobile_rate_limits_window_start_idx;
DROP TABLE IF EXISTS public.mobile_rate_limits;
DROP TABLE IF EXISTS public.buyer_profile_claims;
DROP TABLE IF EXISTS public.buyer_profiles;
```

- [ ] **Step 4: Run the static test and confirm it passes**

  Run: `npx vitest run src/__tests__/migrations/buyerAccounts.test.ts`. Expected: PASS.

- [ ] **Step 5: Write the database test**

  `src/__tests__/db/buyer-accounts.db.test.ts`, using the `pg` pool pattern from `staff-password-session.db.test.ts`. Insert `auth.users` rows directly and clean up in `afterAll`. Cases:
  - `claim_buyer_profile` on a fresh user returns a uuid; a second call within 30 s returns NULL.
  - After `UPDATE buyer_profile_claims SET claimed_at = now() - interval '31 seconds'`, a new claim returns a **different** uuid, and the first token's `create_buyer_profile` returns `'lost'`, inserts nothing and leaves the new holder's claim alone.
  - With a profile already present, `claim_buyer_profile` returns `'exists'` and leaves no claim row.
  - `create_buyer_profile` with the held token returns `'created'`, stores the email lower-cased and leaves no claim row.
  - `create_buyer_profile` returns `'existing'` when this user's profile is already there (claim row inserted by hand), and leaves no claim row.
  - `create_buyer_profile` for user B, with an email already on user A's profile, raises `unique_violation` (23505), not `'existing'`. **Claim for B first**, or the function returns `'lost'` before the INSERT. B's claim row survives the raise (the delete rolls back), so clean up through the `auth.users` cascade.
  - `buyer_profile_claim_held` is true only for the held token. `release_buyer_profile_claim` with the wrong token deletes nothing; with the right one it deletes the row.
  - `consume_rate_limit('<random uuid>', 3600, 2)` returns true, true, false. Use a fresh key each run, and delete its rows in `afterAll`, so a second run within the hour still passes.
  - `consume_rate_limit` raises 22023 for a window of 0, a window of 604800 s (over a day) and a NULL limit.
  - The sweep crosses keys: an old (3-day) row for a **different** key is gone after `consume_rate_limit` runs for a fresh key.
  - Email sync: an update to another `auth.users` column changes nothing (email and `updated_at`); `SET email = email` leaves `updated_at` unchanged; changing it to `New@Example.test` sets `buyer_profiles.email` to `new@example.test`; setting it to NULL succeeds and the profile keeps its email.
  - Concurrency, with two `pg` clients: client 1 runs `BEGIN` and `create_buyer_profile` with the held token without committing; client 2 calls `claim_buyer_profile` without awaiting (attach a no-op `catch` so a failed assertion isn't hidden by an unhandled rejection); once `pg_stat_activity` shows client 2 waiting on a `Lock`, client 1 commits; client 2 resolves to `'exists'` and no claim row is left.
  - As `authenticated` (`SET LOCAL ROLE authenticated` with a JWT claim for one of the test users, inside a transaction that is rolled back), with a row seeded in each table first:
    - all five RPCs (`claim_buyer_profile`, `consume_rate_limit`, `create_buyer_profile`, `buyer_profile_claim_held`, `release_buyer_profile_claim`) fail with 42501;
    - `SELECT` on each new table returns **zero rows** (while the superuser sees at least one), and an `INSERT` is refused (`new row violates row-level security policy`).

    Don't expect 42501 on the tables: `src/__tests__/db/setup.ts` re-grants table DML to `anon` and `authenticated` before every DB run, so locally only RLS stands between them and the rows. **Don't weaken the migration's REVOKE to match local behaviour.** Prove the REVOKE on the dev database in Task 12 instead.

- [ ] **Step 6: Apply locally and run the database tests**

  Run: `npx supabase migration up` (local stack only), then `npm run test:db -- buyer-accounts`.
  Expected: PASS. Confirm the existing DB tests still pass with `npm run test:db`.

  This is the first trigger this repo puts on `auth.users`. If the local apply fails on it with a permission error, **stop and report**. Don't move the trigger or the function into the `auth` schema.

- [ ] **Step 7 (only if Task 1 chose (A)): the Before User Created hook**

  In `20261122120100_before_user_created_hook.sql`, create `public.hook_before_user_created(event jsonb) RETURNS jsonb`. It returns `jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Sign up with an email code.'))` when the field found in Task 1 marks a public password sign-up, and `'{}'::jsonb` otherwise.
  - `SECURITY DEFINER`, `SET search_path = ''`.
  - `GRANT EXECUTE … TO supabase_auth_admin`; `REVOKE … FROM PUBLIC, anon, authenticated`.
  - Rollback drops it.
  - Add a DB test calling it with each of the three event shapes recorded in Task 1, with passwords removed.

- [ ] **Step 8: Update `src/types/database.ts`**

  Add `buyer_profiles`, `buyer_profile_claims` and `mobile_rate_limits` under `Tables`, and the five RPCs under `Functions`, following the file's existing hand-written style. Run `npx tsc --noEmit`; expected exit 0.

- [ ] **Step 9: Commit**
```bash
git add supabase/migrations/20261122120000_buyer_accounts.sql supabase/rollbacks/20261122120000_buyer_accounts.down.sql \
        src/__tests__/migrations/buyerAccounts.test.ts src/__tests__/db/buyer-accounts.db.test.ts src/types/database.ts
# plus the hook migration, its rollback and test if Step 7 ran
git commit -m "feat(db): buyer profiles, profile claims, durable rate limits, email sync"
```

---

### Task 4: Token claim helpers and the Auth-error classifier

**Files:**
- Modify: `src/lib/authMethod.ts`
- Create: `src/lib/buyers/authErrors.ts`, `src/lib/buyers/errors.ts`
- Test: `src/__tests__/lib/authMethod.test.ts` (extend), `src/__tests__/lib/buyers/authErrors.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

  Add to `authMethod.test.ts`. Its existing `token(payload)` helper takes the **whole payload object**:
```ts
import { tokenClaim, isEmailCodeSession } from "@/lib/authMethod";

describe("tokenClaim", () => {
  it("reads a string claim", () => {
    expect(tokenClaim(token({ session_id: "s-1" }), "session_id")).toBe("s-1");
  });
  it("returns null for a missing, non-string or malformed claim", () => {
    expect(tokenClaim(token({}), "session_id")).toBeNull();
    expect(tokenClaim(token({ session_id: 7 }), "session_id")).toBeNull();
    expect(tokenClaim("not-a-jwt", "session_id")).toBeNull();
  });
});

describe("isEmailCodeSession", () => {
  it("is true only when amr has otp", () => {
    expect(isEmailCodeSession(token({ amr: [{ method: "otp", timestamp: 1 }] }))).toBe(true);
    expect(isEmailCodeSession(token({ amr: [{ method: "password", timestamp: 1 }] }))).toBe(false);
    expect(isEmailCodeSession(token({ amr: [{ method: "magiclink", timestamp: 1 }] }))).toBe(false);
  });
});
```

  `src/__tests__/lib/buyers/authErrors.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { classifyAuthError } from "@/lib/buyers/authErrors";

describe("classifyAuthError", () => {
  it.each([
    [new AuthApiError("expired", 401, "bad_jwt")],
    [new AuthApiError("gone", 403, "user_not_found")],
    [new AuthApiError("ended", 403, "session_not_found")],
    [new AuthApiError("bad", 400, "validation_failed")],
  ])("a 4xx answer is a rejection", (err) => {
    expect(classifyAuthError(err)).toBe("rejected");
  });

  it.each([
    [new AuthApiError("slow down", 429, "over_request_rate_limit")],
    [new AuthApiError("boom", 500, "unexpected_failure")],
    [new AuthApiError("bad gateway", 502, undefined as unknown as string)],
    [new AuthRetryableFetchError("network", 0)],
    [new Error("aborted")],
  ])("a 429, a 5xx, a network failure or anything unknown means Auth is unavailable", (err) => {
    expect(classifyAuthError(err)).toBe("unavailable");
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

  Run: `npx vitest run src/__tests__/lib/authMethod.test.ts src/__tests__/lib/buyers/authErrors.test.ts`. Expected: FAIL (missing exports).

- [ ] **Step 3: Implement**

  `src/lib/authMethod.ts`: refactor the decode into one private `decodeClaims(token)` used by both existing functions, then add:
```ts
/** A string claim from a token getUser() has ALREADY accepted. Decodes only. */
export function tokenClaim(accessToken: string | null | undefined, name: string): string | null {
  const claims = decodeClaims(accessToken);
  const v = claims?.[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** verifyOtp with an email code records amr method "otp" (plan Task 1 finding). */
export function isEmailCodeSession(accessToken: string | null | undefined): boolean {
  return sessionAuthMethods(accessToken).includes("otp");
}
```

  `src/lib/buyers/authErrors.ts`:
```ts
import { isAuthApiError } from "@supabase/supabase-js";

// Supabase Auth answered "this token is no good" (any 4xx except 429), or it
// couldn't answer (429, 5xx, network, timeout, unknown). The app signs a buyer
// out on 401, so an Auth outage must never become one (mobile spec 4.3).
export type AuthFailure = "rejected" | "unavailable";

export function classifyAuthError(error: unknown): AuthFailure {
  if (isAuthApiError(error)) {
    const s = error.status;
    if (s >= 400 && s < 500 && s !== 429) return "rejected";
  }
  return "unavailable";
}
```

  `src/lib/buyers/errors.ts`:
```ts
import { NextResponse } from "next/server";

export type BuyerErrorCode =
  | "UNAUTHENTICATED" | "FORBIDDEN" | "CONFLICT" | "DELETION_IN_PROGRESS"
  | "VALIDATION" | "RATE_LIMITED" | "SERVER";

// Mobile spec common error shape: { error: { code, message } }.
export function buyerError(status: number, code: BuyerErrorCode, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

  Same command. Expected: PASS. Also run `npx vitest run src/__tests__/lib/require-auth-password.test.ts src/__tests__/middleware.test.ts`: the refactor must not change `isPasswordSession`.

- [ ] **Step 5: Commit**
```bash
git add src/lib/authMethod.ts src/lib/buyers src/__tests__/lib/authMethod.test.ts src/__tests__/lib/buyers
git commit -m "feat(auth): token claim helpers and an Auth error classifier for buyer routes"
```

---

### Task 5: `requireBuyer`

**Files:**
- Create: `src/lib/buyers/requireBuyer.ts`
- Modify: `src/lib/api.ts` (one re-export line)
- Test: `src/__tests__/lib/buyers/requireBuyer.test.ts`

Behaviour (mobile spec 4.3, design 4.3):
1. The token comes from `x-supabase-auth` or `Authorization: Bearer …` (the app), or else the cookie session (the website). No token → 401 `UNAUTHENTICATED`. `getSession()` may refresh a near-expiry session: if it returns an error `classifyAuthError` calls `unavailable`, or it throws, → 503 `SERVER` (never 401); a real rejection with no session stays 401.
2. `getUser(token)` asks Auth. If it fails, `classifyAuthError` decides: `rejected` → 401 `UNAUTHENTICATED`; `unavailable` → 503 `SERVER`.
3. Only after that, read `session_id` from the same token. Missing → 401.
4. A `users` row exists (staff) → 403 `FORBIDDEN`.
5. No `buyer_profiles` row, or `deleted_at` is set → 401 `UNAUTHENTICATED`.
6. `buyer_profiles.email` ≠ `lower(user.email)` → 401 `UNAUTHENTICATED`. The trigger keeps them equal, so a mismatch means something is wrong; fail closed.
7. A failed read of `users` or `buyer_profiles` (a database error, not "no row") → 503 `SERVER`.
8. Otherwise return `{ buyerId, email, isReviewer, sessionId }`.

The profile and staff reads use the service-role client: the tables have no policies.

- [ ] **Step 1: Write the failing tests**

  Mock `next/headers` (as `require-auth-password.test.ts` does), `@/lib/supabase/server` (cookie client with `auth.getSession`), and `@/lib/supabase/admin` (`from("users")`, `from("buyer_profiles")` with `.select().eq().maybeSingle()`). Mock `@supabase/supabase-js` **with `importOriginal`**, replacing only `createClient` (the client that calls `getUser`), so `isAuthApiError` and the error classes stay real. Build tokens with a local `token(payload)` helper like the one in `authMethod.test.ts`. Cases, each asserting status, `error.code`, and that later reads did **not** happen when an earlier step failed:
  - no header and no cookie session → 401; `getUser` not called;
  - `x-supabase-auth: Bearer GOOD` and `authorization: Bearer OTHER` both set → `getUser` gets `GOOD`;
  - `authorization: Basic xyz` and no cookie session → 401; `getUser` not called;
  - `getSession` resolves `{ session: null, error: AuthRetryableFetchError }` (a refresh that couldn't reach Auth) → 503 `SERVER`; `getUser` not called;
  - `getSession` rejects → 503 `SERVER`; `getUser` not called;
  - `getSession` returns `AuthApiError(400, "refresh_token_not_found")` with no session → 401; `getUser` not called;
  - Bearer, `getUser` → `AuthApiError(403, "session_not_found")` → 401;
  - Bearer, `getUser` → `AuthApiError(500)` → 503 `SERVER`;
  - Bearer, `getUser` throws `AuthRetryableFetchError` → 503;
  - Bearer, `getUser` → 429 → 503;
  - accepted token with no `session_id` → 401, and `from()` never called;
  - staff (`users` row found) → 403, `buyer_profiles` not read; `users` read returns `{ error }` → 503, `buyer_profiles` not read;
  - no profile → 401; `deleted_at` set → 401; email mismatch → 401 (each reads exactly `users`, `buyer_profiles`);
  - `buyer_profiles` read returns `{ error }` → 503;
  - every 503 path logs a fixed string, and no `console` call contains the token, the email or the user id;
  - happy path, Bearer: returns `{ buyerId: "u1", email: "b@example.test", isReviewer: false, sessionId: "s1" }`;
  - happy path, cookie: same result, and the token passed to `tokenClaim` is the cookie session's `access_token`.

- [ ] **Step 2: Run them and confirm they fail**

  Run: `npx vitest run src/__tests__/lib/buyers/requireBuyer.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/buyers/requireBuyer.ts`**

```ts
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { createClient as createBareClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { tokenClaim } from "@/lib/authMethod";
import { classifyAuthError } from "./authErrors";
import { buyerError } from "./errors";

export interface BuyerContext {
  buyerId: string;
  email: string;
  isReviewer: boolean;
  sessionId: string;
}

type AuthUser = { id: string; email?: string | null };

type TokenRead =
  | { kind: "token"; token: string }
  | { kind: "none" }
  | { kind: "unavailable" };

const unauthenticated = () => buyerError(401, "UNAUTHENTICATED", "Sign in required.");
const authUnavailable = () => buyerError(503, "SERVER", "Sign-in service unavailable. Try again.");

/**
 * The bearer token, else the cookie session's token (website). getSession()
 * may refresh a near-expiry session; if that refresh can't reach Auth, the
 * answer is "unavailable" (503), never "none" (401).
 */
async function readToken(): Promise<TokenRead> {
  const h = headers();
  const header = h.get("x-supabase-auth") ?? h.get("authorization");
  if (header?.startsWith("Bearer ")) return { kind: "token", token: header.substring(7) };
  try {
    const { data, error } = await createClient().auth.getSession();
    if (error && classifyAuthError(error) === "unavailable") return { kind: "unavailable" };
    const token = data.session?.access_token;
    return token ? { kind: "token", token } : { kind: "none" };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * Guard for every buyer route (web and mobile). Asks the Auth server; never a
 * local-only JWT check, so a deleted user or ended session fails at once.
 * Logs fixed strings only: never a token, email or id.
 */
export async function requireBuyer(): Promise<BuyerContext | NextResponse> {
  const read = await readToken();
  if (read.kind === "unavailable") {
    console.error("[requireBuyer] cookie session read failed");
    return authUnavailable();
  }
  if (read.kind === "none") return unauthenticated();
  const token = read.token;

  let user: AuthUser;
  try {
    const client = createBareClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) {
      if (classifyAuthError(error) === "rejected") return unauthenticated();
      console.error("[requireBuyer] Auth getUser unavailable");
      return authUnavailable();
    }
    user = data.user;
  } catch (err) {
    if (classifyAuthError(err) === "rejected") return unauthenticated();
    console.error("[requireBuyer] Auth getUser threw");
    return authUnavailable();
  }

  // Read only after getUser has accepted this exact token.
  const sessionId = tokenClaim(token, "session_id");
  if (!sessionId) return unauthenticated();

  const admin = createAdminClient();

  const staff = await admin.from("users").select("id").eq("id", user.id).maybeSingle();
  if (staff.error) {
    console.error("[requireBuyer] users lookup failed");
    return buyerError(503, "SERVER", "Try again.");
  }
  if (staff.data) return buyerError(403, "FORBIDDEN", "Staff accounts can't use buyer pages.");

  const profile = await admin
    .from("buyer_profiles")
    .select("id, email, is_reviewer, deleted_at")
    .eq("id", user.id)
    .maybeSingle();
  if (profile.error) {
    console.error("[requireBuyer] buyer_profiles lookup failed");
    return buyerError(503, "SERVER", "Try again.");
  }
  const p = profile.data as { id: string; email: string; is_reviewer: boolean; deleted_at: string | null } | null;
  if (!p || p.deleted_at) return unauthenticated();
  if (p.email !== (user.email ?? "").toLowerCase()) return unauthenticated();

  return { buyerId: p.id, email: p.email, isReviewer: p.is_reviewer, sessionId };
}
```

  In `src/lib/api.ts`, add next to the existing exports:
```ts
// Buyer guard (mobile spec 4.3 names this file). Implemented in its own module.
export { requireBuyer, type BuyerContext } from "@/lib/buyers/requireBuyer";
```

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `npx vitest run src/__tests__/lib/buyers/requireBuyer.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/buyers/requireBuyer.ts src/lib/api.ts src/__tests__/lib/buyers/requireBuyer.test.ts
git commit -m "feat(auth): requireBuyer — Auth-checked buyer guard; 401 only for real rejections"
```

---

### Task 6: `ensureBuyerProfile` — the only path that creates a profile

**Files:**
- Create: `src/server/buyers/adminClient.ts`, `src/server/buyers/ensureBuyerProfile.ts`
- Test: `src/__tests__/server/buyers/ensureBuyerProfile.test.ts`, `src/__tests__/server/buyers/adminClient.test.ts`

Mobile spec 4.1, "No password a buyer didn't set", and 4.5. The function takes an Auth user that the caller's `getUser` has **already accepted**, plus that session's access token.

```ts
export type EnsureResult =
  | { ok: true; status: 200 | 201; profile: BuyerProfile }
  | { ok: false; status: 403; code: "FORBIDDEN"; reason: "staff" | "unconfirmed" | "not_email_code" }
  | { ok: false; status: 409; code: "DELETION_IN_PROGRESS" }
  | { ok: false; status: 503; code: "SERVER" };

export interface EnsureInput {
  user: { id: string; email?: string | null; email_confirmed_at?: string | null };
  accessToken: string;
}
export interface EnsureDeps { admin: SupabaseClient<Database> }

export async function ensureBuyerProfile(
  input: EnsureInput,
  deps: EnsureDeps = { admin: createTimedAdminClient() },
): Promise<EnsureResult>;
```

Order. Each step's failure is final unless it says otherwise.
1. `users` row exists → 403 `staff`. A read error → 503.
2. `email_confirmed_at` is empty, **or the Auth user has no `email`** → 403 `unconfirmed` (so `create_buyer_profile` never gets an empty email).
3. Profile exists: live → `200` with it, and **nothing else runs**; `deleted_at` set → 409. A read error → 503.
4. `isEmailCodeSession(accessToken)` is false, **or `isPasswordSession(accessToken)` is true** → 403 `not_email_code`. A session whose `amr` lists `password` is refused even if it also lists `otp`. This runs before the claim, so a password session never holds one.
5. `claim_buyer_profile(userId)`:
   - NULL → 503;
   - `'exists'` → re-read the profile and answer as in step 3;
   - a token → continue.
6. `buyer_profile_claim_held(userId, token)` is false or returns `{ error }` → release the claim, 503.
7. `auth.admin.updateUserById(userId, { password: <48 random bytes, base64url> + "aA1!"> })` (68 characters; the fixed suffix has one lowercase, uppercase, digit and symbol, so a hosted policy that demands symbols accepts it) returns `{ error }` or throws → release the claim, 503.
8. `auth.admin.signOut(accessToken, "others")` returns `{ error }` or throws → release the claim, 503.
9. `create_buyer_profile(userId, token, email)`:
   - `'created'` → 201 with the new row;
   - `'existing'` → re-read and answer as in step 3 (live → 200, `deleted_at` set → 409). If the re-read finds no row, answer 503;
   - `'lost'` → 503, and don't release (the claim is no longer ours);
   - an RPC error (including 23505: the email is on another user's profile, which the `auth.users` uniqueness should make impossible) → release, 503;
   - any other value → release, 503.

RPC calls go through one local helper, `rpc(admin, name, args)`, typed from `Database["public"]["Functions"]`: supabase-js can't infer RPC types from the hand-written `Database` type, so the helper casts once (the rest of the repo casts with `as never` at each call). Failures log only the step name and the error's `code`/`status`/`name`, never a message.

**Every exit after step 5 that isn't 9's `'created'`/`'existing'`/`'lost'` releases the claim with `release_buyer_profile_claim(userId, token)`. Wrap steps 6–9 in `try { … } catch { release; return 503 }`.** Never log the password, the token or the email address.

`src/server/buyers/adminClient.ts`: a service-role client whose `global.fetch` adds `AbortSignal.timeout(5000)`, so every Auth and RPC call stops after 5 s, as the mobile spec requires. A caller's own signal is combined with the timeout (`AbortSignal.any`, Node 22), never allowed to replace it:
```ts
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export const TIMEOUT_MS = 5_000;

/** Every request stops after 5 s, even when the caller passes its own signal. */
export const timedFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)])
      : AbortSignal.timeout(TIMEOUT_MS),
  });

/** Service role; every request aborts after 5 s (mobile spec 4.1 step 2). */
export const createTimedAdminClient = () =>
  createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: timedFetch },
  });
```

- [ ] **Step 1: Write the failing tests**

  Inject the admin client: `ensureBuyerProfile(input, deps = { admin: createTimedAdminClient() })`. The tests pass a fake with `from()`, `rpc()` and `auth.admin.{updateUserById, signOut}` as `vi.fn()`s, and record calls in order. Cases:
  - staff → 403 `staff`; no `rpc` or `auth.admin` call;
  - unconfirmed → 403 `unconfirmed`; no email on the Auth user → 403 `unconfirmed`;
  - live profile → 200; **no** `rpc`, `updateUserById` or `signOut` (a web session stays signed in);
  - deleted profile → 409;
  - password session (`amr` `password`), no profile → 403 `not_email_code`, and `claim_buyer_profile` never called;
  - `amr` `[password, otp]`, no profile → 403 `not_email_code`, no `rpc` call;
  - claim NULL → 503, nothing else called;
  - claim `'exists'` → re-reads and returns 200 with no reset;
  - held false → 503 and `release` called with **that** token; held returns `{ error }` → 503, release called;
  - `updateUserById` returns `{ error }` → 503, release called, `signOut` not called, `create` not called;
  - `updateUserById` throws (simulate abort) → 503, release called;
  - `signOut` returns `{ error }` → 503, release called, `create` not called;
  - `create` → `'lost'` → 503, release **not** called;
  - happy path → order is exactly: users read, profile read, `claim_buyer_profile`, `buyer_profile_claim_held`, `updateUserById` (with a password of length ≥ 64, holding a lowercase, uppercase, digit and symbol, that isn't in the result), `signOut(token, "others")`, `create_buyer_profile`, profile re-read → 201; the fake's `eq()` records its arguments and both reads filter on `("id", userId)`;
  - `create` → `'existing'` → 200; `'existing'` with no row on re-read → 503;
  - `create` RPC returns `{ error }` (e.g. 23505) → 503, release called; `create` returns an unexpected value → 503, release called;
  - nothing in the result, and no `console.*` call, contains the email or the password (spy on `console`).

  `adminClient.test.ts` stubs global `fetch` and `AbortSignal.timeout` and checks that the signal `timedFetch` sends aborts when the 5 s timeout fires, with and without a caller signal, and that a caller's abort still aborts it.

- [ ] **Step 2: Run them and confirm they fail**

  Run: `npx vitest run src/__tests__/server/buyers/ensureBuyerProfile.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `src/server/buyers/ensureBuyerProfile.ts` exactly in the order above. Use `crypto.randomBytes(48).toString("base64url") + "aA1!"` for the password. Type the RPC calls through `src/types/database.ts`.

- [ ] **Step 4: Run the tests and confirm they pass**

  Same command. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/server/buyers src/__tests__/server/buyers
git commit -m "feat(buyers): ensureBuyerProfile — claim, reset password, end other sessions, create"
```

---

### Task 7: Web profile route `/api/account/profile`

**Files:**
- Create: `src/app/api/account/profile/route.ts`
- Test: `src/__tests__/api/account/profile.test.ts`

- `GET` → `requireBuyer()`. Its error response passes through unchanged. On success, read `name, locale` from `buyer_profiles` (service-role admin client, `id = buyerId`) and answer `200 { email, name, locale }` (`email` from `requireBuyer`). A read error → 503 `SERVER`; no row (deleted meanwhile) → 401 `UNAUTHENTICATED`.
- `POST` → the website's `POST /me`:
  1. Cookie session only. Bearer is for the app's own route in #451; a Bearer header is ignored.
  2. A JSON body with an `email` key (any value) → 422 `VALIDATION`, checked before any Auth call. Malformed JSON → 422. An empty or absent body is fine.
  3. `createClient().auth.getSession()`, same rule as `requireBuyer` (`d102fa6`): it throws, or `classifyAuthError(error) === "unavailable"` (a near-expiry refresh that couldn't reach Auth) → **503** `SERVER`. No session and no error, or a real 4xx rejection with no session → **401** `UNAUTHENTICATED`. Decide this before `getUser`: with no session, `getUser()` returns `AuthSessionMissingError`, which isn't an `AuthApiError` and would classify as "unavailable" (503).
  4. `getUser(session.access_token)` with that exact token, on a bare non-persisting client as in `requireBuyer`. On failure (error, throw, or no user), `classifyAuthError` → 401 or 503. This way the token handed on is the one Auth accepted.
  5. Only then call `ensureBuyerProfile({ user, accessToken })` with the Auth user `getUser` returned (`{ id, email, email_confirmed_at }`) and that token.
  6. Map the `EnsureResult`: `ok` → its status (200 or 201) with `{ email, name, locale }` from the profile. `FORBIDDEN` → 403 `{ error: { code: "FORBIDDEN", message, reason } }`, `reason` being `staff`, `unconfirmed` or `not_email_code`, so the page can show the staff message. 409 → `DELETION_IN_PROGRESS`. 503 → `SERVER`.
  7. Logs fixed strings only: never a token or an email.

- [ ] **Step 1: Write the failing tests**

  Mock `@/lib/supabase/server`, `@supabase/supabase-js` (`importOriginal`, for the real error classes and a mocked `createClient`), `@/lib/buyers/requireBuyer`, `@/server/buyers/ensureBuyerProfile` and `@/lib/supabase/admin`. Cover each branch above, plus:
  - each `getSession` outcome (unavailable error → 503, throw → 503, real rejection → 401, no session → 401), and in each neither `getUser` nor `ensureBuyerProfile` is called;
  - `ensureBuyerProfile` receives `getUser`'s user and the session's own token;
  - a `getUser` 4xx → 401, 5xx or throw → 503, and `ensureBuyerProfile` isn't called;
  - a body `{ "email": "x@y.z" }` → 422, and `ensureBuyerProfile` isn't called;
  - every `EnsureResult` mapping; `GET`'s pass-through, 200 and 503.

- [ ] **Step 2: Run them and confirm they fail**

  Run: `npx vitest run src/__tests__/api/account/profile.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the route (`export const dynamic = "force-dynamic"`).

- [ ] **Step 4: Run the tests and confirm they pass**

  Same command. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/app/api/account src/__tests__/api/account
git commit -m "feat(account): web profile route — GET via requireBuyer, POST via ensureBuyerProfile"
```

---

### Task 8: Send Email Hook — signature, copy, limits, route

**Files:**
- Create: `src/lib/auth/standardWebhook.ts`, `src/lib/auth/authEmailCopy.ts`, `src/lib/auth/authEmailLimits.ts`, `src/app/api/internal/auth/send-email/route.ts`
- Test: `src/__tests__/lib/auth/standardWebhook.test.ts`, `src/__tests__/lib/auth/authEmailCopy.test.ts`, `src/__tests__/api/internal/send-email.test.ts`

No new dependency. Verify with Node `crypto`, per the Standard Webhooks scheme Supabase uses:
- headers `webhook-id`, `webhook-timestamp` (Unix seconds) and `webhook-signature` (space-separated `v1,<base64>` entries);
- signed content is `${id}.${timestamp}.${rawBody}`, HMAC-SHA256, keyed with the base64-decoded secret after stripping a leading `v1,whsec_` or `whsec_`.

- [ ] **Step 1: Write the failing tests**

  `standardWebhook.test.ts`: sign a body in the test with a known throwaway secret. Cases:
  - accepts a valid signature;
  - accepts the secret with and without the `v1,whsec_` prefix;
  - accepts when one of several entries matches;
  - rejects a changed body, a wrong secret, a missing header, an entry without `v1,`, a timestamp more than 300 s old or more than 300 s in the future, and a non-numeric timestamp.

  The comparison must use `timingSafeEqual` on equal-length buffers; a length mismatch is false, not an exception.

  `authEmailCopy.test.ts`:
  - `signup` and `magiclink` produce a subject and HTML containing the 6-digit code, with Myanmar and English text in one email, and **no sign-in link**: no `/auth/v1/verify`, no `token_hash` value, no `redirect_to`. The plain footer link to `EMAIL_FOOTER_URL` is allowed;
  - `recovery`, `invite` and `reauthentication` produce the staff copy;
  - `email_change` produces two messages, each with its own code.

  `send-email.test.ts`: mock `@/lib/email` `sendEmail` and the timed admin client's `rpc("consume_rate_limit")`. Cases:
  - bad signature → 401 `{ error: { http_code: 401, … } }`, nothing sent, no rate-limit call;
  - unlisted type (e.g. `password_changed_notification`) → 400, nothing sent;
  - `signup` within limits → 200 `{}`, one email to `user.email` containing `email_data.token`;
  - hour cap reached (`consume_rate_limit` → false) → 429 `{ error: { http_code: 429 } }`, nothing sent;
  - the rate-limit key is `authmail:signin:h:<hex>`, and `<hex>` is **not** the email or its plain SHA-256 (it's the HMAC with `RATE_LIMIT_HMAC_SECRET`);
  - `recovery` counts under `staff`, not `signin`;
  - `email_change` sends two emails, the current-address code (per the Task 1 finding) to `user.email` and the new-address code to `user.new_email`, with each address counted under its own `email_change` key (3 per day);
  - `sendEmail` returns false → 500 `{ error: { http_code: 500 } }`. This never answers success without sending;
  - no `console.*` call contains the code or the address.

- [ ] **Step 2: Run them and confirm they fail**

  Run: `npx vitest run src/__tests__/lib/auth src/__tests__/api/internal`. Expected: FAIL.

- [ ] **Step 3: Implement**

  `src/lib/auth/standardWebhook.ts`:
```ts
import { createHmac, timingSafeEqual } from "crypto";

const TOLERANCE_S = 300;

export function verifyStandardWebhook(opts: {
  secret: string; id: string | null; timestamp: string | null; signature: string | null;
  body: string; nowSeconds?: number;
}): boolean {
  const { id, timestamp, signature, body } = opts;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > TOLERANCE_S) return false;

  const key = Buffer.from(opts.secret.replace(/^v1,/, "").replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();

  return signature.split(" ").some((entry) => {
    const [version, sig] = entry.split(",", 2);
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

  `src/lib/auth/authEmailLimits.ts`:
```ts
import { createHmac } from "crypto";

export type AuthEmailType = "signup" | "magiclink" | "recovery" | "invite" | "reauthentication" | "email_change";
export type LimitGroup = "signin" | "staff" | "email_change";

export const GROUP: Record<AuthEmailType, LimitGroup> = {
  signup: "signin", magiclink: "signin",
  recovery: "staff", invite: "staff", reauthentication: "staff",
  email_change: "email_change",
};

/** [windowSeconds, limit, label]: mobile spec 4.1. */
export const CAPS: Record<LimitGroup, Array<[number, number, string]>> = {
  signin: [[3600, 5, "h"], [86400, 20, "d"]],
  staff: [[3600, 5, "h"], [86400, 20, "d"]],
  email_change: [[86400, 3, "d"]],
};

/** An HMAC, not a plain hash: a hash of an email address can be reversed. */
export function emailKey(email: string): string {
  return createHmac("sha256", process.env.RATE_LIMIT_HMAC_SECRET!).update(email.trim().toLowerCase()).digest("hex");
}
```

  `src/lib/auth/authEmailCopy.ts`: plain bilingual HTML using `FROM_EMAIL` and `EMAIL_FOOTER_URL` from `src/lib/email.ts`.
  - Buyer code: subject `KuuNyi sign-in code / KuuNyi ဝင်ရောက်ရန်ကုဒ်: {code}`, a large code, "expires in 10 minutes", and "if you didn't ask for this, ignore this email". **No link.**
  - Staff types: short copy. Recovery and invite include the verify link `${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/verify?token=${token_hash}&type=${type}&redirect_to=${encodeURIComponent(redirect_to)}`. Use the Supabase URL, **not** `email_data.site_url`, which is the app's site URL. Reauthentication shows the code.

  Use the same Myanmar wording style as the existing confirmation emails. Mark the new Myanmar strings for native review in the PR.

  `src/app/api/internal/auth/send-email/route.ts`:
  1. `export const dynamic = "force-dynamic"`.
  2. Read the body with `await request.text()`.
  3. Verify the signature with `SUPABASE_SEND_EMAIL_HOOK_SECRET`. On failure → 401.
  4. Parse the JSON. A type that isn't in `GROUP` → 400; log the type only.
  5. For each recipient address, run every cap for its group via `rpc("consume_rate_limit", { p_key: \`authmail:${group}:${label}:${emailKey(addr)}\`, p_window_seconds, p_limit })`. Any false → 429. An RPC error → 503.
  6. Send each message with `sendEmail`. Any false → 500.
  7. Return `NextResponse.json({})`.

  Errors are `NextResponse.json({ error: { http_code, message } }, { status: http_code })`.

- [ ] **Step 4: Run the tests and confirm they pass**

  Same command. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/auth src/app/api/internal src/__tests__/lib/auth src/__tests__/api/internal
git commit -m "feat(auth): Send Email Hook — signed, per-email capped, bilingual codes via Resend"
```

---

### Task 9: `/account` sign-in page and middleware matcher

**Files:**
- Create: `src/app/(public)/account/page.tsx` (server component wrapper), `src/app/(public)/account/AccountSignIn.tsx` (client view), `src/app/(public)/account/accountFlow.ts` (pure state machine)
- Modify: `src/middleware.ts` (matcher only)
- Test: `src/__tests__/account/accountFlow.test.ts`, `src/__tests__/account/AccountSignIn.test.tsx` (static render), `src/__tests__/middleware.test.ts` (extend)

**No new dependency.** The repo has no Testing Library or DOM environment (`vitest.config.ts` runs `node`). Put every decision in a pure reducer, `accountFlow.ts`: `(state, event) => { state, effects }`, where effects are plain descriptions like `{ type: "signOutLocal" }` or `{ type: "postProfile", attempt: 2 }`. Unit-test the reducer. `AccountSignIn.tsx` only runs the effects (Supabase calls, `fetch`) and renders the state. Test it with `react-dom/server` static rendering, as the existing `.test.tsx` files do: each state renders its fields and bilingual text.

States:
1. **Loading.** On mount, `GET /api/account/profile`:
   - 200 → state 4;
   - 401 → state 2;
   - 403 `FORBIDDEN` → the staff message from state 3 (a staff member already signed in on this host), **without** signing out. That session is their admin session; signing it out would log them out of `/admin`;
   - 503 → "try again".
2. **Email.** A field (trimmed and lower-cased before sending) and "Send code". The button calls `createClient().auth.signInWithOtp({ email, options: { shouldCreateUser: true } })`. An error whose status is 429 shows "too many codes, try later". On success go to state 3.
3. **Code.** A 6-digit field, plus "Use another email" and "Resend". Submitting calls `verifyOtp({ email, token, type: "email" })`, then `POST /api/account/profile`:
   - 200 or 201 → state 4;
   - 403 with `reason: "staff"` → sign out locally and show: "This address belongs to a staff account. Use a different email to buy tickets." (design 4.4);
   - 403 for another reason → sign out locally, generic error;
   - 503 → retry the `POST` up to twice with back-off, then "try again".
4. **Signed in.** Shows the account email and a "Sign out" button, which calls `signOut({ scope: "local" })`.

All text is Myanmar and English, like `/status`. Never put the code in the URL or in logs.

- [ ] **Step 1: Write the failing tests**
  - `accountFlow.test.ts`: every transition above, through the reducer. Cover:
    - the 403 staff path and its `signOutLocal` effect;
    - the 503 retry effects (attempts 1–2, then "try again");
    - the email is trimmed and lower-cased in the `sendCode` effect;
    - a 429 from `sendCode` shows the "too many codes" state;
    - no state or effect ever carries the code except the single `verifyCode` effect.
  - `AccountSignIn.test.tsx`: split the view into a presentational `AccountView({ state, on… })` that takes the state as a prop; effects don't run under `react-dom/server`. Static-render `AccountView` for each state (email, code, signed in, staff message) and check the expected fields and Myanmar + English text.
  - In the reducer test, also check that the state-1 403 produces **no** `signOutLocal` effect, while the state-3 staff 403 does.
  - The page is also listed in the `/account` row of Task 12's staging test, which is the real end-to-end check.

  **Note:** `(public)/layout.tsx` also renders `WalkInNotice` (the Sky Festival pop-up), so it appears on `/account` too. Leave it.
  - `middleware.test.ts`: `config.matcher` includes `/account` and `/account/:path*`. A `GET /account` on a tenant host runs through the session refresh without a redirect: it's not a staff page, so #471's password rule doesn't apply.

- [ ] **Step 2: Run them and confirm they fail**

  Run: `npx vitest run src/__tests__/account src/__tests__/middleware.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the page and add `"/account", "/account/:path*"` to `config.matcher` in `src/middleware.ts`. Change nothing else in middleware.

- [ ] **Step 4: Run the tests and confirm they pass**

  Same command. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add "src/app/(public)/account" src/middleware.ts src/__tests__/account src/__tests__/middleware.test.ts
git commit -m "feat(account): email-code sign-in page for buyers"
```

---

### Task 10: Local Supabase config

**Files:**
- Modify: `supabase/config.toml`

- [ ] **Step 1: Set**
  - `[auth.email] enable_confirmations = true`, `otp_length = 6`, `otp_expiry = 600`, `double_confirm_changes = true` (Secure email change).
  - `[auth.rate_limit] email_sent = 30`, so local testing isn't stopped at 2 per hour.
  - `[auth.hook.send_email]` with `uri = "http://host.docker.internal:3005/api/internal/auth/send-email"` and `secrets = "env(SUPABASE_SEND_EMAIL_HOOK_SECRET)"`, committed **commented out** with a note on how to turn it on. Task 1 found that while the block is present, `supabase stop`, `start` and `status` all fail if the variable is unset, even with `enabled = false`. A developer uncomments it locally to test the hook. The secret goes in a gitignored `supabase/.env` in `v1,whsec_<base64>` form, and the same value goes in `.env.local`. Never commit it or print it.
  - Local templates `[auth.email.template.magic_link]` and `[auth.email.template.confirmation]` point to a committed `supabase/templates/email-code.html` that shows `{{ .Token }}`, so the hook-off path also sends a code and not a link.

- [ ] **Step 2: Restart the local stack and sign in end to end**

  `npx supabase stop && npx supabase start`, then `npm run dev`.
  1. **Hook off** (the committed config): open `http://localhost:3005/account?tenant=brave` and sign in with a new `@example.test` address, reading the code in the local mail catcher. Confirm a `buyer_profiles` row exists.
  2. **Hook on** (local only; put `RATE_LIMIT_HMAC_SECRET` in `.env.local` too, or `createHmac` throws first and you test the wrong failure): confirm the hook route receives the request and verifies its signature. With `RESEND_API_KEY` unset locally, `sendEmail` returns false and the hook answers 500. Sign-in then fails with an error, which is the correct "never answer success without sending" behaviour. Record what you saw. Real delivery is tested on staging (Task 12).
  3. Confirm a staff password sign-in at `/login?tenant=brave` still reaches `/admin/dashboard`.
  4. Confirm `/register` still creates a tenant. It creates its owner with the service role, so confirmations being on must not block it; if it does, stop and report.

- [ ] **Step 3: Commit**
```bash
git add supabase/config.toml supabase/templates/email-code.html
git status --short supabase/   # supabase/.env must NOT appear; add it to .gitignore if it does
git commit -m "chore(supabase): local email confirmations, 10-minute codes, Send Email Hook settings"
```

---

### Task 11: Correct the design on email change

**Files:**
- Modify: `docs/superpowers/specs/2026-11-20-account-bound-tickets-design.md` (section 4.1, the "Email change is not supported" bullet)

- [ ] **Step 1: Replace the bullet with:**
  > **Email change is not offered**, but Supabase can't switch off `auth.updateUser({ email })`. "Secure email change" stays on, so both addresses must confirm, and an `AFTER UPDATE OF email` trigger on `auth.users` keeps `buyer_profiles.email` equal to the auth email in the same transaction (mobile spec 4.2). `requireBuyer` still fails closed (401) if they ever differ.
- [ ] **Step 2: Commit**
```bash
git add docs/superpowers/specs/2026-11-20-account-bound-tickets-design.md
git commit -m "docs(spec): email change follows the mobile spec (secure change + sync trigger)"
```

---

### Task 12: Full verification, PR, and owner steps

- [ ] **Step 1: Run everything, judged by exit code**
```bash
npx tsc --noEmit; echo TSC=$?
npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . --ext .ts,.tsx src; echo LINT=$?   # nested worktree: next lint clashes with the parent config
npm test; echo TEST=$?
npm run test:db; echo DB=$?     # local stack running
npm run build; echo BUILD=$?    # no dev server running from this folder
```
  Every value must be 0. Report the counts.

- [ ] **Step 2: Codex review**

  Run `codex review --base origin/dev` locally. Post its findings verbatim on the PR, signed `_🤖 Reviewed by Codex_`. Fix any P1 or P2, post a reply signed `_🤖 Addressed by [Claude Code](https://claude.com/claude-code)_`, and repeat until clean. The repo is public: no exploit recipes in comments.

- [ ] **Step 3: Open the PR into `dev`**

  Title: `feat: buyer accounts — email-code sign-in (account-bound tickets Plan 2)`. The body must have:
  - the Task 1 findings;
  - whether the Before User Created hook was built (A or B);
  - every gate listed below, marked **Required** for the owner;
  - the line "The Send Email Hook stays off in every project until the gates are done; it is what turns buyer codes on."

  Never merge it yourself.

- [ ] **Step 4: Owner steps. These are not for the implementer; list them in the PR in this order.**
  1. **Advisories.**
     - Resolve and close the open private security advisories (the Security tab has the steps for each). Any secret rotated there is set with `printf`, not `echo`.
  2. **Resend.** Confirm SPF, DKIM and DMARC on the sending domain.
  3. **Dev DB.** Review the migration diff, then apply it (`supabase db push`, after a dry run). Staging reads this database.
  4. **Vercel env (Preview / staging only).** Set `SUPABASE_SEND_EMAIL_HOOK_SECRET` and `RATE_LIMIT_HMAC_SECRET` with `printf`. Don't set them in Production.
  5. **Staging protection.** Exempt `/api/internal/auth/send-email` from Vercel Deployment Protection, or add the bypass token to the hook URL (`x-vercel-protection-bypass` query parameter).
  6. **Merge to `dev`, then promote to `staging`**, so the hook route is live before Supabase calls it.
  7. **Dev Supabase project, Auth settings**, in this order:
     1. Confirm email on.
     2. Email OTP length 6 and expiry 600 s.
     3. Secure email change on.
     4. Security notifications off.
     4b. Confirm the dev project's own Magic Link and Confirm signup templates don't show `{{ .Token }}`. "Hook off = no buyer codes" holds only then.
     5. If Task 1 found the project-wide email limit still applies with the hook on: raise "Rate limit for sending emails" so it isn't one shared hourly cap.
     6. If built, the Before User Created hook → `public.hook_before_user_created`.
     7. **Last**, because this is what turns buyer codes on: Send Email Hook → `https://staging.kuunyi.com/api/internal/auth/send-email` with the same secret. To undo, switch the hook off.
  8. **Dev database check.** As `authenticated` through PostgREST, the three new tables answer 42501. This proves the migration's `REVOKE`, which the local test setup hides.
  9. **Staging test** (mobile spec 14, sign-in part):
     - Code emails arrive with a 6-digit code and no sign-in link.
     - The per-email cap answers 429 after 5 codes in an hour, including when `/auth/v1/otp` is called directly.
     - A staff email gets the staff message on `/account`, and a staff password sign-in still works.
     - A second session of a new buyer is ended when the first one creates the profile.
     - `email_change` codes reach the right addresses.
     - If the Before User Created hook was built: a public `signUp({ email, password })` is refused, and staff creation through the service role still works. The mobile spec requires this proof on staging.
  10. **Production: nothing.** Releases to `main` are frozen. When they resume, production needs this migration, the secrets and the hook before the code, and email codes switched on last.

---

## Findings (filled in by Task 1)

| Question | Result | Consequence |
|---|---|---|
| `amr` of a first-ever email-code session | `["otp"]`, for a new and an existing email; the token has a `session_id` claim; the user is email-confirmed after `verifyOtp` | `isEmailCodeSession` rule holds |
| Is there any separate "email codes" switch, or does the Email provider alone allow `signInWithOtp`? | No switch: `signInWithOtp` + `verifyOtp` worked with only the Email provider on | gate wording stands: the Send Email Hook is the switch |
| Does the project-wide `email_sent` limit still apply with the Send Email Hook on? | **Can't be tested locally**: the CLI sets `GOTRUE_RATE_LIMIT_EMAIL_SENT=360000` whatever `email_sent` says (the setting needs real SMTP) | owner checks the dev project's limit (Task 12 step 7.5) |
| Action type for a new email / an existing email | `signup` / `magiclink`, each with a 6-digit `email_data.token` | Task 8 groups as planned |
| Types for reset, invite, email change | `recovery`, `invite`, `email_change` (6-digit codes); every request carries `webhook-signature` | as planned |
| Which `email_change` code goes to which address | `email_data.token` → the **current** address (`user.email`); `email_data.token_new` → the **new** address (`user.new_email`). Verified: both `verifyOtp(type: "email_change")` calls succeed only with that pairing, and the email changes | Task 8 routing |
| Before User Created: can a public password sign-up be told apart? | **No (B).** Its event has the same keys and values as an email-code sign-up; no password field is sent. `admin.createUser` doesn't fire the hook at all; `inviteUserByEmail` does | **skip Task 3 Step 7 and the hook line in Task 10**; `ensureBuyerProfile`'s reset covers it (mobile spec 4.1 allows this) |
| `auth.admin.signOut(jwt, "others")` ends the other session and keeps this one | Yes: the other session's refresh fails, the caller's still works | step 8 of `ensureBuyerProfile` as planned |
| Local config gotcha | With `[auth.hook.send_email]` present, `supabase stop`/`start`/`status` all **fail** if its `env()` secret is unset, even when the hook is disabled | Task 10: keep the whole `[auth.hook.send_email]` block **commented out** in the committed config, with instructions to uncomment |
