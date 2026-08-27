# Event Interest List with Priority Enrollment Window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let people register interest in an event before ticket sales open, and give them a scheduled head start to enroll before the public.

**Architecture:** A standalone `event_interest` table holds one hashed bearer token per person per intake. `intakes.priority_open_at` schedules the window. The two enrollment RPCs — already the sole enforcer of `enrollment_open_at`, and already service_role-only — gain a token-hash parameter and consult the interest table instead of refusing outright. Nothing in the payment, ticket, or auto-cancel paths is touched.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase/PostgreSQL, Vitest (unit + DB integration), Resend.

**Spec:** [2026-08-26-event-interest-priority-window-design.md](../specs/2026-08-26-event-interest-priority-window-design.md) (v6). The spec is authoritative; where this plan and the spec disagree, stop and ask.

---

## Before you start

Read these first. Several tasks fail in confusing ways without them:

1. **`supabase/migrations/20260719100000_restrict_enrollment_rpc_privileges.sql`** — why the enrollment RPCs are service_role-only, and why every new function needs explicit `REVOKE`s. Task 5 recreates those functions and *will* silently re-open them to `anon` if you skip the privilege repair.
2. **`supabase/migrations/076_fix_stored_functions.sql`** — the current bodies of `submit_enrollment` and `submit_cart_enrollment`. Task 5 is a careful edit of these, not a rewrite.
3. **`src/__tests__/db/seat-restoration.db.test.ts`** — the DB-test house style: `pg.Pool` for SQL, tracked fixture ids recorded at creation, teardown in `afterEach`.
4. **`src/__tests__/db/setup.ts`** — DB tests refuse to run against anything non-local. You need `.env.test.local` and a running local stack.

**Project rules that apply throughout:**
- Never push to `main` or `staging`. Work on `feat/event-interest-priority-window` (already checked out from `dev`).
- Migrations go to the **dev** database (`fnfvwzwrdsnmwxunciti`) only. Show the diff before any push. Production is a separate gated step, not part of this plan.
- `npm run build` before pushing. Judge by **exit code**, not output text.

**Terminology, because the schema is confusing:** an **intake** is the event. A **class** is a ticket tier inside it (`classes` is `UNIQUE (intake_id, level)`). Interest and the priority window live on the intake; public sale times stay on the class.

---

## File Structure

**Migrations (create):**
- `supabase/migrations/20260827120000_event_interest_priority_window.sql` — tables, trigger, helper functions, privileges
- `supabase/migrations/20260827120100_enrollment_rpc_priority_token.sql` — the two RPCs, dropped and recreated with the token parameter, privileges repaired

**Server libs (create):**
- `src/lib/interest/token.ts` — mint a token, hash it, derive the display prefix
- `src/lib/interest/ipHash.ts` — canonicalise a client address, HMAC it
- `src/server/interest/registerInterest.ts` — the whole signup/rotation orchestration, so the route stays thin and this stays testable

**Server libs (modify):**
- `src/lib/email.ts` — two new templates beside the existing four

**API routes (create):**
- `src/app/api/public/interest/route.ts`
- `src/app/api/admin/interest/[intakeId]/route.ts` — list + CSV export
- `src/app/api/admin/interest/[intakeId]/invite/route.ts`
- `src/app/api/admin/interest/entry/[id]/route.ts` — revoke + resend for one record

**API routes (modify):**
- `src/app/api/public/enroll/route.ts` — accept and forward `priority_token`
- `src/app/api/public/enroll/[slug]/route.ts` — return `priority_open_at` and covered tiers
- `src/app/api/intakes/[id]/route.ts` — accept `priority_open_at`
- `src/server/enrollment/createEnrollment.ts`, `createCartEnrollment.ts` — pass the hash to the RPC

**UI (create):**
- `src/app/(public)/enroll/[slug]/interest/page.tsx`

**UI (modify):**
- `src/app/(public)/enroll/[slug]/page.tsx` — fragment capture + interest CTA
- `src/app/(public)/enroll/[slug]/checkout/page.tsx` — carry the token into the POST
- `src/app/admin/intakes/[id]/page.tsx` — `priority_open_at` field + interest table

**Tests (create):**
- `src/__tests__/db/priority-window.db.test.ts`
- `src/__tests__/db/interest-rate-limit.db.test.ts`
- `src/__tests__/interest/token.test.ts`
- `src/__tests__/interest/ipHash.test.ts`
- `src/__tests__/interest/registerInterest.test.ts`
- `src/__tests__/api/public/interest-route.test.ts`

---

## Task 1: Token and IP-hash helpers

Pure functions, no I/O. Do these first — everything else imports them.

**Files:**
- Create: `src/lib/interest/token.ts`
- Create: `src/lib/interest/ipHash.ts`
- Test: `src/__tests__/interest/token.test.ts`
- Test: `src/__tests__/interest/ipHash.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/__tests__/interest/token.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mintPriorityToken, hashPriorityToken } from "@/lib/interest/token";

describe("hashPriorityToken", () => {
  it("returns lowercase hex sha256, matching the column CHECK", () => {
    const h = hashPriorityToken("abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(hashPriorityToken("abc")).toBe(hashPriorityToken("abc"));
  });
});

describe("mintPriorityToken", () => {
  it("produces a url-safe token with no padding", () => {
    const { token } = mintPriorityToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a distinct token each call", () => {
    const seen = new Set(Array.from({ length: 50 }, () => mintPriorityToken().token));
    expect(seen.size).toBe(50);
  });

  it("returns a hash and prefix consistent with the token", () => {
    const { token, tokenHash, tokenPrefix } = mintPriorityToken();
    expect(tokenHash).toBe(hashPriorityToken(token));
    expect(tokenPrefix).toBe(token.slice(0, 8));
  });
});
```

`src/__tests__/interest/ipHash.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { canonicalIp, hashIp } from "@/lib/interest/ipHash";

describe("canonicalIp", () => {
  it("lowercases IPv6", () => {
    expect(canonicalIp("2001:DB8::1")).toBe("2001:db8::1");
  });

  it("reduces IPv4-mapped IPv6 to the IPv4 form", () => {
    expect(canonicalIp("::ffff:192.168.1.1")).toBe("192.168.1.1");
  });

  it("strips surrounding whitespace and brackets", () => {
    expect(canonicalIp(" [2001:db8::1] ")).toBe("2001:db8::1");
  });

  it("returns 'unknown' for empty input, so a missing address still buckets", () => {
    expect(canonicalIp("")).toBe("unknown");
    expect(canonicalIp(null)).toBe("unknown");
  });
});

describe("hashIp", () => {
  it("returns lowercase hex sha256, matching the column CHECK", () => {
    expect(hashIp("1.2.3.4", "secret")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives one bucket per client regardless of representation", () => {
    expect(hashIp("::ffff:1.2.3.4", "s")).toBe(hashIp("1.2.3.4", "s"));
  });

  it("changes with the secret", () => {
    expect(hashIp("1.2.3.4", "a")).not.toBe(hashIp("1.2.3.4", "b"));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- src/__tests__/interest/token.test.ts src/__tests__/interest/ipHash.test.ts`
Expected: FAIL — cannot resolve `@/lib/interest/token`.

- [ ] **Step 3: Implement**

`src/lib/interest/token.ts`:

```typescript
// Priority-access tokens. Deliberately a separate name from hashApiKey():
// this is not an API key, and a shared name makes the credential's purpose
// unreadable at the call site.
import { createHash, randomBytes } from "crypto";

/** Bytes of entropy per token. 32 is the same order as a session id. */
const TOKEN_BYTES = 32;

/** How much of the raw token is kept in the clear for admin display. */
const PREFIX_LENGTH = 8;

export function hashPriorityToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface MintedToken {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
}

export function mintPriorityToken(): MintedToken {
  // base64url: safe in a URL fragment without escaping.
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenHash: hashPriorityToken(token),
    tokenPrefix: token.slice(0, PREFIX_LENGTH),
  };
}
```

`src/lib/interest/ipHash.ts`:

```typescript
// Pseudonymised client address for the signup rate limiter.
//
// Keyed HMAC rather than sha256(ip + salt): concatenation leaves the
// delimiter and ordering as unstated convention that a later edit can change
// without anyone noticing, which silently resets every bucket.
//
// This is a cost and reputation control, NOT an authorization boundary.
// Forwarded headers are attacker-influenced.
import { createHmac } from "crypto";

export function canonicalIp(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  let ip = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!ip) return "unknown";
  ip = ip.toLowerCase();
  // IPv4-mapped IPv6 and one client must not occupy two buckets.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return mapped[1];
  return ip;
}

export function hashIp(raw: string | null | undefined, secret: string): string {
  return createHmac("sha256", secret).update(canonicalIp(raw)).digest("hex");
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- src/__tests__/interest/token.test.ts src/__tests__/interest/ipHash.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/interest src/__tests__/interest && git commit -m "feat(interest): add priority-token and IP-pseudonym helpers"
```

---

## Task 2: Schema migration

Tables, the cross-table window trigger, the gate function, and the rate-limit function. No application code consumes any of it yet.

**Files:**
- Create: `supabase/migrations/20260827120000_event_interest_priority_window.sql`

- [ ] **Step 1: Write the migration**

Transcribe the SQL from the spec's *Data model*, *Signup rate limiting*, and *The gate* sections into one file, in this order:

1. `ALTER TABLE public.intakes ADD COLUMN priority_open_at timestamptz;`
2. `ALTER TABLE public.intakes ADD CONSTRAINT intakes_id_tenant_uniq UNIQUE (id, tenant_id);`
3. `CREATE TABLE public.event_interest (...)` — every column and CHECK exactly as specced, including `last_link_attempt_at`, the composite FK to `intakes (id, tenant_id)`, and the `event_interest_email_canonical` CHECK.
4. Its three indexes, `ENABLE ROW LEVEL SECURITY`, no policies.
5. `CREATE TABLE public.interest_signup_attempts (...)` + two indexes + RLS, no policies.
6. `CREATE FUNCTION public.assert_priority_window_valid(uuid)` plus the two triggers that call it.
7. `CREATE FUNCTION public.priority_access_granted(uuid, text)` — **not** `SECURITY DEFINER`.
8. `CREATE FUNCTION public.consume_interest_signup_slot(...)`.
9. Privileges — this is the part that is easy to skip and expensive to miss:

```sql
REVOKE ALL ON FUNCTION public.assert_priority_window_valid(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.priority_access_granted(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.consume_interest_signup_slot(uuid, text, integer, integer, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_interest_signup_slot(uuid, text, integer, integer, interval)
  TO service_role;
```

`priority_access_granted` and `assert_priority_window_valid` are only ever called from inside other functions owned by the same role, which retains `EXECUTE` implicitly — they need no grant at all. `consume_interest_signup_slot` is called directly by the app, so it needs `service_role`.

10. `NOTIFY pgrst, 'reload schema';`

Wrap the whole file in `BEGIN; ... COMMIT;`, matching the house style in `076_fix_stored_functions.sql`.

- [ ] **Step 2: Show the diff before pushing anything**

Run: `npx supabase db diff`
Expected: the objects above and nothing else. **If it shows changes you did not write, stop.** A stray diff means the local schema drifted from migrations and pushing would carry that drift to dev.

- [ ] **Step 3: Apply locally and verify the privilege posture**

```bash
npx supabase migration up
```

Do **not** run `npm run db:reset`. Project rules forbid `supabase db reset` without
explicit confirmation from the user, and `migration up` applies pending migrations
without wiping local data. If you believe a reset is genuinely required, STOP and ask.

Then confirm the revokes actually took, rather than assuming:

```sql
SELECT proname,
       has_function_privilege('anon',   p.oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
FROM pg_proc p
WHERE proname IN ('priority_access_granted','consume_interest_signup_slot','assert_priority_window_valid');
```

Expected: `anon` and `auth` both `false` on all three rows.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260827120000_event_interest_priority_window.sql
git commit -m "feat(interest): add event_interest schema, window trigger, and gate function"
```

---

## Task 3: DB tests for the window trigger and the gate

The gate is database logic under concurrency. A mocked test proves nothing about it — this is the suite that matters.

**Files:**
- Create: `src/__tests__/db/priority-window.db.test.ts`

- [ ] **Step 1: Write the failing tests**

Follow `seat-restoration.db.test.ts` exactly for structure: `pg.Pool`, a `Tracked` fixture record populated **at creation** (not teardown), cleanup in `afterEach`. Fixture builders you need: `createTenant`, `createIntake(tenantId, priorityOpenAt)`, `createClass(intakeId, tenantId, { enrollmentOpenAt, seatTotal })`, `createInterest(intakeId, tenantId, email)` returning the raw token.

Cover, one `it()` each:

*Window trigger*
1. Setting `priority_open_at` later than a tier's `enrollment_open_at` raises.
2. The same violation introduced from the **class** side (editing `enrollment_open_at` earlier) also raises — the trigger fires from both directions.
3. A tier with `enrollment_open_at IS NULL` is exempt and does not raise.

*Gate — `priority_access_granted`*
4. Valid token, `now() >= priority_open_at` → true.
5. Valid token, `priority_open_at` in the future → false.
6. Unknown token → false.
7. Revoked token (`revoked_at` set) → false.
8. Token from intake A against a class of intake B → false.
9. Superseded token inside its grace → true.
10. Superseded token after `superseded_expires_at` → false.

Assert on the function directly:

```typescript
const [{ granted }] = await sql<{ granted: boolean }>(
  `SELECT public.priority_access_granted($1, $2) AS granted`,
  [classId, hashPriorityToken(rawToken)],
);
expect(granted).toBe(true);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:db -- src/__tests__/db/priority-window.db.test.ts`
Expected: FAIL. If instead it errors on missing env vars, you need `.env.test.local` — see `src/__tests__/db/setup.ts`. Do not skip the suite: a skipped integration test reports green and proves nothing.

- [ ] **Step 3: Make them pass**

Task 2's migration should already satisfy every case. If one fails, fix the **migration** and re-apply with `npx supabase migration up` — do not weaken the test, and do not reset the database.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/db/priority-window.db.test.ts
git commit -m "test(interest): cover the window trigger and gate function"
```

---

## Task 4: DB test for rate-limit atomicity

Split from Task 3 because it is the one test whose *sequential* version passes against a broken implementation.

**Files:**
- Create: `src/__tests__/db/interest-rate-limit.db.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("admits exactly the limit when requests arrive concurrently", async () => {
  const LIMIT = 3;
  const ATTEMPTS = 12;

  // Separate connections: one pooled client cannot contend with itself, and
  // a single-connection version of this test passes against a
  // count-then-insert implementation, which is the bug it exists to catch.
  const results = await Promise.all(
    Array.from({ length: ATTEMPTS }, async () => {
      const client = await pool.connect();
      try {
        const { rows } = await client.query(
          `SELECT public.consume_interest_signup_slot($1, $2, $3, $4, $5) AS ok`,
          [intakeId, ipHash, LIMIT, 100, "1 hour"],
        );
        return rows[0].ok as boolean;
      } finally {
        client.release();
      }
    }),
  );

  expect(results.filter(Boolean)).toHaveLength(LIMIT);
});
```

Also cover: the global (cross-intake) limit throttles independently of the per-intake one, and rows older than the window are pruned rather than counted.

- [ ] **Step 2: Run to verify it fails, then passes**

Run: `npm run test:db -- src/__tests__/db/interest-rate-limit.db.test.ts`

The advisory lock in Task 2 should make it pass. **Sanity-check the test itself**: temporarily replace `pg_advisory_xact_lock` with a no-op, re-run, and confirm the test goes red. A concurrency test that passes both ways is not testing anything. Restore the lock afterwards.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/db/interest-rate-limit.db.test.ts
git commit -m "test(interest): prove rate-limit consumption is atomic under concurrency"
```

---

## Task 5: Enrollment RPC migration — the dangerous one

Read `20260719100000_restrict_enrollment_rpc_privileges.sql` before writing a line. This task recreates two `SECURITY DEFINER` functions that are on the live payment path.

**Files:**
- Create: `supabase/migrations/20260827120100_enrollment_rpc_priority_token.sql`

- [ ] **Step 1: Write the migration**

Base both bodies on `076_fix_stored_functions.sql`. Copy them verbatim, then make exactly these changes:

**`submit_enrollment`** — add a fourth parameter `p_priority_token_hash text DEFAULT NULL`, and replace the open-window guard:

```sql
  -- was: IF ... THEN RETURN ... 'ENROLLMENT_NOT_OPEN' ... END IF;
  IF v_class.enrollment_open_at IS NOT NULL AND now() < v_class.enrollment_open_at THEN
    IF NOT public.priority_access_granted(v_class.id, p_priority_token_hash) THEN
      RETURN jsonb_build_object('success', false, 'error', 'ENROLLMENT_NOT_OPEN');
    END IF;
  END IF;
```

**`submit_cart_enrollment`** — add `p_priority_token_hash text DEFAULT NULL` as the third parameter and make the same substitution inside the Phase 1 validation loop. Leave Phase 1's all-or-nothing behaviour alone: it returns on the first failure, before Phase 2 creates anything, and that is the specced semantics.

Then, in this order:

```sql
-- Drop the OLD signatures explicitly. A DEFAULT parameter creates a new
-- overload rather than replacing the function, and overload accumulation is
-- exactly what 20260719100000 was written to clean up.
DROP FUNCTION IF EXISTS public.submit_enrollment(uuid, text, integer);
DROP FUNCTION IF EXISTS public.submit_cart_enrollment(jsonb, uuid);

-- ... CREATE both new signatures here ...

-- Repair privileges. A fresh CREATE restores PostgreSQL's default
-- EXECUTE TO PUBLIC, silently re-opening what 20260719100000 closed.
REVOKE ALL ON FUNCTION public.submit_enrollment(uuid, text, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_enrollment(uuid, text, integer, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.submit_cart_enrollment(jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_cart_enrollment(jsonb, uuid, text)
  TO service_role;

-- Fail closed if anything is missing.
DO $$
BEGIN
  IF to_regprocedure('public.submit_enrollment(uuid,text,integer,text)') IS NULL THEN
    RAISE EXCEPTION 'submit_enrollment(uuid,text,integer,text) is missing';
  END IF;
  IF to_regprocedure('public.submit_cart_enrollment(jsonb,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'submit_cart_enrollment(jsonb,uuid,text) is missing';
  END IF;
  IF to_regprocedure('public.submit_enrollment(uuid,text,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'old submit_enrollment overload survived the drop';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Apply and verify the privilege posture**

```bash
npx supabase migration up
```

Do **not** run `npm run db:reset`. Project rules forbid `supabase db reset` without
explicit confirmation from the user, and `migration up` applies pending migrations
without wiping local data. If you believe a reset is genuinely required, STOP and ask.

```sql
SELECT p.oid::regprocedure AS sig,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
FROM pg_proc p
WHERE proname IN ('submit_enrollment','submit_cart_enrollment');
```

Expected: exactly two rows, both `anon = false`. Three rows means an overload survived.

- [ ] **Step 3: Confirm nothing already-working broke**

Run: `npm run test:db`
Expected: the existing seat-restoration suite still passes. The new parameter defaults to `NULL`, so every existing caller is unaffected.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260827120100_enrollment_rpc_priority_token.sql
git commit -m "feat(interest): add priority-token parameter to the enrollment RPCs"
```

---

## Task 6: DB tests for the gate through the RPCs

Task 3 tested the gate function. This tests it where it actually runs — inside a transaction that also decrements seats.

**Files:**
- Modify: `src/__tests__/db/priority-window.db.test.ts`

- [ ] **Step 1: Write the failing tests**

1. `submit_enrollment` with no token before `enrollment_open_at` → `ENROLLMENT_NOT_OPEN`.
2. Same call with a valid token, window open → success, and `seat_remaining` drops by the quantity.
3. Valid token but `enrollment_close_at` has passed → `ENROLLMENT_CLOSED`. A head start does not outlive the sale.
4. Valid token, class full → `CLASS_FULL` / `NOT_ENOUGH_SEATS`. A head start is not a seat guarantee.
5. **Multi-tier cart, one intake-level token** → all tiers enroll on one token.
6. **Cart mixing the token's intake with a foreign one** → the whole call fails and **no** seat is decremented for the token's own tiers. Assert `seat_remaining` is unchanged on every class in the cart, not just that the call returned an error.
7. **Concurrent priority enrollments against the last seat** — two simultaneous calls, one succeeds, one gets `NOT_ENOUGH_SEATS`, and `seat_remaining` lands at 0, never negative.

- [ ] **Step 2: Run**

Run: `npm run test:db -- src/__tests__/db/priority-window.db.test.ts`
Expected: PASS. Test 6 is the one that caught a wrong claim in the spec twice — if it fails, re-read Phase 1 of `submit_cart_enrollment` before changing anything.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/db/priority-window.db.test.ts
git commit -m "test(interest): cover the priority gate through both enrollment RPCs"
```

---

## Task 7: Email templates

**Files:**
- Modify: `src/lib/email.ts`

- [ ] **Step 1: Add two exported template functions**

Place them beside the existing four (`enrollmentConfirmationEmail` and friends) and build both on `baseLayout(content, tenantName, logoUrl)` so they inherit tenant branding.

```typescript
export function interestConfirmationEmail(params: {
  name: string;
  eventName: string;
  link: string;
  windowOpensAt: string;   // already formatted for display
  coveredTiers: string[];  // names the head start actually applies to
  isResend: boolean;
  tenantName?: string;     // baseLayout needs these for tenant branding
  logoUrl?: string;
}): { subject: string; html: string }
```

The body must state (a) the link, (b) that it does not work until `windowOpensAt`, (c) **which tiers** the head start covers — never "early access to this event" when part of the event may already be on sale, and (d) when `isResend`, that any earlier link stops working shortly.

```typescript
export function priorityWindowReminderEmail(params: {
  name: string;
  eventName: string;
  link: string;
  windowOpensAt: string;
  coveredTiers: string[];
  tenantName?: string;
  logoUrl?: string;
}): { subject: string; html: string }
```

This one carries a **freshly minted** link and must say plainly that it supersedes any earlier one.

- [ ] **Step 2: Verify they compile and render**

Run: `npm run build`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/email.ts && git commit -m "feat(interest): add interest confirmation and priority reminder emails"
```

---

## Task 8: registerInterest — signup and rotation

The heart of the feature. Keeping it out of the route makes the ordering and locking testable without HTTP.

**Files:**
- Create: `src/server/interest/registerInterest.ts`
- Test: `src/__tests__/interest/registerInterest.test.ts`

**The two invariants this module exists to hold:**
1. **No token is ever emailed whose hash is not already stored.** Persist, then send. A link that reaches an inbox always works; a failed send costs a notification, never a credential.
2. **The entire rotation decision happens under the row lock, before any mail is sent.** Locking only the write lets two concurrent resends both read the old row, both mint, and both send.

- [ ] **Step 1: Write the failing tests**

Mock the Supabase admin client and `sendEmail`. Assert on *ordering and outcomes*, not on internals:

1. First signup: row is written **before** `sendEmail` is called (assert call order).
2. First signup where `sendEmail` returns `false`: result reports `emailed: false`, the row still exists, and the raw token is still returned so the page can display a working link.
3. First signup where the **insert** fails: `sendEmail` is never called, and the result is an error — not a success.
4. Repeat signup: the response contains **no** raw token.
5. Repeat signup: the previous hash lands in `superseded_token_hash` with a future `superseded_expires_at`.
6. Repeat signup inside the cooldown: no rotation, no send, generic success.
7. Rotation stamps `last_link_attempt_at` **before** the send; on send failure it is cleared so a retry is immediate.
8. Email is normalised — `"  Foo@Example.COM "` looks up and stores as `"foo@example.com"`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- src/__tests__/interest/registerInterest.test.ts`

- [ ] **Step 3: Implement**

Sketch — the ordering is the specification, so follow it literally:

```typescript
export async function registerInterest(input: {
  intakeId: string;
  tenantId: string;
  name: string;
  email: string;
  phone?: string | null;
  ipHash: string;
}): Promise<RegisterInterestResult> {
  const email = input.email.trim().toLowerCase();

  // 1. Rate limit — one serialized DB call, before any write or send.
  const { data: allowed } = await supabase.rpc("consume_interest_signup_slot", {...});
  if (!allowed) return { ok: true, throttled: true };   // generic success

  // 2. Existing record?
  const existing = await findByIntakeAndEmail(input.intakeId, email);

  if (!existing) {
    // FIRST SIGNUP — persist, then send.
    const minted = mintPriorityToken();
    const inserted = await insertInterest({ ...input, email, ...minted });
    if (!inserted) return { ok: false, reason: "WRITE_FAILED" };

    const emailed = await sendInterestEmail(...);       // may fail; token stays valid
    if (emailed) await stampSent(inserted.id);
    return { ok: true, token: minted.token, emailed };
  }

  // ROTATION — everything up to and including the write happens under the
  // row lock inside this RPC; the send comes after it commits.
  const rotated = await supabase.rpc("rotate_interest_token", {
    p_interest_id: existing.id,
    p_new_hash: minted.tokenHash,
    p_new_prefix: minted.tokenPrefix,
    p_grace: GRACE_INTERVAL,
    p_cooldown: COOLDOWN_INTERVAL,
  });
  if (rotated === "COOLDOWN") return { ok: true, emailed: false };  // generic success

  const emailed = await sendInterestEmail(...);
  if (emailed) await stampSent(existing.id);
  else await clearAttempt(existing.id);                 // retry immediately
  return { ok: true, emailed };                          // never returns the token
}
```

**Add `rotate_interest_token` to the Task 2 migration** (amend it, then re-apply — ask the user first if that requires a reset) — the cooldown check, mint-slot write, superseded move and `last_link_attempt_at` stamp must be one transaction under `SELECT ... FOR UPDATE`. Doing this from the application cannot hold the lock across the decision.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- src/__tests__/interest/registerInterest.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/server/interest src/__tests__/interest/registerInterest.test.ts supabase/migrations/20260827120000_event_interest_priority_window.sql
git commit -m "feat(interest): add signup and locked rotation orchestration"
```

---

## Task 9: Public signup route

**Files:**
- Create: `src/app/api/public/interest/route.ts`
- Test: `src/__tests__/api/public/interest-route.test.ts`

- [ ] **Step 1: Write the failing tests**

Follow the existing patterns in `src/__tests__/api/public/`. Cover:

1. `intake_id` belonging to **another tenant** → rejected, and `registerInterest` is never called. This is the cross-tenant write guard; the composite FK does not catch it, because the row would be consistent with the *wrong* tenant.
2. Intake with `priority_open_at` in the past → rejected. Signup closes when the window opens, or anyone can mint themselves a head start on the spot.
3. Intake with `priority_open_at` unset → rejected.
4. Intake where every tier is already public → rejected.
5. Honeypot `__hp` non-empty → fake success, nothing written.
6. First signup → 200 with the token, and the response carries `Cache-Control: no-store`.
7. Repeat signup → 200 **without** a token.
8. Over the rate limit → the same generic success shape as a permitted call. Do not tell a script when it has been throttled.
9. Name/email/phone over the length bounds → 400.

- [ ] **Step 2: Implement**

Use `resolveTenantId()` exactly as `src/app/api/public/form-fields/route.ts` does, then validate the intake with `.eq("tenant_id", tenantId)`. Derive the address with `request.ip ?? request.headers.get("x-forwarded-for")?.split(",")[0]`, run it through `hashIp` with `INTEREST_IP_SECRET`, and hand off to `registerInterest`.

Set the header on every response that can carry a token:

```typescript
return NextResponse.json(body, { status: 200, headers: { "Cache-Control": "no-store" } });
```

Do not log the request or response body on this route, and never log the raw token.

- [ ] **Step 3: Run and commit**

```bash
npm test -- src/__tests__/api/public/interest-route.test.ts
git add src/app/api/public/interest src/__tests__/api/public/interest-route.test.ts
git commit -m "feat(interest): add the public interest signup endpoint"
```

---

## Task 10: Wire the token into enrollment

**Files:**
- Modify: `src/app/api/public/enroll/route.ts`
- Modify: `src/server/enrollment/createEnrollment.ts`
- Modify: `src/server/enrollment/createCartEnrollment.ts`

- [ ] **Step 1: Write the failing tests**

Extend the existing suites in `src/__tests__/enrollment/`. Assert that a `priority_token` in the request reaches the RPC **as a hash, never as the raw token**, and that its absence passes `null`.

- [ ] **Step 2: Implement**

Pull `priority_token` from the POST body, run it through `hashPriorityToken`, and thread it into both server modules as `p_priority_token_hash`. Both already build their RPC arguments in one place.

- [ ] **Step 3: Run and commit**

```bash
npm test -- src/__tests__/enrollment
git add src/app/api/public/enroll/route.ts src/server/enrollment src/__tests__/enrollment
git commit -m "feat(interest): forward the priority token from checkout to the RPCs"
```

---

## Task 11: Public discovery and redemption UI

**Files:**
- Modify: `src/app/api/public/enroll/[slug]/route.ts`
- Create: `src/app/(public)/enroll/[slug]/interest/page.tsx`
- Modify: `src/app/(public)/enroll/[slug]/page.tsx`
- Modify: `src/app/(public)/enroll/[slug]/checkout/page.tsx`

- [ ] **Step 1: Extend the API**

Add the intake's `priority_open_at` to the response, plus the list of tiers the window covers (those with a future `enrollment_open_at`).

- [ ] **Step 2: Add the CTA**

On `[slug]/page.tsx`, show the interest CTA only when **both** hold: `priority_open_at` is set and still in the future, **and** at least one tier still has a future `enrollment_open_at`. Hide it otherwise.

- [ ] **Step 3: Build the signup page**

Name, email (required — it is the delivery channel), optional phone, the `__hp` honeypot field, and copy naming the covered tiers. On success, display the returned link prominently with a "save this link" prompt, and say plainly whether the email went out.

- [ ] **Step 4: Capture the fragment**

This is the security-relevant part. On `[slug]/page.tsx`:

```typescript
useEffect(() => {
  const m = /(?:^|[#&])pa=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (!m) return;
  sessionStorage.setItem(`pa_${slug}`, m[1]);
  // Strip it immediately: keep the credential out of the address bar and out
  // of any history entry created after this point.
  history.replaceState(null, "", window.location.pathname + window.location.search);
}, [slug]);
```

A fragment is never sent to the server, which is the whole reason the link uses `#pa=` rather than `?pa=`. **Never** move the token into a query parameter, a form GET, or a link `href`.

- [ ] **Step 5: Carry it into checkout**

In `checkout/page.tsx`, read `sessionStorage.getItem('pa_' + slug)` and include it as `priority_token` in the enroll POST body — mirroring how `psid` is already threaded through this flow.

- [ ] **Step 6: Verify in the browser**

Start the dev server via the preview tool (not `npm run dev` in a shell), open an event with a live window, and confirm: the link works, the fragment disappears from the address bar, and enrollment succeeds before the public open time.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/public/enroll src/app/\(public\)/enroll
git commit -m "feat(interest): add the interest CTA, signup page, and fragment token capture"
```

---

## Task 12: Admin surfaces

**Files:**
- Modify: `src/app/api/intakes/[id]/route.ts`
- Create: `src/app/api/admin/interest/[intakeId]/route.ts`
- Create: `src/app/api/admin/interest/[intakeId]/invite/route.ts`
- Create: `src/app/api/admin/interest/entry/[id]/route.ts`
- Modify: `src/app/admin/intakes/[id]/page.tsx`

- [ ] **Step 1: Accept `priority_open_at` on the intake**

Same ISO-string-or-null validation `enrollment_open_at` already gets in `src/app/api/classes/[id]/route.ts`. Catch the trigger's exception and return it as a readable validation message, not a raw Postgres error.

- [ ] **Step 2: Interest list + CSV export**

`GET /api/admin/interest/[intakeId]` — name, email, signed up, last link sent, invited, first used, converted. Scope every query by the admin's tenant.

- [ ] **Step 3: Revoke and resend**

`PATCH /api/admin/interest/entry/[id]` — sets `revoked_at`, or triggers a resend. Admin resend rotates and **bypasses the public cooldown**, so warn in the UI before rotating a record whose previous token is still inside its grace window.

- [ ] **Step 4: Invitations**

`POST /api/admin/interest/[intakeId]/invite`. It **rotates** — only hashes are stored, so the recipient's existing link cannot be reconstructed. Per row: same persist-then-send order and pre-send lock as a public resend. Stamp `invited_at` **per row as each send succeeds**, so a partial failure re-runs only the remainder. `await` the sends — fire-and-forget is killed on Vercel serverless. Process a bounded chunk and return `{ sent, remaining }`.

- [ ] **Step 5: Admin UI**

`priority_open_at` input on the intake editor, and the interest table. Hide the whole surface when `org_type === 'language_school'`, following `src/app/api/admin/channels/route.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/intakes src/app/api/admin/interest src/app/admin/intakes
git commit -m "feat(interest): add admin window scheduling, interest list, and invitations"
```

---

## Task 13: Full verification

- [ ] **Step 1: Everything green**

```bash
npm test
```

```bash
npm run test:db
```

```bash
npm run build
```

Judge the build by **exit code**, not by output text.

- [ ] **Step 2: Walk the whole flow once, by hand**

Register interest → confirm the link appears on screen and in email → confirm it does nothing before `priority_open_at` → confirm it enrolls after → confirm the public can still not enroll → confirm signup is closed once the window opens.

- [ ] **Step 3: Migrate the dev database**

```bash
npx supabase db diff
```

Read the diff. Confirm it contains only this feature's objects. Then push, and re-run the privilege query from Tasks 2 and 5 **against dev** — the local stack is not faithful to a remote Supabase project, so local verification is not evidence about dev.

- [ ] **Step 4: Open the PR**

Against `dev`. Do not merge it yourself.

---

## Notes for whoever executes this

**Do not "fix" these — they are deliberate:**
- Priority links are forwardable. A shared link works for whoever holds it. This was chosen over requiring phone confirmation; that is why the copy says "holders of an access link" rather than promising exclusivity.
- The rate limiter is a cost control, not an authorization boundary. `x-forwarded-for` is attacker-influenced. Do not build anything on top of it that assumes otherwise.
- The grace guarantee is narrow: the token immediately prior to the most recent rotation, not every token ever issued.
- `submit_cart_enrollment` validates all-or-nothing. A mixed cart fails entirely. That is the specced behaviour and two earlier revisions of the spec described it wrongly.

**If a test and the spec disagree, stop and ask.** Three separate claims in this spec about what the RPCs actually do turned out to be wrong on paper. The database is the authority.
