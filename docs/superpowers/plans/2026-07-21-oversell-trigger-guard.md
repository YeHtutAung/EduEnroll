# Oversell guard — plan v6

**Status:** for review. Do not implement.
**Supersedes:** v5 (existing unit tests unaccounted for; collection step ran the suite), v4 (red tests written after the red run; migration pushed before PR), v3 (guard laundered via `partial_payment`; G8 misclassified), v2
(admission oversell left open), v1.
**Deferred work tracked in:** #186 (notifications, outbox, reconciliation, RPC).
**Scope:** stop the live **admission** oversell — a late payment must never
create a second admissible customer for one seat. Carved out of the parked
settlement redesign (`2026-07-21-stripe-ticket-issuance.md`).

**Decision (2026-07-21):** admission-only. The misleading approval notification
that can still send for a refused confirmation is a **known, deferred** issue —
gating it needs the per-caller outcome contract, which is the settlement RPC's
job. Documented below, not fixed here.

---

## The bug, in full (verified)

A late payment against an expired (`rejected`) enrollment currently produces a
second admissible customer for one seat. Two independent failures combine:

1. **Status.** `fn_payments_sync_enrollment()` and **ten** application writers
   set the enrollment to `confirmed` with no state guard, so a `rejected`
   enrollment is re-confirmed.
2. **Admission.** `issueTicketsForEnrollment()` never checks enrollment status
   (`issueTickets.ts` selects `id, tenant_id, class_id, quantity` — no
   `status`), and the scanner accepts a ticket on the *ticket's* status alone
   (`scans/route.ts:72` checks `ticket.status`, not the enrollment). So a ticket
   issued for a rejected enrollment scans as valid.

v2 fixed only #1's status symptom. Because the trigger's silent refusal still
returns a *successful* UPDATE to the caller, the caller proceeds to
`issueTicketsForEnrollment()` and a valid ticket is minted for the rejected
enrollment. The oversell survived.

### The ten confirmation writers

2 Stripe browser routes (`intent/status`, `verify`), 2 status routes
(`abank/status`, `paypay/status`), 5 webhooks (abank, hitpay, mmpay, paypay,
stripe), and `verifyPayment()`. All set `confirmed` directly; all except the
browser routes then issue tickets.

## The fix — two complementary guards

Each closes the other's gap; both are required.

### Guard 1 (DB) — block `rejected → confirmed` at the enrollment table

A `BEFORE UPDATE OF status` trigger, so it covers the payment trigger *and* all
ten app writers (every path is an UPDATE on `enrollments.status`).

**`rejected` is terminal — block every transition out of it, not just
`→ confirmed`.** v3 blocked only `rejected → confirmed`, which is launderable:
`verifyPayment()`'s `request_remaining` sets `partial_payment` with no state
guard (`verifyPayment.ts:149`), so `rejected → partial_payment → confirmed`
walks straight through — the second hop's `OLD.status` is `partial_payment`, not
`rejected`. Making rejection terminal closes every such intermediate path.

```sql
CREATE OR REPLACE FUNCTION public.fn_block_reconfirm_rejected()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A rejected enrollment's seat was restored and possibly resold. Rejection is
  -- terminal: no automatic transition out of it. Silently keep it rejected
  -- rather than RAISE — the payment may already be verified, so raising would
  -- error a customer after money moved, and no status change means the AFTER
  -- seat trigger does not fire, leaving the resold seat intact.
  IF OLD.status = 'rejected' AND NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status := OLD.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_block_reconfirm_rejected
  BEFORE UPDATE OF status ON public.enrollments
  FOR EACH ROW EXECUTE FUNCTION public.fn_block_reconfirm_rejected();
```

Reinstating a rejected enrollment, if ever needed, must be a separate audited
operation with explicit capacity checking — never a bare status update.

Plus the v1 defense-in-depth predicate on `fn_payments_sync_enrollment()`'s
confirm branch (`AND status IN ('pending_payment','payment_submitted','partial_payment')`),
so the two agree.

### Guard 2 (application) — no *new* ticket without a confirmed enrollment

`issueTicketsForEnrollment()` must refuse to *issue* unless the enrollment is
currently `confirmed`. One place, covering all ticket-issuing callers.

**Scope of the claim, stated precisely:** the existing fast-path
`if ((count ?? 0) > 0) return` (`issueTickets.ts:29`) runs *before* the
enrollment load, so a rejected enrollment that *already* has a valid ticket is
untouched by this guard. That is fine for the target scenario — an
expired-before-payment enrollment has no ticket yet — but the guarantee is "no
**new** ticket is issued when the helper observes a non-confirmed enrollment",
not "no rejected enrollment ever has a valid ticket". Any pre-existing
valid-ticket / rejected-enrollment rows are already-scannable admissions this
guard does not repair; see the audit query in Rollout.

```ts
const { data: enrollment, error } = await supabase
  .from("enrollments")
  .select("id, tenant_id, class_id, quantity, status")   // + status
  .eq("id", enrollmentId)
  .maybeSingle();

// Throw on load failure: a DB error must not be read as "no ticket needed",
// which would silently skip fulfillment for a legitimately confirmed enrollment.
if (error) throw new Error(`issueTickets: enrollment load failed: ${JSON.stringify(error)}`);
if (!enrollment) return;

// The admission guard. A rejected/pending enrollment gets no ticket. Silent
// return, not throw: declining is correct behaviour, not an error.
if (enrollment.status !== "confirmed") {
  console.warn(`[tickets] skipped issuance for non-confirmed enrollment ${enrollmentId} (${enrollment.status})`);
  return;
}
```

Why both guards: without Guard 1 the enrollment actually becomes `confirmed`
and Guard 2 happily issues; without Guard 2 the enrollment stays `rejected` but
tickets issue anyway. Together: late payment → enrollment stays `rejected`
(Guard 1) → issuance declines (Guard 2) → no ticket, no admission.

This changes `issueTickets`'s enrollment-load from error-discarding to
throw-on-error — the narrow slice of the parked plan's fulfillment hardening
that Guard 2 depends on. The rest of that hardening (partial-set repair, etc.)
stays in the redesign.

### Guard 2 breaks the existing unit tests — in scope, not incidental

`src/__tests__/tickets/issueTickets.test.ts` must change with it. Verified:
its mock exposes `single: vi.fn()` (line 33) with **no `maybeSingle`**, and its
enrollment fixture type (lines 8-10) has `tenant_id, class_id, quantity` and
**no `status`**. So Guard 2 breaks it twice:

1. `maybeSingle is not a function`
2. after adding the method, existing happy-path fixtures have
   `status === undefined`, so Guard 2 declines and every ticket assertion fails

Required edits, plus new ordinary-suite coverage (this is the cheap place to
test Guard 2's branches — no database needed):

- add `status` to the enrollment fixture type; mark existing issuance fixtures
  `confirmed`
- add `maybeSingle` to the mock, with a configurable `{ data, error }` result
- new cases: rejected enrollment → **no ticket**; enrollment lookup error →
  **throws**; missing enrollment → returns normally; confirmed → still issues

These four mirror O3/G8 at the unit level; the db suite proves the same
behaviour end-to-end through the real trigger.

## Known, deferred: notification after refusal

When Guard 1 keeps an enrollment `rejected`, the confirming caller's UPDATE still
*succeeds* from its perspective, so a webhook may still send an approval email /
SMS / Telegram. That is a **misleading message, not an admission oversell** — no
second ticket exists. Fixing it means giving every confirming caller the actual
confirmation outcome, which is the settlement RPC. Tracked as part of the parked
redesign, not fixed here. This plan does **not** claim notification correctness.

## Tests (database-backed suite, local stack)

**Test signing key — unconditional override.** O3/O4/G1/G7 issue real tickets,
which calls `loadSigningKey()`. The db-suite setup must **generate an Ed25519
key in-process and assign the signing vars unconditionally**:

- generate the key inside `src/__tests__/db/setup.ts`
- assign `TICKET_SIGNING_KEY` / `TICKET_KID` (exact names confirmed against
  `loadSigningKey()`) with plain `=`
- **never** `??=`, `if (!process.env.X)`, or any ambient-preserving pattern —
  those let a developer's or hosted environment's real signing key leak into the
  suite
- never print the key

Otherwise a green run can fail for a missing-key reason, or silently sign with a
real key.

**Admission oversell — the real invariant, proven by capacity:**

| # | Case | Red today |
|---|---|---|
| O1 | 1-seat class; original reserves it; original rejected (seat restored); replacement confirmed (takes seat); original payment verifies late **via the payment trigger** → confirmed demand ≤ seat_total AND original has 0 tickets | **FAIL** — 2 admissible |
| O2 | same, late confirm via a **direct `UPDATE enrollments SET status='confirmed'`** (app-writer path) | **FAIL** — guard covers app writers |
| O3 | `issueTicketsForEnrollment` on a **rejected** enrollment → 0 tickets | **FAIL** — Guard 2 |
| O4 | **laundering:** `rejected → partial_payment → confirmed`, then issue → enrollment stays `rejected`, 0 tickets | **FAIL** — the v3 hole |

O1/O2 assert *confirmed demand* (Σ quantity over confirmed enrollments on the
class, single + cart) ≤ `seat_total`, **and** zero tickets on the original. O3
isolates Guard 2. O4 is the intermediate-state path v3 missed.

**Guards — happy path and every recreated branch still work (both phases):**

| # | Case |
|---|---|
| G1 | `pending_payment` → verify → `confirmed`, ticket issued |
| G2 | `payment_submitted` → verify → `confirmed` |
| G3 | `partial_payment` → verify → `confirmed` (Stripe charges the balance) |
| G4 | inserting a `pending` payment → enrollment `payment_submitted` |
| G5 | rejecting a payment → enrollment `rejected`, seat restored **once** |
| G6 | cart rejection restores each item seat once |
| G7 | `issueTickets` on a **confirmed** enrollment issues one ticket per seat |

**G8 is a RED, not a guard.** `issueTickets` today discards the enrollment-load
error (`const { data } = …; if (!enrollment) return`), so "load error → throws"
**fails before Guard 2 exists**. It belongs in the red set.

| # | Case | Red today |
|---|---|---|
| G8 | `issueTickets` when the enrollment load **errors** → throws (not silent skip) | **FAIL** |

**Expected red set: O1, O2, O3, O4, G8.** Both-phase guards: G1–G7. Each red
must fail for its named reason (two admissible / ticket exists / no throw), not
a fixture or signing-key error. **Exact collected/pass/fail counts are stated
after the suite is written and observed — not claimed in advance.**

### Fixture isolation

The existing db suite's discipline applies, and matters more here because these
tests deliberately create *rejected* enrollments and *oversold* states that
would poison neighbours:

- **Unique fixtures per test** — own tenant, intake, class(es); never shared.
  Class `level` is unique per intake, so generate it.
- **Record every created id at creation time**, not at teardown: a test that
  fails midway must still have recorded what it made.
- **FK-safe `afterEach` teardown**: tickets → payments → enrollment_items →
  enrollments → classes → intakes → tenants.
- **Teardown errors throw** — a silent cleanup failure leaves a
  `pending_payment` row that the next test's expiry sweep collects, failing an
  unrelated test.
- **Sequential execution** via the existing `vitest.db.config.ts`
  (`fileParallelism: false`, `maxWorkers: 1`).
- **Confirmed-demand assertions scoped to the fixture's class ids** — never a
  global aggregate, which other tests' rows would perturb.

## Implementation lifecycle (executable)

Same discipline as the seat-restoration and RPC-privilege work. The migration
must be tested against a database that has it applied — not the old local
schema.

1. Branch from clean `dev`.
2. Confirm the local stack is up (`supabase status`); do not print secrets.
3. **Write the tests first** — O1–O4, G1–G8, fixture builders and FK-safe
   teardown in `src/__tests__/db/oversell-guard.db.test.ts`; the unconditional
   test signing key in `src/__tests__/db/setup.ts`; and the
   `src/__tests__/tickets/issueTickets.test.ts` updates (mock `maybeSingle`,
   `status` on fixtures, the four new Guard 2 cases). The signing-key setup
   belongs **here**, in the red phase — otherwise O3/O4 fail for a missing-key
   reason rather than admission behaviour. (The lifecycle makes a single commit
   at step 12, after green; there is no separate red commit.)
4. **Collection only** — `npm run test:db` would execute the whole suite against
   whatever schema Docker currently holds, before Reset #1 establishes a known
   pre-fix state. Use a listing command instead (verified supported here):

   ```powershell
   npx vitest list --config vitest.db.config.ts
   if ($LASTEXITCODE -ne 0) { throw "Database test collection failed." }
   ```

   Confirm every intended O/G identity appears exactly once. If `list` is
   unavailable on a future Vitest, drop this step and treat the post-reset red
   run as the authoritative collection check — do not substitute a full run
   here.
5. **Request explicit confirmation for BOTH `supabase db reset --local` runs**
   (pre-fix red, post-migration green) before running either.
6. **Reset #1** → current schema. Run red: O1/O2/O3/O4/G8 must fail **for their
   named reasons** (two admissible / ticket exists / no throw), G1–G7 pass.
   Record observed counts.
7. Write `supabase/migrations/<ts>_block_reconfirm_rejected.sql` (both DB
   guards) and the `src/server/tickets/issueTickets.ts` change (Guard 2).
8. **Reset #2** (authorised in step 5) so the migration actually applies —
   editing a migration file does not change an already-built database.
9. Green db suite — all pass. Record observed counts.
10. `npm test`, `npm run lint`, `npm run build` — separately; judge the build by
    **exit code** (`next build` prints "Compiled successfully" then type-checks).
11. Resolve the concrete staged paths, then review and commit:

    ```powershell
    $migrations = @(Get-ChildItem -LiteralPath 'supabase/migrations' `
      -Filter '*_block_reconfirm_rejected.sql')
    if ($migrations.Count -ne 1) {
      throw "Expected exactly one oversell-guard migration, found $($migrations.Count)."
    }
    $paths = @(
      (Resolve-Path -Relative $migrations[0].FullName)
      'src/server/tickets/issueTickets.ts'
      'src/__tests__/tickets/issueTickets.test.ts'
      'src/__tests__/db/oversell-guard.db.test.ts'
      'src/__tests__/db/setup.ts'
      'docs/superpowers/plans/2026-07-21-oversell-trigger-guard.md'
    )
    git add -- $paths
    if ($LASTEXITCODE -ne 0) { throw "git add failed." }
    git diff --cached -- $paths
    git status --short   # nothing stray; no .env.test.local
    ```
12. Commit, push the feature branch, **open the PR**.
13. **Review and merge into `dev` — no self-merge.**

## Rollout — PR before any shared-database change

The migration must **not** reach the shared dev database before review. Applying
an unreviewed migration while the matching application guard exists only on a
feature branch is the avoidable risk here.

14. Confirm the dev code deployment.
15. Reconfirm the linked project is `fnfvwzwrdsnmwxunciti` (EduEnroll-dev);
    abort on anything else.
16. `supabase db push --dry-run` — must list exactly one migration; show the diff.
17. Apply to dev.
18. Run the read-only verification queries below.
19. Promote `dev → staging → main`, applying the migration per environment,
    verified before each promotion.

**On the ordering window.** Between merge (step 13) and migration (step 17), the
code guard is live without the DB guard. That is incomplete but **not worse than
today**: without Guard 1 the enrollment still becomes `confirmed`, so Guard 2
sees a confirmed enrollment and issues as it always did. The same is true in
reverse. Neither half regresses behaviour, which is why PR-first is safe.

Post-migration verification — observable only (no transition history exists to
prove "reached confirmed from rejected"):

```sql
-- 1. Guard installed.
SELECT tgname FROM pg_trigger WHERE tgname = 'trg_block_reconfirm_rejected';

-- 2. Refund cases to reconcile: verified payment, enrollment not confirmed.
SELECT e.id, e.enrollment_ref, e.status, p.paid_at
FROM public.enrollments e
JOIN public.payments p ON p.enrollment_id = e.id AND p.status = 'verified'
WHERE e.status <> 'confirmed'
ORDER BY p.paid_at DESC;

-- 3. Pre-existing oversell, if any: confirmed demand > capacity. Executable.
WITH demand AS (
  SELECT c.id, c.level, c.seat_total,
    COALESCE((SELECT SUM(COALESCE(e.quantity, 1)) FROM public.enrollments e
              WHERE e.class_id = c.id AND e.status = 'confirmed'), 0)
    + COALESCE((SELECT SUM(ei.quantity) FROM public.enrollment_items ei
                JOIN public.enrollments e2 ON e2.id = ei.enrollment_id
                WHERE ei.class_id = c.id AND e2.status = 'confirmed'), 0) AS confirmed_demand
  FROM public.classes c
)
SELECT id, level, seat_total, confirmed_demand
FROM demand WHERE confirmed_demand > seat_total
ORDER BY confirmed_demand - seat_total DESC;
```

Query 3 counts single-class demand (`e.class_id = c.id`) and cart demand
(`enrollment_items`) separately, which do not overlap: a single-class enrollment
has `class_id` set and no items; a cart enrollment has `class_id` null and items.
No double-counting.

```sql
-- 4. Already-scannable admissions Guard 2 does NOT repair: a valid ticket whose
-- enrollment is not confirmed. Rows here are pre-existing damage needing manual
-- voiding, distinct from the new-issuance the guard prevents.
SELECT t.id, t.enrollment_id, t.status, e.status AS enrollment_status
FROM public.tickets t
JOIN public.enrollments e ON e.id = t.enrollment_id
WHERE t.status = 'valid' AND e.status <> 'confirmed';
```

## Existing damage

Guard stops new oversell; does not undo booked ones. Query 3 sizes it read-only
after the guard ships, reconciled as its own action — same shape as the
seat-restoration Phase 5 audit. Not bundled here.
