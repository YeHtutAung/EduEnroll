# Double seat restoration — plan v16

**Status:** for review. Do not implement.
**Supersedes:** v15 (undefined migration path), v14 (staging mechanics), v13 (hollow tests, placeholder staging), v12 (test-deletion fallout, partial validation), v11 (execution regressions), v10 (execution mechanics), v9 (test plan defects), v8 (dropped v7's ACL fix and scheduler gate), v7 (incomplete writer set).
**Related:** #173 (migration chain), #174 (RPC privileges, separate)

---

## What changed from v15

Design unchanged. One staging correction:

1. **Migration path resolved from disk, fail-closed.** v15 referenced an
   undefined `${timestamp}`, which PowerShell expands to an empty string —
   `git add` would have looked for `_fix_seat_restoration_ownership.sql` and
   failed on a path that never existed. Now resolved with `Get-ChildItem` and
   a count check that rejects both zero and multiple matches.

## What changed from v14

Design unchanged. Staging mechanics only:

1. **Staging rewritten as PowerShell.** v14 used Bash `\` line continuations,
   which PowerShell does not accept — it would have failed or read `\` as a
   path. Now a `$paths` array with `$LASTEXITCODE` checks.
2. **Setup file named and staged** — `src/__tests__/db/setup.ts`, wired via
   `setupFiles`. It was previously referenced but had no path, no creation
   step, and no staging entry. Ten paths now, not nine.
3. **Placeholders removed** — `<the same paths>` is gone; `$paths` feeds both
   `git add` and `git diff --cached`, so the reviewed set cannot drift from the
   staged set. Stale "step 9" reference corrected to step 10.

## What changed from v13

Design unchanged. Two execution corrections, one of which reverses a claim I
made in v13:

1. **Delete the four `it` blocks whole.** v13 said each contained other
   behavioural assertions to preserve. **Verified false** — each contains only
   its `restoreSeats` expectation, so stripping the assertion would leave four
   tests that assert nothing and pass unconditionally.
2. **Concrete staging list, and test wiring moved before the red run.** The
   placeholder `<exact-paths>` is replaced with the actual paths. The wiring
   (`vitest.db.config.ts`, the db suite, the `test:db` script) is now its own
   step *preceding* the red run — the red run cannot execute a suite that does
   not exist yet. Steps renumbered 4-14.

## What changed from v12

Design unchanged and approved. Two execution corrections:

1. **Test changes on helper deletion stated exactly.**
   `src/__tests__/payments/seatRestoration.test.ts` imports the deleted module,
   so `npm test` would fail on the source deletion alone. Named the file, the
   mock block, and all four assertion sites — while preserving the surrounding
   rejection coverage.
2. **Presence validation now covers all four variables**, not just the two
   URLs, plus a non-empty check at capture time. A missing key otherwise
   surfaces as C1/C2 or F1-F3 failing for client-configuration reasons that
   look like the defects under test.

## What changed from v11

Design unchanged and approved. Execution corrections only:

1. **`supabase start` silenced and fail-closed.** It prints the local keys on
   success; redirecting the later `status` call does not suppress that.
2. **Executable env transformation.** The CLI emits `DB_URL` / `API_URL` /
   `SERVICE_ROLE_KEY` / `ANON_KEY` — verified by listing names — none of which
   match the four the suite requires. A raw redirect fails validation before
   any test runs.
3. **F1-F3 ACL setup made executable**, asserting `42501` specifically, so the
   tests cannot pass or fail for client-setup reasons.
4. **One confirmation now covers both local resets** (steps 5 and 7).
5. **Staging precedes diff review** — untracked test files show nothing in a
   plain `git diff`.

## What changed from v10

Database design was approved in v10 review; unchanged here. These are execution
mechanics, plus one new defect found while deriving exact test expectations:

1. **Defect F — the expiry sweep is quantity-blind** (`count(*)`, not
   `sum(quantity)`). Found by reading the live function body to decide whether
   the `classes_updated` tests were reds or guards. Fixed implicitly by 2b.
2. **Discrete test inventory** — 24 named tests with per-test red expectations,
   replacing unenumerable families. Stop conditions are now exact.
3. **Cleanup contract** — `BEGIN … ROLLBACK` cannot cover PostgREST's separate
   connection, so explicit FK-safe teardown is mandatory.
4. **Environment capture and call-time mapping** made executable.
5. **Local migration lifecycle** — concrete numbered steps.

## What changed from v9

The database design was accepted in review. These are test-plan and accuracy
corrections only — no change to the migration or ownership design:

1. **Red-phase expectations corrected.** v9 said cases 1-5 must fail. They
   cannot: three describe behaviour that is already correct. The red matrix now
   names exactly four expected failures and three regression guards.
2. **Full test-environment contract restored** from v7 — four variables, not
   just `DATABASE_URL`, with both URLs guarded as local-only. A raw Postgres
   connection cannot run `verifyPayment()` or assert PostgREST ACLs.
3. **Rollback mechanism carried forward** from v7 — the `INT_MAX` overflow
   technique, not just a test name.
4. **Idempotency restated executably** — a row cannot be deleted twice.
5. **Production-access wording corrected** — see below. v9 said the ACL was
   "queried directly" on production, which misdescribes what happened and
   would normalise something the project rules prohibit.

## What changed from v8

v8's ownership rule was right; its safety and security content was not. This
revision:

1. **Restores v7's ACL fix, scheduler stop gate, and ACL tests** — v8 dropped
   them, which would have fixed seat arithmetic while leaving an
   unauthenticated `SECURITY DEFINER` mutation surface intact.
2. **Restores v7's concrete cart-aware `classes_updated` SQL** — v8 described
   it in prose, the exact vagueness that let the cart-blind version survive
   two revisions.
3. **Corrects a severity claim I made and could not support** (below).
4. **Replaces assumption with measurement.** Every behaviour below was executed
   against the isolated local stack in a rolled-back transaction. Two
   long-standing beliefs turned out to be false.

---

## Corrections to my own previous claims

**I said `restoreSeats()` can persist `seat_remaining > seat_total`. It cannot.**
The schema has:

```
classes_seats_check :: CHECK (seat_remaining >= 0 AND seat_remaining <= seat_total)
```

No migration drops it. The uncapped write fails the constraint instead of
persisting. Because `restoreSeats()` discards the update error, it fails
**silently**. So the real failure modes are:

- silent restoration failure (the whole update rejected)
- partial cart restoration (some items applied, a later one rejected)
- lost updates from read-then-write under concurrency
- double restoration that stays within the cap and therefore persists

My "admin capacity edit amplifies above-total corruption" claim was built on a
state the schema forbids. It is withdrawn. **Whether production still has this
constraint is now an audit item** rather than an assumption in either
direction.

---

## Measured behaviour on the current schema

Executed against the local stack, each in `BEGIN … ROLLBACK`.

| # | Scenario | `seat_remaining` | Verdict |
|---|---|---|---|
| A | cart, **active**, deleted | 7 → **7** | **seats lost — never restored** |
| B | cart, **rejected**, deleted | 7 → 7 | correct, but *by accident* |
| C | single-class, **active**, deleted | 7 → 10 | correct |
| D | single-class, **rejected**, deleted, class at **10/10** | 10 → 10 | **masked by the cap** |
| E | single-class, **rejected**, deleted, class at **5/10** | 5 → **8** | **phantom seats** |

### A is a new defect, in the opposite direction

`restore_seat_on_enrollment_delete()` carries the comment *"enrollment_items are
CASCADE-deleted AFTER this trigger, so they still exist here."* **This is
false.** Measured directly:

```
AFTER  DELETE sees 0 enrollment_items
BEFORE DELETE sees 1 enrollment_items
```

The cascade wins. Cart deletion restores **nothing** — capacity is lost
permanently. So cart deletion does not double-restore; it under-restores, and
an `OLD.status` guard cannot fix it. The trigger must move to `BEFORE DELETE`.

B therefore passes for the wrong reason: it looks correct only because the same
bug means nothing was restored at all.

### Defect F — the expiry sweep is quantity-blind

Read from the live function body, not inferred:

```sql
class_seats AS (
  SELECT class_id, count(*)::integer AS freed_seats
  FROM   expired
  WHERE  class_id IS NOT NULL      -- carts excluded
  GROUP BY class_id
)
```

`count(*)` counts **enrollments, not seats**. An expired `quantity = 3`
enrollment restores **one** seat through this path. And `class_id IS NOT NULL`
excludes carts entirely.

Consequences, which set the red expectations precisely:

| Expiry of | Direct increment | Trigger | Net |
|---|---|---|---|
| single-class, qty 1 | +1 | +1 | **2× — over-restores** |
| single-class, qty 3 | +1 | +3 | **4 instead of 3** |
| cart | none | correct | **correct seats**, but `classes_updated` = 0 |

So cart *seat* restoration under expiry is already correct, and only its count
is wrong. Removing the direct increment (2b) fixes defects 4 and F together,
because the trigger is already quantity-aware and cart-aware.

### D vs E is a fixture requirement, not a curiosity

The same defect **passes at full capacity and fails with headroom**, because
`LEAST(..., seat_total)` clamps the extra seats when the class is already full.

**Every fixture must start with headroom below `seat_total`.** A suite built on
full classes would report green against the current broken code. This is the
vacuous-pass failure mode, and it is now a concrete, checkable rule.

---

## The ownership rule

> **Seat restoration is owned by database triggers. Nothing else restores seats.**

| Event | Owner | Everyone else |
|---|---|---|
| Enrollment status → `rejected` | `update_seat_remaining()` | must not restore |
| Enrollment deleted while holding seats | delete trigger (moved to `BEFORE`) | must not restore |
| Expiry sweep | the status trigger, via its status change | `check_expired_enrollments()` must not restore directly |
| Payment rejected | the status trigger, via the cascade | application code must not restore |
| Admin edits class capacity | the admin route | not a restoration |

Seat-holding is `('pending_payment','payment_submitted','confirmed','partial_payment')`
— the guard `update_seat_remaining()` already uses. The fixes make every other
writer agree with it rather than invent its own.

---

## Complete writer inventory

Derived from **both** sweeps. Neither alone is sufficient: the catalog cannot
see application code; the repository cannot see database objects no longer
referenced in source.

**Database (catalog):**

| Object | Status |
|---|---|
| `update_seat_remaining()` | correct — the reference behaviour, no change |
| `restore_seat_on_enrollment_delete()` | **two defects** — cart-blind (A), no status guard (E) |
| `check_expired_enrollments()` | restores directly *and* via trigger; plus the ACL hole |
| `submit_enrollment` / `submit_cart_enrollment` | decrementers, not in scope (see #174) |
| `auto_reopen_class()` (063) | owns `full → open`, no seat arithmetic |

**Application (repository):**

| Location | Status |
|---|---|
| `src/server/payments/seatRestoration.ts` | **remove** — duplicate restoration |
| `src/app/api/classes/[id]/route.ts:75-77` | **keep** — legitimate capacity recalculation |

The mechanical inventory (`seat_remaining` / `seat_total` assignments across
`src/` and the catalog) must be re-run at implementation time and pasted into
the PR, so the claim "this is the complete set" is evidence rather than
assertion. It has been wrong twice.

---

## The fix

### Phase 1 — application stops restoring

- Remove the `restoreSeats()` call from `verifyPayment.ts:188-194`.
- Delete `src/server/payments/seatRestoration.ts`.
**Test changes, stated exactly.** "Update the tests" is not sufficient: a
helper-specific test file imports the deleted module, so `npm test` fails on
the source deletion alone.

| Path | Action |
|---|---|
| `src/__tests__/payments/seatRestoration.test.ts` | **delete** — it imports `@/server/payments/seatRestoration` directly and cannot survive the module's removal |
| `src/__tests__/payments/verifyPayment.test.ts:15-16` | remove the `vi.mock("@/server/payments/seatRestoration", …)` block |
| `verifyPayment.test.ts:197` | **delete** — "calls restoreSeats when enrollment was not already rejected" asserts the bug as intended behaviour |
| `verifyPayment.test.ts:175, 208, 266` | remove — three "does NOT call restoreSeats" assertions that become vacuously true once the function does not exist |

**Delete all four `it` blocks whole.** Verified by reading them: each contains
*only* its `restoreSeats` expectation — 175 and 266 are a single
`not.toHaveBeenCalled()`, 197 is `toHaveBeenCalledOnce()` plus its argument
check, 208 is a single `not.toHaveBeenCalled()`. Stripping just the assertions
would leave four tests that execute `verifyPayment()` and assert nothing, which
report green unconditionally — strictly worse than deleting them.

No coverage is lost. The behavioural assertions live in **adjacent** blocks
that are untouched: "updates payment status to rejected" (191), "formats
feeFormatted with currency" (181), and the approve/partial-payment blocks
around 168 and 258.

Seat behaviour on rejection is not lost — it moves to database cases C1-C3,
where it can actually be observed. The mocked suite could only ever assert
which function was called, which is why it reported green throughout.

Both test paths go in the exact staging list at step 10.

Deleting rather than neutering: an exported helper that must never be called is
an invitation, and its behaviour is wrong in three independent ways. Git
history retains it.

### Phase 2 — one timestamped migration

Nothing edits a historical migration; the chain is repaired forward.

**2a. Delete-restore: move to `BEFORE DELETE` and add the status guard**

Both defects, one rewrite. `BEFORE DELETE` is required for carts (proven
above); the status guard fixes E.

```sql
IF OLD.status NOT IN
   ('pending_payment','payment_submitted','confirmed','partial_payment')
THEN
  RETURN OLD;   -- seats already returned when it left an active state
END IF;
```

Drop and recreate the trigger with `BEFORE` timing — timing cannot be altered
in place.

**2b. `check_expired_enrollments()`: stop restoring directly**

Remove the `seat_remaining` increment; the status update it already performs
fires the trigger, which owns restoration.

**2c. `classes_updated` — cart-aware, carried forward from v7 verbatim**

A plain `count(DISTINCT class_id) … WHERE class_id IS NOT NULL` reports **0**
for a cart-only expiry, because carts have `class_id = NULL`. Return both `id`
and `class_id` from the CTE and count the distinct **union**:

```sql
WITH expired AS (
  UPDATE public.enrollments e
  ...
  RETURNING e.id, e.class_id
)
SELECT count(DISTINCT class_id) INTO v_class_count
FROM (
  SELECT class_id FROM expired WHERE class_id IS NOT NULL
  UNION
  SELECT ei.class_id
  FROM   public.enrollment_items ei
  JOIN   expired x ON x.id = ei.enrollment_id
) u;
```

**2d. ACL fix — carried forward from v7. A security correction, not a redundant grant.**

Migration 011 grants EXECUTE to `service_role` and comments *"Authenticated
users and anon role cannot trigger expiry manually."* **The code does not
implement that.** PostgreSQL grants `EXECUTE` to `PUBLIC` by default, no
migration ever revokes it, and the function is `SECURITY DEFINER` — so it
bypasses RLS. `CREATE OR REPLACE` preserves privileges, which preserves the
hole.

Confirmed present on the local rebuild (catalog query against the isolated
stack), and on production via **read-only queries the project owner ran in the
Supabase dashboard SQL Editor** and pasted back. No direct connection to the
production database was made, and none is authorised — project rules prohibit
it. Any future verification of production state must follow the same route: a
read-only query, run by the owner, through the dashboard.

```sql
REVOKE ALL ON FUNCTION public.check_expired_enrollments() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_expired_enrollments() FROM anon;
REVOKE ALL ON FUNCTION public.check_expired_enrollments() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_expired_enrollments() TO service_role;
```

**2e. Consistency**

Keep `LEAST(..., seat_total)` on both trigger paths — see Open Question 1,
resolved: defence in depth. The CHECK constraint surfaces direct violations;
`LEAST` stops a restoration failing because historical data is already
inconsistent. Leave `full → open` to `trg_auto_reopen_class` (063).

### Phase 3 — the scheduler stop gate (read-only, before any push)

Nothing in this repo calls `check_expired_enrollments()`, so its invoker lives
outside the codebase. **Revoking `PUBLIC` could silently stop all expiry** if
the scheduler runs as another role.

```sql
SELECT grantee, privilege_type FROM information_schema.routine_privileges
WHERE routine_name = 'check_expired_enrollments';

SELECT jobname, username, command FROM cron.job;
```

- `pg_cron` as the function owner → unaffected by the REVOKE
- Edge Function using `service_role` → covered by the explicit GRANT
- any other legitimate invoker → give it its own narrow grant **in this migration**
- **scheduler identity unknown → STOP. Do not push.**

**RESOLVED 2026-07-19:** the job is `expire-pending-enrollments`, running as
**`postgres`** (the function owner). Unaffected by the REVOKE — gate cleared.
Re-run this step if the migration is delayed; cron configuration can change.

### Phase 4 — tests

Trigger interaction cannot be tested with mocks. The existing suite mocks the
Supabase client, so it asserts only which calls the application makes — it
would pass with every writer double-restoring.

**Environment contract.** A raw PostgreSQL connection can build fixtures and
inspect results, but it cannot exercise three of the required cases. Case 2
runs the real `verifyPayment()`, whose `createAdminClient()` needs a Supabase
URL and service-role key. Case 12 asserts PostgREST ACL behaviour for
`service_role`, `anon` and `authenticated`, which requires the respective keys
and a real authenticated user/JWT.

Four variables, all required:

| Variable | Used for |
|---|---|
| `DATABASE_URL` | fixtures, catalog inspection, direct SQL assertions |
| `SUPABASE_TEST_URL` | `verifyPayment()` and all PostgREST calls |
| `SUPABASE_TEST_SERVICE_KEY` | service-role path in `verifyPayment()` and case 12 |
| `SUPABASE_TEST_ANON_KEY` | `anon` / `authenticated` denial assertions in case 12 |

`createAdminClient()` must be explicitly configured to the isolated local URL
and service key for the case 2 integration. Left to its own resolution it will
pick up `.env.local` — so it would either fail before reaching the trigger
interaction, or silently run against a shared project.

**Safety guards.** Having the variables set is not sufficient:
`check_expired_enrollments()` is **global**, so pointing at a shared dev or
production project would reject unrelated enrollments across every tenant.
Guard **both** URLs, not just `DATABASE_URL` — the Supabase URL is the one that
reaches a hosted project:

Two separate loops, because the checks differ. **Presence covers all four** —
the keys are not URLs and cannot be host-checked, but a missing key breaks
`verifyPayment()` and the ACL cases for reasons unrelated to what they test:

```ts
// 1. Presence — all four. A missing key must fail here, not inside a test.
for (const name of [
  "DATABASE_URL",
  "SUPABASE_TEST_URL",
  "SUPABASE_TEST_SERVICE_KEY",
  "SUPABASE_TEST_ANON_KEY",
] as const) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`${name} is missing or empty. Refusing to run database tests.`);
  }
}

// 2. Host — only the two URLs. This is the guard that keeps a global
//    function off a shared project.
for (const name of ["DATABASE_URL", "SUPABASE_TEST_URL"] as const) {
  const host = new URL(process.env[name]!).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(
      `${name} points at ${host}. Refusing to run database tests outside the isolated local stack.`,
    );
  }
}
```

Without the presence loop, a missing `SUPABASE_TEST_SERVICE_KEY` surfaces as
C1/C2 failing inside `verifyPayment()`, or F1-F3 failing at client
construction — failures that look like the defects under test. That is the
same class of error as an ACL test failing at login: a red for the wrong
reason.

- **Fail loudly when `DATABASE_URL` is unset** — never skip. A skipped
  integration suite reports green and proves nothing.
- **Sequential execution required.** Per-test fixtures cannot isolate parallel
  invocations of a global function.
- **Dedicated Vitest config + `npm run test:db`**, excluded from ordinary
  `npm test` so a missing local stack does not fail routine runs.
- **Every fixture starts with headroom below `seat_total`** — see D vs E.

#### Obtaining the variables without exposing keys

A raw redirect does **not** work. The CLI emits different names from the ones
the suite requires — verified by listing the emitted names (values never
printed):

```
ANON_KEY  API_URL  DB_URL  SERVICE_ROLE_KEY  … (14 more)
```

None of the four required names is among them, so
`supabase status -o env > .env.test.local` produces a file that fails
pre-collection validation before a single test runs. The rename is mandatory,
not cosmetic:

| CLI emits | Suite requires |
|---|---|
| `DB_URL` | `DATABASE_URL` |
| `API_URL` | `SUPABASE_TEST_URL` |
| `SERVICE_ROLE_KEY` | `SUPABASE_TEST_SERVICE_KEY` |
| `ANON_KEY` | `SUPABASE_TEST_ANON_KEY` |

```powershell
$raw = npx supabase status -o env 2>$null
if ($LASTEXITCODE -ne 0) { throw "supabase status failed — is the local stack running?" }

$map = @{
  'DB_URL'           = 'DATABASE_URL'
  'API_URL'          = 'SUPABASE_TEST_URL'
  'SERVICE_ROLE_KEY' = 'SUPABASE_TEST_SERVICE_KEY'
  'ANON_KEY'         = 'SUPABASE_TEST_ANON_KEY'
}

$out = @()
foreach ($line in $raw) {
  $i = $line.IndexOf('=')
  if ($i -lt 1) { continue }
  $name  = $line.Substring(0, $i)
  $value = $line.Substring($i + 1).Trim('"')
  # Require a non-empty value: a captured-but-blank key would satisfy a plain
  # count check and then fail later inside a test, looking like a real defect.
  if ($map.ContainsKey($name) -and -not [string]::IsNullOrWhiteSpace($value)) {
    $out += "$($map[$name])=$value"
  }
}

if ($out.Count -ne 4) { throw "Expected 4 non-empty variables, captured $($out.Count). Refusing to write." }

$out | Out-File -FilePath .env.test.local -Encoding utf8   # -Encoding utf8: PS 5.1 defaults to UTF-16
```

Nothing above echoes a value: `$raw` is captured, never printed, and the count
check reports a number rather than contents.

- **Gitignore is already in force** — `.env*.local` at `.gitignore:30` covers
  `.env.test.local` (verified with `git check-ignore`). Re-confirm before
  writing; a local service-role key in a commit is a credential leak.
- Validate all four **before collecting tests**, so a misconfiguration fails
  immediately rather than mid-suite with fixtures already created.
- Keep values out of terminal output, diffs, commits and PR text. Assert on
  presence and host, never print contents.

**Mapping happens at call time.** `createAdminClient()` reads
`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` when invoked, not at
import. So before exercising `verifyPayment()`:

```ts
process.env.NEXT_PUBLIC_SUPABASE_URL  = process.env.SUPABASE_TEST_URL!;
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_KEY!;
```

Without this it resolves `.env.local` and runs against the shared dev project —
silently, since both are valid Supabase clients.

#### Cleanup contract — `BEGIN … ROLLBACK` is not available here

The measurements in this document used `BEGIN … ROLLBACK`, which works because
they are pure SQL on one connection. **The suite cannot rely on it.**
`verifyPayment()` goes through PostgREST on a *separate* connection, so a SQL
transaction cannot roll back what it did.

Every test therefore cleans up explicitly:

- **Record every fixture id immediately after creation**, not at teardown — a
  test that fails midway must still have recorded what it made.
- **Clean up in `afterEach`, including after failure.**
- **Delete in FK-safe order:**

  ```
  tickets → payments → enrollment_items → enrollments
          → classes → intakes → tenants → auth user
  ```

- **The rollback test normalises its poisoned fixture inside the same test**
  (already specified in case A5) — `afterEach` runs too late to prove recovery.
- **Sequential execution is mandatory**, not merely advisable.

The stakes are specific: `check_expired_enrollments()` is global. A
manual-rejection test that fails and leaves an eligible `pending_payment` row
behind will be swept up by the *next* test's expiry invocation, producing a
failure in an unrelated test and an inventory count that no longer matches.

Required cases, each asserting an exact final `seat_remaining`:

| # | Scenario | Expected |
|---|---|---|
| 1 | Expiry sweep rejects an enrollment | restores exactly once |
| 2 | **Manual payment rejection** — trigger restores, then `restoreSeats()` restores again | restores exactly once |
| 3 | Direct status change to `rejected` | restores exactly once |
| 4 | Delete an active enrollment (single **and cart**) | restores exactly once |
| 5 | Delete an already-rejected enrollment | restores **zero** additional |
| 6 | Cart variants of 1-5 | same, per item |
| 7 | `quantity > 1` | restores exactly `quantity` |
| 8 | Idempotency — see breakdown below | no additional restoration |
| 9 | Full class reopens (`full → open`) | still works |
| 10 | `classes_updated` for direct, cart, and **mixed** expiry | correct for each |
| 11 | Exception mid-sweep — mechanism below | entire operation rolls back |
| 12 | `service_role` executes; `anon` and `authenticated` are denied | ACL enforced |
| 13 | `seat_remaining` never exceeds `seat_total` | invariant holds |

#### Case 8 — idempotency, stated executably

"Repeat each operation" is not literally executable: a row cannot be deleted
twice, and a second delete affects zero rows, which tests nothing about the
trigger. Idempotency is four distinct assertions:

| 8a | Run the expiry sweep twice | second run restores nothing further |
| 8b | Reject an already-rejected payment | no additional restoration |
| 8c | Re-set `status = 'rejected'` on a rejected enrollment | no additional restoration |
| 8d | Reject, then delete the rejected row | delete restores nothing further |

8d is the composition that defect E breaks, and it is the pairing that gives
the rejected-cart case its meaning.

#### Case 11 — rollback mechanism, carried forward from v7

The function traps exceptions and returns `{ success: false }`. Prove that
leaves **nothing** half-applied — a partial rollback would be worse than the
bug it replaces.

Deterministic failure **without DDL**: `seat_remaining` and `seat_total` are
`integer` (`000_combined_schema.sql:207-208`, max 2147483647). The restore
trigger evaluates `seat_remaining + quantity` **before** `LEAST()` can clamp
it, so setting both to `INT_MAX` raises integer overflow *inside* the expiry
transaction — precisely the window that must roll back.

```ts
await setClassSeats(classId, { seat_total: 2147483647, seat_remaining: 2147483647 });
const before = { seats: await seatRemaining(classId), status: await enrollmentStatus(enrollId) };

const res = await expireNow();          // trigger overflows; function traps it

expect(res).toMatchObject({ success: false });
expect(await seatRemaining(classId)).toBe(before.seats);
expect(await enrollmentStatus(enrollId)).toBe(before.status);   // NOT 'rejected'
```

Recovery must be proven **in this same test, on the same poisoned fixture**.
A later test gets a fresh fixture from `afterEach` and would only prove that
ordinary expiry works — not that this failed invocation can be retried:

```ts
await setClassSeats(classId, { seat_total: 100, seat_remaining: 50 });
expect(await expireNow()).toMatchObject({ success: true });
```

#### Discrete test inventory — 24 tests

The families above ("cart variants of 1-5", "three ACL roles") are not
executable and cannot produce a count. Expanded, with the expected red-run
outcome for each, derived from the measured behaviour above rather than
estimated:

| # | Test | Red |
|---|---|---|
| **A. Expiry sweep — seats** | | |
| A1 | single-class, qty 1, headroom → restores exactly once | **FAIL** (2×) |
| A2 | single-class, qty 3, headroom → restores exactly 3 | **FAIL** (4 — defect F) |
| A3 | cart → restores exactly once per item | pass |
| A4 | sweep run twice → second restores nothing further | pass |
| A5 | overflow raises → full rollback, then recovers on same fixture | pass |
| **B. `classes_updated`** | | |
| B1 | direct-only expiry → correct count | pass |
| B2 | cart-only expiry → correct count | **FAIL** (0) |
| B3 | mixed expiry → correct count | **FAIL** (direct only) |
| **C. Manual payment rejection** | | |
| C1 | single-class, headroom → restores exactly once | **FAIL** (2×) |
| C2 | cart, headroom → restores exactly once | **FAIL** (2×) |
| C3 | reject an already-rejected payment → no additional | pass |
| **D. Direct status change** | | |
| D1 | single-class → `rejected`, headroom → exactly once | pass |
| D2 | cart → `rejected` → exactly once per item | pass |
| D3 | re-set `rejected` on a rejected row → no additional | pass |
| **E. Deletion** | | |
| E1 | delete **active single-class**, headroom → exactly once | pass |
| E2 | delete **active cart**, headroom → exactly once per item | **FAIL** (0 — defect A) |
| E3 | delete **rejected single-class**, headroom → zero additional | **FAIL** (+qty — defect E) |
| E4 | delete **rejected cart** → zero additional | pass *(accidentally)* |
| E5 | reject, then delete (8d), single-class → zero additional | **FAIL** |
| E6 | delete active single-class, qty 3 → restores exactly 3 | pass |
| **F. ACL** | | |
| F1 | `service_role` may execute the expiry function | pass |
| F2 | `anon` is denied | **FAIL** (PUBLIC grant) |
| F3 | `authenticated` is denied | **FAIL** (PUBLIC grant) |
| **G. Invariant** | | |
| G1 | `seat_remaining` never exceeds `seat_total` across all operations | pass |

#### Cases F1-F3 — ACL, executable setup

F2 and F3 are the only tests that prove the security fix. Underspecified, they
prove nothing in either direction: a red that comes from a failed login does
not demonstrate the `PUBLIC` grant exists, and a green that comes from a
missing token does not demonstrate the `REVOKE` works. Both would be
**indistinguishable from success** while testing the client, not the grant.

`anon` (F2) needs only the anon key. `authenticated` (F3) needs a real session:

1. Create a **uniquely named** local auth user via the service-role client
   (unique so a leaked fixture from a failed run cannot collide).
2. Sign in with the **anon** client to obtain a genuine JWT. Assert the session
   exists before proceeding — a failure here is a harness fault, not a result.
3. Call the RPC with that session.
4. **Assert on the specific failure.** PostgREST returns `42501`
   (`insufficient_privilege`) for an execute denial. Assert that code — not
   merely "it threw", which would also pass for a bad URL, an expired token, or
   a network error.
5. Delete the auth user in `finally`, so it is removed even when the assertion
   fails.

The same specificity applies to F1: assert `service_role` **succeeds**, so a
REVOKE that is too broad is caught rather than silently disabling expiry.

**Stop conditions:**

```
Red run:    24 collected / 13 passed / 11 failed   (exactly A1 A2 B2 B3 C1 C2 E2 E3 E5 F2 F3)
Green run:  24 collected / 24 passed / 0 failed
```

Any other result stops the work. A guard failing red means the fixture or
harness is wrong, not the code — that signal only exists because the passes are
predicted too.

**E1 and E2 stay separate tests.** Combined, the cart failure would mask a
regression in the already-correct single-class path.

Every failing case runs **with headroom below `seat_total`**. At full capacity
`LEAST` clamps the surplus and the defect disappears — measured in D vs E.

Assert the collected count so a test silently failing to register is caught.

### Phase 5 — production audit (separate, after the fix ships)

The fix stops new corruption; it does not repair existing rows. Read-only
first:

- classes where `seat_remaining` disagrees with a recount of seat-holding enrollments
- **whether `classes_seats_check` still exists on production** — the local
  result does not establish this, and the severity of historical corruption
  depends on it
- cart classes showing lost capacity from defect A

Then decide on correction as its own reviewed change.

---

## Rollout

Feature branch from `dev` → PR to `dev` → staging → main. No self-merge.

Phases 1 and 2 ship together: they are two halves of one ownership change.
Phase 1 alone leaves the expiry sweep double-restoring; Phase 2 alone leaves
the application path, which is the most reachable.

### Local migration lifecycle — executable sequence

A prose rollout paragraph is not enough to execute a database change safely.

1. **Merge #173 first.** Update local `dev`, confirm clean, branch from it.
   Without #173 the chain cannot rebuild, so no reset below will work.
2. **Start the isolated local stack, fail-closed and silent.** `supabase start`
   prints the local keys on success — redirecting the later `status` call does
   not suppress that earlier output, so the redirect must be on `start` itself:

   ```powershell
   npx supabase start *> $null
   if ($LASTEXITCODE -ne 0) { throw "Local Supabase failed to start." }
   ```

   Suppressing output makes the exit-code check mandatory: with stdout and
   stderr discarded, a silent failure is otherwise indistinguishable from a
   silent success.
3. **Request explicit confirmation covering BOTH local resets** — step 5 and
   step 7 — naming them as two destructive operations on the local Docker
   database only. Do not run either unprompted; this is a standing instruction
   throughout this work. If confirmation covers only the first, ask again
   before step 7.
4. **Build the test wiring — before the red run, not after.** The red run
   cannot execute a suite that does not exist yet, so this precedes step 5:
   - `src/__tests__/db/seat-restoration.db.test.ts` — the 24 cases
   - `src/__tests__/db/setup.ts` — the setup file, carrying the four-variable
     presence check and the two-URL host guard, so both run **before test
     collection**
   - `vitest.db.config.ts` — node environment, **sequential execution**
     (`fileParallelism: false`, single fork), wiring the setup file via
     `setupFiles: ["./src/__tests__/db/setup.ts"]`
   - `vitest.config.ts` — exclude `src/__tests__/db/**` so ordinary `npm test`
     is unaffected by a missing local stack
   - `package.json` — add `"test:db": "vitest run --config vitest.db.config.ts"`

   Run `npm test` here to confirm the ordinary suite still collects its usual
   count and the new directory is genuinely excluded.
5. **Reset to the pre-fix chain and run the red suite.** Confirm the exact stop
   condition: 24 collected / 13 passed / 11 failed, failures exactly as named.
6. **Add the timestamped migration and the application change** (Phases 1 and
   2, including the four test deletions).
7. **Reset again** (the second reset authorised in step 3) so the new migration
   actually applies. Editing a migration file does not change an already-built
   database; skipping this tests the old schema and reports a meaningless
   green.
8. **Run the green database suite** — 24/24.
9. **Run `npm test`, `npm run lint`, `npm run build` separately.** Judge the
   build by **exit code**: `next build` prints "Compiled successfully" and
   *then* type-checks, so the message alone is not a pass.
10. **Stage, then review what was staged.** New integration-test and config
    files are untracked, so a plain `git diff` shows nothing — the review would
    pass by seeing an empty diff. The paths are known in advance, so list them
    rather than improvising at commit time:

    This workspace's primary shell is **PowerShell**, where `\` is not a line
    continuation — a Bash-style `git add \` would fail or be read as a path
    literal. Use an array, and reuse it for both commands so the reviewed set
    and the staged set cannot drift apart:

    Resolve the migration path from disk rather than reconstructing its
    timestamp. PowerShell expands an undefined variable to an empty string, so
    a hardcoded `${timestamp}` would silently become
    `supabase/migrations/_fix_seat_restoration_ownership.sql` — a path that
    never existed, failing on a confusing error instead of an unset variable:

    ```powershell
    $migrations = @(
      Get-ChildItem -LiteralPath 'supabase/migrations' `
        -Filter '*_fix_seat_restoration_ownership.sql'
    )

    if ($migrations.Count -ne 1) {
      throw "Expected exactly one seat-restoration migration, found $($migrations.Count)."
    }

    $migrationPath = Resolve-Path -Relative $migrations[0].FullName
    ```

    The count check is what makes this fail closed: it catches both zero
    matches (step 6 skipped, or the file misnamed) and more than one (a
    leftover from an earlier attempt, which would otherwise be staged silently
    or shadow the intended file).

    ```powershell
    $paths = @(
      'src/server/payments/verifyPayment.ts'
      'src/server/payments/seatRestoration.ts'            # deleted
      'src/__tests__/payments/seatRestoration.test.ts'    # deleted
      'src/__tests__/payments/verifyPayment.test.ts'
      'src/__tests__/db/seat-restoration.db.test.ts'
      'src/__tests__/db/setup.ts'
      $migrationPath
      'vitest.db.config.ts'
      'vitest.config.ts'
      'package.json'
    )

    git add -- $paths
    if ($LASTEXITCODE -ne 0) { throw "git add failed." }

    git diff --cached -- $paths
    if ($LASTEXITCODE -ne 0) { throw "cached diff failed." }

    git status --short
    ```

    Ten paths. Two are **deletions** — `seatRestoration.ts` and its test — and
    `git add` on a deleted path stages the deletion correctly.

    Reusing `$paths` for both commands is the point: a hand-retyped diff list
    can omit a staged file, and the review then passes without ever showing it.

    `package-lock.json` only if a dependency legitimately changed; this work
    should need none, so a modified lockfile is a signal to investigate rather
    than stage.

    `git status --short` catches anything unexpectedly staged or left behind —
    above all `.env.test.local`, which must appear nowhere. Commit exactly
    these paths. Never `git add -A`.
11. **Recheck scheduler identity** (Phase 3 queries). Cron configuration can
    change between planning and pushing; the earlier result has a shelf life.
12. **Fail closed on the linked project ref.** Confirm it is `fnfvwzwrdsnmwxunciti`
    (EduEnroll-dev). Anything else — abort. Never
    `nhxmumcvgnxlczjsgctz` (production) or `kbiszegobsbelzbyyfvo`.
13. **`supabase db push --dry-run` first, show the diff, then push to dev only.**
14. **Never connect directly to production.** Any production verification goes
    through a read-only query the owner runs in the dashboard.

**Commit before pushing to remote dev**, so the remote migration always
corresponds to a recorded commit. A pushed migration with no commit behind it
cannot be reviewed, reverted, or attributed.

---

## Open questions — resolved in review

1. **Keep `LEAST`?** Yes, defence in depth. Adopted in 2e.
2. **Rejected-then-deleted behaviour change?** Correct as designed. A rejected
   enrollment has already released its seats; any external process relying on
   the second release relies on the bug. Confirm external tooling, do not
   preserve the bug for compatibility.
3. **CI?** A generic Postgres service is insufficient — the chain references
   Supabase `auth` and `storage` schemas. Sequence: land the suite with the
   local-only guard; require `npm run test:db` output as documented PR
   evidence; add full Supabase-local CI as a separate, explicitly authorised
   workflow change.

## Remaining open question

**Defect A has been losing cart capacity in production for as long as cart
deletion has been in use.** Unlike the phantom-seat defects, this silently
*reduces* sellable capacity, and no constraint or cap would have surfaced it.
The Phase 5 audit should size it — but if cart enrollments are routinely
deleted, this may be the most commercially significant of the five, and may
deserve its own priority independent of this plan.
