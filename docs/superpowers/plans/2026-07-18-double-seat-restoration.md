# Fix Double Seat Restoration on Auto-Cancellation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One expiring enrollment frees exactly the seats it held. Today a single-class enrollment frees them **twice**, creating phantom capacity that can be sold to a second customer.

**Architecture:** Establish a single owner for seat restoration — the `update_seat_remaining()` trigger on `enrollments`. `check_expired_enrollments()` goes back to doing one job: transitioning eligible enrollments to `rejected`. Its redundant second UPDATE is deleted.

**Tech Stack:** PostgreSQL / Supabase migration, Vitest integration tests against an **isolated local** Supabase instance.

**Scope: deliberately narrow.** This is a live capacity bug. It is *not* the Stripe settlement work — that is parked and will be rewritten against the transactional RPC afterwards.

---

## Revision history

**v7 (this document)** — revised after the v6 review. One execution blocker. Database and test design both approved.

| v6 said | Reality | v7 does |
|---|---|---|
| First step: `npx supabase start`, then a later section replaces it with `npx supabase start *> $null` | **Following the plan sequentially still prints the credentials** — the corrected form appears only after the leak. A fix that leaves the original in place is not a fix. | Single silenced, fail-closed startup; duplicate removed. |

**Fourth instance in this document** of a rule stated in one place and contradicted by the executable step nearby (cart-blind SQL, fixture cleanup, recovery proof, now this). The review has caught every one; my own re-reads caught none.

**v6** — revised after the v5 review. Two executable mismatches; database design unchanged and approved.

| v5 said | Reality | v6 does |
|---|---|---|
| Capture writes `API_URL` / `SERVICE_ROLE_KEY` / `ANON_KEY`; guard reads `SUPABASE_TEST_URL` | **Names don't match.** The guard gets `undefined` and throws before collecting any of the 18 tests. Also, `supabase start` itself prints credentials — the `status` capture alone does not make setup non-echoing. | Rename on capture to `SUPABASE_TEST_*`, and handle `start`'s output too. |
| Isolation rules say the rollback test must prove recovery *within itself* | **The live test still ends at the rollback assertions**, with recovery in a separate test that gets a fresh fixture after `afterEach`. That proves ordinary expiry works — not that a failed invocation recovers. | Recovery proof moved into the rollback test. |

Both are the same defect: a rule stated in one section, not implemented in the step that executes it. That has now happened three times in this document — worth watching for in review rather than trusting the prose.

**v5** — revised after the v4 review. Four defects, all in the test plan. The database change has been stable across three reviews.

| v4 said | Reality | v5 does |
|---|---|---|
| "the database is disposable, fixtures need no cleanup" | **Disposable protects external data; it does not protect tests from each other.** The rollback test commits `seat_remaining = 2147483647` *before* the expiry, so when that transaction rolls back the class stays at INT_MAX and the enrollment stays `pending_payment` — both still eligible. Every later global invocation re-overflows. The denied anon/authenticated tests also leave eligible fixtures. | Per-test fixtures, `afterEach` cleanup in FK-safe order, sequential execution. |
| Red = 3 named failures; green = "fourteen pass" | The suite is **18 tests with 7 expected red failures** — v4 omitted both `classes_updated` cart cases and both ACL cases, and the count was stale. | Exact counts and all seven named. |
| `rpcAs("authenticated")` | Undefined. The anon key with a different label is not an authenticated session. | Real local auth user + JWT, cleaned up. |
| "`supabase start` prints the keys" then "Never print" | Contradicts itself. | Non-echoing capture into a gitignored `.env.test.local`. |

**v4** — revised after the v3 review. Five execution defects; database design unchanged.

| v3 said | Reality | v4 does |
|---|---|---|
| Red run: `npx vitest run <path>` | After `vitest.config.ts` excludes integration tests, that command **collects zero tests** — the hollow pass v3 itself warned about, then walked into. | `npm run test:db` for **both** phases, with an explicit collected-count assertion. |
| Test wiring listed under Task 3 | Circular: Task 2's red run needs `test:db`, which does not exist until Task 3. Task 2 also staged only the test file. | Wiring moves to Task 2 and is committed with it. Task 3 owns only the migration. |
| `await sql(FORCE_FAIL_TRIGGER_SQL)` + `CREATE FUNCTION pg_temp_fail()` | `sql()` is undefined — no driver in the plan. And naming a function `pg_temp_fail` does **not** make it temporary; dropping the trigger leaves the function behind. A genuinely temporary function is session-scoped, while the RPC may run on a different pooled connection. | **Integer overflow instead.** `seat_remaining`/`seat_total` are `integer` (verified, `000_combined_schema.sql:207-208`); set both to `2147483647` and the trigger's `seat_remaining + 1` raises inside the transaction. No DDL, no helper, no teardown. |
| "prove the ACL with real clients" | Stated as prose; no step or test implements it. | Executable ACL tests — red under 011's privileges, green after the migration. |
| Push to remote dev, then gates, then commit | If lint/build/commit fails, dev holds a migration no commit represents. | Local green → gates → commit → link check → dry-run → push → verify remote status. |

**v3** — revised after the v2 review. Five execution defects; migration and ACL design unchanged.

| v2 said | Reality | v3 does |
|---|---|---|
| Task 3 applies the migration with `npx supabase db push` | **`db push` targets the linked REMOTE project, not the running local stack.** The green run would still execute migration 058 and stay red — and it pushes to dev *before* local verification, inverting the intended order. | Explicit local lifecycle with `db reset`; remote push only after local green. |
| "Exclude this file from the default `vitest run` (a separate script, e.g. `test:db`)" | No mechanism. `vitest.config.ts` has no such exclude, `package.json` has no `test:db`, and the expected-diff list omits both files. | Concrete config + script changes, added to the file list and expected diff. |
| Design section requires a cart-aware union for `classes_updated` | **Task 3's executable instruction still carried the cart-blind `count(DISTINCT class_id) … WHERE class_id IS NOT NULL`** — the exact defect the v2 history claimed to fix. The same self-contradiction criticised in the Stripe plan, reproduced here. | Concrete cart-aware SQL in the task itself. |
| Scheduler check as an embedded warning | A stop condition buried in prose gets skipped. It is also answerable **read-only**. | Formal numbered step with the exact read-only queries, before any push. |
| `await forceFailure(); // e.g. temporarily break a dependency` | Leaves a safety-critical rollback test to improvisation. | Deterministic mechanism: a temporary local-only trigger that raises. |

**v2** — revised after review. Two safety blockers in the *execution* plan; the migration design itself was approved unchanged.

| v1 said | Reality | v2 does |
|---|---|---|
| Integration tests against the shared dev DB, "must never touch pre-existing rows" | **Impossible as written.** `check_expired_enrollments()` is global — it processes every eligible enrollment across every tenant. Fixture ids and `afterEach` cleanup cannot scope it. It would reject unrelated dev enrollments and could race the scheduled job. | Isolated local Supabase instance; the global function is never invoked against a shared project. |
| "Do not re-issue the `GRANT` — `CREATE OR REPLACE` preserves privileges" | **Preserving the privileges preserves a hole.** Migration 011 grants EXECUTE to `service_role` but never REVOKEs the PostgreSQL default `EXECUTE` from `PUBLIC` — and the function is `SECURITY DEFINER`, so it bypasses RLS. Its own comment claims "anon role cannot trigger expiry manually", which the code does not implement. | Explicit REVOKE + GRANT. **A security correction, not a redundant grant.** |
| "Confirm the CLI is linked to dev" before `db push` | Relies on the operator checking. This repo has been linked to production during this session. | Fail-closed programmatic check + `--dry-run` before any push. |
| `classes_updated` = `count(DISTINCT class_id)` from expired rows | Cart enrollments have `class_id = NULL`, so carts count as zero classes affected — the field would silently keep a single-class-only meaning. | Union single-class ids with `enrollment_items.class_id`, with tests. |
| — | The function catches exceptions and returns `{ success: false }`; nothing proves the transaction actually rolls back. | Adds a rollback-proof test. |

---

## The bug

`check_expired_enrollments()` transitions expired enrollments to `rejected`, which **fires** `update_seat_remaining()` — and then restores the same seats a second time itself.

**049 — the trigger, on `enrollments` UPDATE → `rejected`:**
```sql
IF NEW.class_id IS NOT NULL THEN
  UPDATE public.classes
  SET seat_remaining = LEAST(seat_remaining + COALESCE(NEW.quantity, 1), seat_total)
  WHERE id = NEW.class_id;
ELSE
  -- cart: loop enrollment_items, restore each
END IF;
```

**058 — the expiry function, same transaction:**
```sql
WITH expired AS (UPDATE public.enrollments SET status = 'rejected' ... RETURNING e.class_id),
     class_seats AS (SELECT class_id, count(*) AS freed_seats FROM expired WHERE class_id IS NOT NULL GROUP BY class_id)
UPDATE public.classes c
SET seat_remaining = LEAST(c.seat_remaining + cs.freed_seats, c.seat_total), status = CASE ... END
FROM class_seats cs WHERE c.id = cs.class_id;
```

**Both run.** A single-class order for 1 seat frees 2.

### Why it went unnoticed

- **Cart enrollments are unaffected** — `class_id IS NULL`, so the expiry function's `WHERE class_id IS NOT NULL` excludes them. Only the trigger restores them, correctly.
- **`LEAST(…, seat_total)` masks it at capacity.** A class at or near full clamps, so the phantom seat only appears when the class has room — which is exactly when someone can buy it.
- The two restorations live in different migrations, three apart.

### Reach

**Auto-cancel is enabled on 15/15 tenants**, several at 15 minutes. Every expiring single-class order creates phantom capacity. This is reachable in production now.

### The redundant UPDATE is redundant twice

It also flips `full → open`. **That is handled independently** by `trg_auto_reopen_class` (migration 063), a `BEFORE UPDATE` trigger on `classes`:

```sql
IF OLD.status = 'full' AND NEW.seat_remaining > 0 THEN NEW.status := 'open'; END IF;
```

Since 049's trigger updates `seat_remaining`, 063 fires and reopens the class. So the whole second UPDATE can go — **seat restore and status flip are both already owned elsewhere.**

---

## Design decision: the trigger owns restoration

| Concern | Owner after this change |
|---|---|
| Restore seats on rejection | `update_seat_remaining()` — migration 049 |
| Reopen a full class | `trg_auto_reopen_class` — migration 063 |
| Expire eligible enrollments | `check_expired_enrollments()` — this migration |

**Why the trigger, not the function:** the trigger already handles *every* path to `rejected` (admin rejection, provider cancellation via abank/paypay/hitpay, expiry). The expiry function handles one. Making the function the owner would mean removing restoration from the trigger and reimplementing it in every other rejection path. The trigger is the correct single owner; the function is the duplicate.

### The `classes_updated` return field

`check_expired_enrollments()` returns `jsonb` including `classes_updated`, derived from `GET DIAGNOSTICS ROW_COUNT` of the UPDATE being deleted.

**Consumer check: no application code calls this function** — `grep -rn "check_expired_enrollments" src/` returns nothing. It is invoked by a scheduled job, which at most logs the result.

**Decision: preserve the field, and make it mean what it says.** v1 proposed `count(DISTINCT class_id)` from the expired rows — but cart enrollments have `class_id = NULL`, so a cart expiry would report **0 classes affected**, silently keeping the field single-class-only. Derive it from the **union** of both sources:

- `expired.class_id` for single-class enrollments
- `enrollment_items.class_id` for carts, joined on the expired enrollment ids

Return `id` as well as `class_id` from the CTE so the items join is possible. If that proves awkward in one statement, the acceptable alternative is to **document the field as single-class-only** — but do not leave it silently wrong.

---

## Task 1: Branch from dev — DO THIS FIRST

- [ ] **Step 1: Preserve unrelated state**

```powershell
git status --short
```

Expect only the known untracked docs / `AGENTS.md` / `design_handoff_sponsor_placements/` and modified `.claude/settings.local.json`. If tracked `src/` or `supabase/` files are modified, stop.

- [ ] **Step 2: Branch**

```powershell
git fetch origin dev
git rev-list --left-right --count origin/dev...dev
```

Right-hand count must be `0`. A non-zero left count only means dev moved ahead — not a stop condition.

```powershell
git checkout dev
git pull --ff-only origin dev
git checkout -b fix/double-seat-restoration
git branch --show-current
```

- [ ] **Step 3: Record the baseline**

```powershell
npm test
```

Expect **exactly 1 failure — `src/__tests__/scanner/events.test.ts`** (pre-existing). Note the pass count.

---

## Task 2: Prove the bug with a failing integration test

There is no pgTAP in this project, and unit tests cannot exercise a Postgres trigger — a real database is required.

**Files:**
- Create: `src/__tests__/enrollment/seatRestoration.integration.test.ts`
- Create: `vitest.db.config.ts`
- Modify: `vitest.config.ts` — exclude `**/*.integration.test.ts` from ordinary runs
- Modify: `package.json` — add `test:db`

**The wiring belongs to this task, not the migration.** Task 2's red run *is* `npm run test:db`, so the config and script must exist first — and all four files are committed together.

> ⛔ **These tests must NOT run against the shared dev project.**
>
> `check_expired_enrollments()` takes no arguments and is **global** — it rejects every eligible enrollment across every tenant. Creating scoped fixtures and cleaning up in `afterEach` does **not** contain it: invoking it would reject unrelated dev enrollments belonging to other tenants and other people's testing, and could race the scheduled job. v1 asserted "must never touch pre-existing rows" while instructing exactly that. There is no way to scope a global function from the client.

**Required environment: an isolated, disposable database with the full migration chain.**

⚠️ **`supabase db reset` destroys all local data. `CLAUDE.md` requires explicit confirmation before running it.** Ask, and do not proceed without a clear yes. It touches only the local stack — never a remote project — but say so when asking.

```powershell
# Silenced: `supabase start` prints the local API URL and keys on success.
npx supabase start *> $null
if ($LASTEXITCODE -ne 0) { throw "Local Supabase failed to start." }

# Destroys all local data — ask for explicit confirmation BEFORE this line.
npx supabase db reset
if ($LASTEXITCODE -ne 0) { throw "Local database reset failed." }
```

`start` alone is not enough: an existing local volume may hold an older schema. `reset` re-runs every migration, which is the only way to be sure the local database is at the pre-fix state (058) for the red run.

**If the migration chain cannot rebuild cleanly, stop.** A broken chain invalidates both the red and green runs.

**Test wiring — these files are part of the change, not incidental:**

- `vitest.config.ts` — add `src/__tests__/**/*.integration.test.ts` to `test.exclude` so ordinary runs and CI do not require a local stack
- `package.json` — add a script that runs *only* those files:
  ```json
  "test:db": "vitest run --config vitest.db.config.ts"
  ```
- `vitest.db.config.ts` — a dedicated config whose `include` is the integration glob. **A shared config that unconditionally excludes the file would make `vitest run <path>` collect zero tests** — a separate config avoids that trap.

**Verify the command actually runs the suite** (not "0 tests passed") before trusting a green result.

**Credentials — non-echoing.** Do not display the keys, then claim not to display them:

The stack is already running from Task 2 Step 1 — do **not** start it again here.

```powershell
# Rename on capture so the test contract matches, and so a stray .env.local
# value can never satisfy the database-test config.
$mapped = npx supabase status -o env |
  ForEach-Object {
    $_ -replace '^API_URL=',          'SUPABASE_TEST_URL=' `
       -replace '^SERVICE_ROLE_KEY=', 'SUPABASE_TEST_SERVICE_KEY=' `
       -replace '^ANON_KEY=',         'SUPABASE_TEST_ANON_KEY='
  } |
  Select-String '^SUPABASE_TEST_'

# Verify all three were captured WITHOUT printing them — catches CLI output
# changes or a partial read, which would otherwise surface as an opaque
# "guard threw on undefined" much later.
if ($LASTEXITCODE -ne 0 -or @($mapped).Count -ne 3) {
  throw "Could not capture all required local Supabase test variables."
}

$mapped | Set-Content .env.test.local
```

The tests read **`SUPABASE_TEST_URL`**, **`SUPABASE_TEST_SERVICE_KEY`** and **`SUPABASE_TEST_ANON_KEY`** — deliberately distinct from the `NEXT_PUBLIC_*` names, so a shared `.env.local` cannot silently point the database suite at the dev project.

Capture, never echo. Then confirm `.env.test.local` is gitignored **before** the first run, and keep its contents out of tool output, diffs, commits and PR text. Local-only keys, but the habit is what protects the live ones.

The guard asserts the **isolated** target, not merely "not production":

```ts
// Local Supabase is 127.0.0.1/localhost. Anything else — including the shared
// dev project — is refused: this test invokes a GLOBAL expiry function.
const host = new URL(process.env.SUPABASE_TEST_URL!).hostname;
if (host !== "127.0.0.1" && host !== "localhost") {
  throw new Error(
    "Refusing to run: seat-restoration tests invoke a global function and " +
    "require an isolated database. Run `npx supabase start`.",
  );
}
```

Exclude this file from the default `vitest run` (a separate script, e.g. `test:db`) so CI and everyday runs do not require a local stack.

**Fixture isolation is mandatory even though the database is disposable.** `check_expired_enrollments()` is global, so one test's leftovers are the next test's input:

- **Create fixtures per test**, never shared across tests.
- **Record ids the moment each row is created**, so partial creation still cleans up.
- **Delete every fixture in `afterEach`**, in FK-safe order (`tickets` → `payments` → `enrollment_items` → `enrollments` → `classes` → `intakes` → `tenants`), and run it even when the test failed.
- **Force sequential execution** (`fileParallelism: false`, single-threaded pool) — parallel workers against one global function will interfere.
- The rollback test **must normalise or delete its INT_MAX fixture inside the same test**, and prove recovery there rather than relying on a later test running afterwards.

- [ ] **Step 1: Write the guard and fixtures**

Helper to create a class with a known `seat_total`/`seat_remaining`, an enrollment in `pending_payment` with `enrolled_at` far enough in the past to be expired for the tenant's `auto_cancel_hours`, then call the function and read `seat_remaining` back. Fixtures are per-test and torn down in `afterEach` — see the isolation rules above. A disposable database is not a substitute for cleanup when the function under test is global.

- [ ] **Step 2: Write the failing tests**

```ts
// THE BUG: one 1-seat order must free exactly 1 seat.
it("single-class quantity 1 restores exactly one seat", async () => {
  // class: seat_total 100, seat_remaining 99 (one sold)
  await expireNow();
  expect(await seatRemaining(classId)).toBe(100);   // today: 101 → clamped to 100 only because seat_total is 100
});

// Make the phantom visible below capacity, where LEAST() cannot mask it.
it("does not create phantom capacity below seat_total", async () => {
  // class: seat_total 100, seat_remaining 50
  await expireNow();
  expect(await seatRemaining(classId)).toBe(51);    // today: 52
});

it("single-class quantity 3 restores exactly three seats", async () => {
  // class: seat_total 100, seat_remaining 50, enrollment quantity 3
  await expireNow();
  expect(await seatRemaining(classId)).toBe(53);    // today: 54 (trigger +3, function +1)
});

// Carts are already correct — this is the regression guard.
it("cart enrollment restores each item exactly once", async () => {
  // items: classA qty 2, classB qty 1
  await expireNow();
  expect(await seatRemaining(classA)).toBe(startA + 2);
  expect(await seatRemaining(classB)).toBe(startB + 1);
});

it("aggregates correctly when several enrollments expire together", async () => {
  // three single-class enrollments on the same class, quantities 1, 2, 1
  await expireNow();
  expect(await seatRemaining(classId)).toBe(start + 4);   // today: start + 7
});

// Idempotency: the scheduled job runs repeatedly.
it("does not restore again on a second invocation", async () => {
  await expireNow();
  const after = await seatRemaining(classId);
  await expireNow();
  expect(await seatRemaining(classId)).toBe(after);
});

it("never exceeds seat_total", async () => {
  // class: seat_total 10, seat_remaining 10, plus an expiring enrollment
  await expireNow();
  expect(await seatRemaining(classId)).toBe(10);
});

it("leaves non-expired and already-rejected enrollments untouched", async () => {
  // one enrolled_at = now(), one already 'rejected'
  await expireNow();
  expect(await seatRemaining(classId)).toBe(start);
  expect(await enrollmentStatus(freshId)).toBe("pending_payment");
});

// The reopen path must survive removing the function's status flip.
it("reopens a full class when seats are freed", async () => {
  // class: status 'full', seat_remaining 0
  await expireNow();
  expect(await classStatus(classId)).toBe("open");
});

it("preserves the classes_updated field", async () => {
  const res = await expireNow();
  expect(res).toMatchObject({ success: true, expired_count: 1, classes_updated: 1 });
});

it("counts several enrollments on one class as one class affected", async () => {
  // three expiring enrollments, same class
  expect(await expireNow()).toMatchObject({ expired_count: 3, classes_updated: 1 });
});

// Carts have class_id NULL — a naive count would report 0 here.
it("counts the classes a cart touches", async () => {
  // one cart enrollment with items on two classes
  expect(await expireNow()).toMatchObject({ classes_updated: 2 });
});

it("counts the distinct union of single-class and cart classes", async () => {
  // single-class on A; cart touching A and B
  expect(await expireNow()).toMatchObject({ classes_updated: 2 });
});

// The function traps exceptions and returns { success: false }. Prove that
// leaves NOTHING half-applied — a partial rollback would be worse than the bug.
// Deterministic failure WITHOUT DDL: seat_remaining/seat_total are `integer`
// (000_combined_schema.sql:207-208, max 2147483647). The restore trigger
// evaluates `seat_remaining + quantity` BEFORE LEAST() can clamp, so setting
// both to INT_MAX makes PostgreSQL raise integer overflow *inside* the expiry
// transaction — precisely the window that must roll back.
it("rolls back completely when the function raises", async () => {
  await setClassSeats(classId, { seat_total: 2147483647, seat_remaining: 2147483647 });
  const before = { seats: await seatRemaining(classId), status: await enrollmentStatus(enrollId) };

  const res = await expireNow();               // trigger overflows; function traps it

  expect(res).toMatchObject({ success: false });
  expect(await seatRemaining(classId)).toBe(before.seats);
  expect(await enrollmentStatus(enrollId)).toBe(before.status);   // NOT 'rejected'

  // Recovery must be proven HERE, on the same poisoned fixture — a later test
  // gets a fresh fixture after afterEach and would only prove that ordinary
  // expiry works, not that this failed invocation can be retried.
  await setClassSeats(classId, { seat_total: 100, seat_remaining: 50 });

  const retry = await expireNow();

  expect(retry).toMatchObject({ success: true });
  expect(await enrollmentStatus(enrollId)).toBe("rejected");
  expect(await seatRemaining(classId)).toBe(51);   // restored exactly once
});

// Retained as an independent guard on the ordinary path; the recovery proof
// itself lives in the rollback test above, on the fixture that actually failed.
it("still expires normally after a failed invocation", async () => {
  await setClassSeats(classId, { seat_total: 100, seat_remaining: 50 });
  expect(await expireNow()).toMatchObject({ success: true });
  expect(await seatRemaining(classId)).toBe(51);
});

// ── ACL: red under migration 011, green after this migration ──────────────
// 011 grants EXECUTE to service_role but never REVOKEs the PostgreSQL default
// from PUBLIC, so anon/authenticated inherit it on a SECURITY DEFINER function.
it("lets service_role execute the expiry function", async () => {
  expect(await rpcAs("service_role")).toMatchObject({ success: true });
});

it("denies anon", async () => {
  const before = await seatRemaining(classId);
  await expect(rpcAs("anon")).rejects.toMatchObject({ code: "42501" });
  expect(await seatRemaining(classId)).toBe(before);
});

// `rpcAs("authenticated")` must be a REAL session, not the anon key relabelled:
//   1. create a unique local auth user (admin API)
//   2. sign in, obtain the JWT
//   3. build a client with that Authorization header
//   4. call the RPC
//   5. delete the user in afterEach
// The helper converts Supabase's resolved { data, error } into a throw so
// `.rejects` works — the client does not throw on RPC errors by default.
it("denies an authenticated user", async () => {
  const before = await seatRemaining(classId);
  await expect(rpcAs("authenticated")).rejects.toMatchObject({ code: "42501" });
  expect(await seatRemaining(classId)).toBe(before);
});
});
```

- [ ] **Step 3: Run — confirm the bug is real**

```powershell
npm run test:db
```

**Not `npx vitest run <path>`** — `vitest.config.ts` now excludes integration tests, so that would collect **zero** and report a hollow pass. **Assert the collected count matches the number of tests written** before reading any result.

**Expected: 18 collected, 11 passed, 7 failed** — exactly these:

| # | Test | Why it fails today |
|---|---|---|
| 1 | phantom capacity below `seat_total` | double restore, unmasked by `LEAST` |
| 2 | quantity 3 restores exactly three | trigger +3, function +1 |
| 3 | several enrollments aggregate | trigger + function per class |
| 4 | cart `classes_updated` = 2 | cart-blind count reports 0 |
| 5 | mixed single+cart `classes_updated` = 2 | reports 1 |
| 6 | anon denied | `PUBLIC` retains EXECUTE (migration 011) |
| 7 | authenticated denied | same |

**Record the actual numbers — they are the evidence for the PR.**

⚠️ **If any *other* test fails, or any of these seven passes unexpectedly, STOP** and inspect the test rather than the code. An unexpected pass usually means the test is not exercising what its name claims.

The reopen test and the single-class `classes_updated` tests **pass now** and must still pass after — they are the regression guards for what the migration deletes.

- [ ] **Step 4: Commit the failing test**

```powershell
git status --short
git add src/__tests__/enrollment/seatRestoration.integration.test.ts vitest.db.config.ts vitest.config.ts package.json
git diff --cached -- src/__tests__/enrollment/seatRestoration.integration.test.ts vitest.db.config.ts vitest.config.ts package.json
git commit -m "test: reproduce double seat restoration on auto-cancellation"
```

The commit includes the wiring, so the red run is reproducible by anyone checking out this commit.

```powershell
```

Committing red first makes the bug reviewable independently of the fix.

---

## Task 3: The migration

**Files:**
- Create: `supabase/migrations/<timestamp>_fix_double_seat_restoration.sql`

Test wiring was created and committed in Task 2. This task owns the migration only.

Use the timestamp naming already adopted (`20260715040300_sponsor_placements.sql`), not the legacy numeric prefix.

- [ ] **Step 1: Write the migration**

`CREATE OR REPLACE FUNCTION public.check_expired_enrollments()` — identical to 058 except:

1. **Delete the second `UPDATE public.classes`** and its `class_seats` CTE. Seat restoration is owned by `update_seat_remaining()` (049); `full → open` is owned by `trg_auto_reopen_class` (063).
2. **Derive `classes_updated` cart-aware.** A plain `count(DISTINCT class_id) … WHERE class_id IS NOT NULL` reports **0** for a cart-only expiry, because carts have `class_id = NULL`. Return both `id` and `class_id` from the CTE and count the distinct **union** of direct and cart classes:
   ```sql
   WITH expired AS (
     UPDATE public.enrollments e
     SET    status = 'rejected'
     FROM   public.tenants t
     WHERE  t.id = e.tenant_id
       AND  e.status = 'pending_payment'
       AND  t.auto_cancel_hours > 0
       AND  e.enrolled_at < now() - (t.auto_cancel_hours * interval '1 minute')
     RETURNING e.id, e.class_id
   ),
   affected AS (
     SELECT class_id FROM expired WHERE class_id IS NOT NULL
     UNION
     SELECT ei.class_id
     FROM   public.enrollment_items ei
     JOIN   expired x ON x.id = ei.enrollment_id
   )
   SELECT count(DISTINCT class_id)::integer INTO v_class_count FROM affected;
   ```
   `UNION` (not `UNION ALL`) plus `DISTINCT` handles a class appearing in both a single-class and a cart enrollment.
3. **Keep everything else byte-identical**: the eligibility predicate, `auto_cancel_hours > 0`, the early return when nothing expired, the `EXCEPTION` block, and the returned shape.
4. **Set the ACL explicitly — this is a security fix, not a redundant grant.**

   Migration 011 grants EXECUTE to `service_role` and comments *"Authenticated users and anon role cannot trigger expiry manually."* **The code does not implement that.** PostgreSQL grants `EXECUTE` to `PUBLIC` by default on functions, and **no migration ever REVOKEs it** (verified: `grep -rn "REVOKE.*check_expired_enrollments" supabase/migrations/` → nothing). The function is `SECURITY DEFINER`, so it runs with the owner's privileges and bypasses RLS. Preserving the existing privileges preserves that.

   ```sql
   REVOKE ALL ON FUNCTION public.check_expired_enrollments() FROM PUBLIC;
   REVOKE ALL ON FUNCTION public.check_expired_enrollments() FROM anon;
   REVOKE ALL ON FUNCTION public.check_expired_enrollments() FROM authenticated;
   GRANT EXECUTE ON FUNCTION public.check_expired_enrollments() TO service_role;
   ```

   Also confirm `SET search_path = public` is present on the function (it is `SECURITY DEFINER`).

   **Then verify — do not assume:**
   - `service_role` can still execute it
   - `anon` and `authenticated` cannot
   - **whatever actually schedules it can still execute it.** If a `pg_cron` job or Edge Function runs as another role, revoking PUBLIC could silently stop all expiry. **Identify the scheduler before pushing** — nothing in this repo calls the function, so its invoker is outside the codebase and must be confirmed in the Supabase dashboard.

   **VERIFIED in production, 2026-07-19** (read-only `SELECT`s, run by the owner):

   ```
   information_schema.routine_privileges → PUBLIC, anon, authenticated, service_role, postgres all hold EXECUTE
   cron.job → expire-pending-enrollments | postgres | SELECT public.check_expired_enrollments();
   ```

   So the hole is **confirmed, not inferred**: `anon` can invoke a SECURITY DEFINER mass-mutation. And the scheduler runs as **`postgres`** — the function owner, with its own explicit grant — so revoking PUBLIC/anon/authenticated **cannot break expiry**. The stop gate is cleared.

Include a comment stating the ownership decision and pointing at 049 and 063, so the next person doesn't "helpfully" restore seats here again.

- [ ] **Step 2: Identify the scheduler and current ACL — READ-ONLY, and a stop gate**

Nothing in this repo calls `check_expired_enrollments()`, so its invoker lives outside the codebase. **Revoking `PUBLIC` could silently stop all expiry** if the scheduler runs as another role. Answerable read-only — no need to execute the function:

```sql
-- who can execute it today
SELECT grantee, privilege_type
FROM   information_schema.routine_privileges
WHERE  routine_schema = 'public' AND routine_name = 'check_expired_enrollments';

-- what schedules it, and as whom
SELECT jobname, username, command
FROM   cron.job
WHERE  command ILIKE '%check_expired_enrollments%';
```

Run against **local first**, then production via an **approved dashboard/read-only surface** (`CLAUDE.md`: production DB is off limits to direct access).

Decide from the result:
- `pg_cron` running as the function owner → unaffected by the REVOKE
- an Edge Function using `service_role` → covered by the explicit GRANT
- any other legitimate invoker → give it its own narrow grant **in this migration**
- **scheduler identity unknown → STOP.** Do not push.

**RESOLVED 2026-07-19:** the job is `expire-pending-enrollments`, running as **`postgres`** (function owner). Unaffected by the REVOKE. This step is satisfied for the current production state — re-run it if the migration is delayed, since cron configuration can change.

After applying locally, prove the ACL with real clients: `service_role` can call the RPC; `anon` and `authenticated` get permission denied.

- [ ] **Step 3: Review the exact migration file — `CLAUDE.md` requires it**

```powershell
git diff -- supabase/migrations/
```

`supabase db diff` is **not** a substitute: it reports schema drift, not the file about to be applied.

- [ ] **Step 4: Apply LOCALLY and run the green tests**

`db push` targets the linked **remote** project — it will not update the running local stack. Rebuild local from the chain (confirm first, as above):

```powershell
npx supabase db reset
npm run test:db
```

**Expected: 18 collected, 18 passed.** **If the reopen or single-class `classes_updated` tests now fail, stop** — the deletion took something that was not redundant.

- [ ] **Step 5: Gates, then COMMIT — before touching remote dev**

If lint/build/commit fails after a push, dev holds a migration no commit represents.

```powershell
npm test
npm run lint
npm run build
git status --short
git add supabase/migrations/
git diff --cached -- supabase/migrations/
git commit -m "fix: stop restoring seats twice when an enrollment auto-cancels"
```

No new failures beyond the baseline; judge the build by **exit code**.

- [ ] **Step 6: Only now — fail closed on the link target, dry-run, push, verify**

Do not rely on remembering which project is linked — this repo has been linked to production during this session.

```powershell
$ref = (Get-Content "supabase/.temp/project-ref" -Raw).Trim()
if ($ref -ne "fnfvwzwrdsnmwxunciti") { throw "Refusing: Supabase is not linked to EduEnroll-dev (got $ref)." }
npx supabase db push --dry-run
npx supabase db push
```

Production (`nhxmumcvgnxlczjsgctz`) is off limits here — it ships through the normal reviewed workflow.

Then confirm the remote actually took it:

```powershell
npx supabase migration list
```

---

## Task 4: Open the PR

- [ ] **Step 1: Recheck state and review the diff**

```powershell
git branch --show-current
git status --short
git fetch origin dev
git rev-list --left-right --count origin/dev...HEAD
git diff --stat origin/dev...HEAD
```

Expected exactly: one migration, one integration test, `vitest.db.config.ts`, `vitest.config.ts`, `package.json`. Anything else is a stop condition.

- [ ] **Step 2: Open the PR** — base `dev`, **never self-merge**. Public repo: describe behaviour, not exploit recipes.

Include the **before/after numbers from Task 2's red run** — they are the clearest statement of impact.

---

## Post-deployment: audit existing phantom capacity

**The migration fixes future expirations. It does not repair `seat_remaining` values already inflated.** Every single-class enrollment that has auto-cancelled to date may have left a phantom seat.

- [ ] **Reconcile, read-only first.** For each class, compare `seat_remaining` against `seat_total` minus seats held by active enrollments (`pending_payment`, `payment_submitted`, `partial_payment`, `confirmed`), counting cart items too. Any class where `seat_remaining` exceeds the derived value has phantom capacity.
- [ ] **Run it on dev first** to validate the query.
- [ ] **For production, use an approved admin/reporting surface** — `CLAUDE.md` puts the production database off limits to direct access.
- [ ] **Correcting values is a separate, reviewed change.** Do not fold a data repair into this migration: the code fix should land and be verified on its own, and a repair needs its own before/after evidence.

⚠️ **Oversold classes may already exist.** If the audit finds a class whose active enrollments exceed `seat_total`, that is a customer-facing capacity problem needing a business decision, not a silent adjustment.

---

## Out of Scope

| Item | Why |
|---|---|
| Stripe ticket issuance / settlement RPC | Parked. Rewritten against the merged RPC afterwards, per the agreed sequence. |
| Repairing existing `seat_remaining` values | Needs its own before/after evidence and a business decision on any oversold class. |
| Other paths to `rejected` (admin, provider cancellations) | Already correct — they only fire the trigger. This migration removes the *duplicate*, so they are unaffected. |
| Consolidating 049 / 063 / expiry into one place | Tempting, but three triggers each doing one job is not the bug. The bug was one job done twice. |
