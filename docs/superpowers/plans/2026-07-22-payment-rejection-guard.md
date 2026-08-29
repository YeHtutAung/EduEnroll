# Plan A — a failed payment must not reject an enrollment another payment paid for

**Status:** for review
**Ships:** before the Stripe settlement work, which depends on it
**Type:** live seat-integrity bug, provider-independent

---

## The bug

`fn_payments_sync_enrollment()`'s rejection branch has no predicate at all:

```sql
IF TG_OP = 'UPDATE' AND OLD.status != 'rejected' AND NEW.status = 'rejected' THEN
  UPDATE enrollments SET status = 'rejected'
    WHERE id = NEW.enrollment_id;      -- unconditional
END IF;
```

So:

1. Payment A verifies → enrollment `confirmed`, tickets issued, seat held.
2. A stale Payment B on the same enrollment is later rejected.
3. The trigger rejects the **confirmed** enrollment.
4. `update_seat_remaining()` restores the seat; it is resold.
5. The original buyer holds a valid ticket for a seat someone else now owns.

This is reachable **today** through any payment rejection — an admin rejecting a
superseded attempt, a provider failure callback, the HitPay failed branch. It is
not specific to Stripe; Stripe's `checkout.session.async_payment_failed` merely
makes it reachable from a webhook.

## Why an application-level check cannot fix it

Reading the enrollment, deciding, then writing is a read-then-write race: two
deliveries can both read "not yet confirmed". The decision has to be a predicate
inside the same statement.

## The predicate

```sql
IF TG_OP = 'UPDATE' AND OLD.status != 'rejected' AND NEW.status = 'rejected' THEN
  UPDATE enrollments SET status = 'rejected'
   WHERE id = NEW.enrollment_id
     -- 1. Ownership: a payment failure may only reject a pre-confirmation
     --    enrollment. Cancelling a CONFIRMED enrollment is a different
     --    operation with different obligations (tickets, capacity, refund) and
     --    must not happen as a side effect of a payment status change.
     AND status IN ('pending_payment', 'payment_submitted', 'partial_payment')
     -- 2. Concurrency: no OTHER payment may be verified *or still active*.
     AND NOT EXISTS (
       SELECT 1 FROM payments p
        WHERE p.enrollment_id = NEW.enrollment_id
          AND p.id <> NEW.id
          AND p.status IN ('verified', 'awaiting_payment', 'pending')
     );
END IF;
```

### Why `verified` alone is not enough

The dangerous interleaving is concurrent, not sequential:

| | Payment A | Payment B |
|---|---|---|
| t1 | `UPDATE … SET status='verified'` begins | |
| t2 | | `UPDATE … SET status='rejected'` begins |
| t3 | | reads A's row — under READ COMMITTED sees the **pre-update** value |
| t4 | | if the predicate only tested `verified`, A looks harmless → B rejects |
| t5 | commits; trigger tries to confirm | |
| t6 | blocked by `trg_block_reconfirm_rejected` (#187) — rejection is terminal | |

Result: paid, rejected, no ticket, seat released.

Including `awaiting_payment` and `pending` closes it, because the state B can
actually see for A is exactly one of those. No advisory lock or serializable
isolation needed.

### Ownership change — deliberate, and a behaviour change

Condition 1 means **rejecting a payment on a `confirmed` enrollment no longer
rejects the enrollment.** That is intended: a generic payment failure and an
operator-initiated cancellation are different operations, and only the latter
should release a seat that has already been sold and ticketed.

Cancelling a confirmed enrollment properly — voiding tickets, releasing capacity,
recording the reason — is **out of scope here** and needs its own audited path.
Until it exists, an operator who needs that outcome must do it deliberately
rather than by rejecting a payment. This is called out in the PR description so
it is not discovered later as a regression.

## Migration

Recreates `fn_payments_sync_enrollment()` with the INSERT and confirm branches
**verbatim from #187** and only the rejection branch changed, so the two controls
cannot disagree about eligibility.

### Baseline guard — resolve the exact function, then assert its shape

A `prosrc LIKE '%pending_payment%'` check is not a baseline assertion. It passes
when a same-named function exists in another schema, when an overload exists,
when the words appear in a comment, or when the confirm branch has materially
changed but still contains those tokens — and the migration would then overwrite
the whole function believing it had verified the baseline.

Resolve the exact object first, then assert structure:

```sql
DO $$
DECLARE
  fn_oid      oid;
  actual_hash text;
  n_overloads int;
BEGIN
  -- Exact resolution: schema-qualified, zero-argument.
  fn_oid := to_regprocedure('public.fn_payments_sync_enrollment()');
  IF fn_oid IS NULL THEN
    RAISE EXCEPTION 'baseline: public.fn_payments_sync_enrollment() does not exist';
  END IF;

  -- No overloads may exist: a second signature means an ambiguous baseline.
  SELECT count(*) INTO n_overloads
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'fn_payments_sync_enrollment';
  IF n_overloads <> 1 THEN
    RAISE EXCEPTION 'baseline: expected exactly 1 overload, found %', n_overloads;
  END IF;

  -- Signature, return type, security mode, search_path.
  PERFORM 1
     FROM pg_proc p
    WHERE p.oid = fn_oid
      AND p.pronargs   = 0
      AND p.prorettype = 'pg_catalog.trigger'::regtype
      AND p.prosecdef  IS TRUE                       -- SECURITY DEFINER
      AND p.proconfig @> ARRAY['search_path=public'];
  IF NOT FOUND THEN
    RAISE EXCEPTION 'baseline: unexpected signature, return type, security mode or search_path';
  END IF;

  -- Exact baseline: a fixed, reviewed hash of prosrc. No normalisation.
  --
  -- Two earlier drafts of this guard were wrong in instructive ways:
  --
  --   1. Substring sniffing — asserting one string present and another absent.
  --      A drifted branch carrying some OTHER predicate passes that.
  --   2. Normalised comparison — it stripped comments from the actual body but
  --      not from the expected one, and the #187 body HAS comments, so it could
  --      never match. It would have failed on a correct baseline.
  --
  -- Normalisation is the wrong tool here anyway. lower() can hide a semantic
  -- change inside a case-sensitive string literal (status values are literals),
  -- and collapsing whitespace can alter literal content. This migration
  -- replaces an entire SECURITY DEFINER function, so ANY drift — even
  -- cosmetic — should stop the deployment and be looked at by a human.

  SELECT md5(p.prosrc) INTO actual_hash FROM pg_proc p WHERE p.oid = fn_oid;

  IF actual_hash <> '<REVIEWED_187_PROSRC_MD5>' THEN
    RAISE EXCEPTION
      'baseline: fn_payments_sync_enrollment differs from the reviewed #187 baseline (got %); refusing to replace it',
      actual_hash;
  END IF;
END $$;
```

### Deriving the hash — ordering is the whole trick

`<REVIEWED_187_PROSRC_MD5>` is a **fixed constant in the migration**, not a
placeholder resolved at apply time. It must come from a fresh disposable
database rebuilt through #187 — never from shared dev, never from production,
and never from whatever function happens to be installed locally, which would
bless existing drift as the baseline.

**The hash must be captured BEFORE the Plan A migration file exists.** Once
that file is in `supabase/migrations/`, `db reset` replays it too — the rebuild
no longer stops at #187, and the "clean baseline" would already contain the fix
this guard is supposed to be guarding.

This workspace is PowerShell with the CLI via `npx`, there is no bare `psql`,
and `db reset` is gated on explicit user confirmation. The sequence:

1. Branch from current `dev`. Do **not** create the migration file yet.
2. Start the local stack.
3. **Ask the user to confirm** `npx supabase db reset --local` — ideally
   covering both resets in this sequence (step 4 and step 9) in one approval.
4. Reset. The migration chain ends at #187, so the rebuilt function is the
   reviewed baseline by construction.
5. Obtain the local DB URL from the existing test configuration **without
   printing it**, and assert its host is `127.0.0.1` / `localhost` before
   connecting — a guard against the URL quietly pointing elsewhere.
6. Query through the project's existing `pg` dependency (the db-test stack):

   ```js
   const { rows } = await pool.query(
     `SELECT md5(p.prosrc) AS h
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.fn_payments_sync_enrollment()')`);
   ```

7. **Now** create the Plan A migration file with that value pasted as the
   constant.
8. Mechanical stop checks before the file is committed:
   - the literal `<REVIEWED_187_PROSRC_MD5>` appears **nowhere** in the file
     (`rg -n "REVIEWED_187_PROSRC_MD5" supabase/migrations/` → no matches);
   - the constant matches `^[0-9a-f]{32}$` — exactly one 32-character
     lowercase-hex literal in the guard.
9. Reset again (covered by the same approval) so the full chain **including**
   the new migration replays: proves the guard passes against the clean #187
   baseline and the fix applies on top of it.

That value is then reviewed as part of the diff like any other constant.

The baseline is the **pre-fix** body, so a second run fails: after this migration
the function no longer hashes to it, and re-applying silently is exactly what a
guard exists to stop.

**If the hash mismatches on production, do not force it.** A mismatch means the
installed function is not the reviewed #187 body — perhaps applied by a different
route with different whitespace, perhaps genuinely drifted. Diff the installed
`prosrc` against the migration and decide deliberately; the guard has done its
job by stopping.

## The active-payment invariant this depends on

Condition 2 protects an enrollment when another payment row is `verified`,
`awaiting_payment` or `pending`. That is only sound while **an active row
reflects a genuinely live payment attempt**.

Today that holds: both creation routes insert the payment row before the buyer
can confirm, and #188 made them fail closed rather than hand out credentials they
could not record.

It stops holding if a *superseded* attempt is left `awaiting_payment` after a
replacement is created — a dead row would then look like protection and keep a
seat held that should have been released. **Plan B owns that lifecycle** and must
mark the superseded row terminal only after the replacement row is safely
recorded.

Stated here because Plan A silently depends on it, and tested by T9 below.

## Tests — database, real triggers

| # | Case | Asserts |
|---|---|---|
| T1 | A verified → confirmed; **stale B rejected** | enrollment stays `confirmed`, seat **not** restored, tickets intact |
| T2 | single payment rejected on a pending enrollment | enrollment `rejected`, seat restored — existing behaviour preserved |
| T3 | B rejected while **another payment is still `awaiting_payment`** | enrollment untouched (the race guard, tested directly) |
| T4 | B rejected while another is `pending` | as T3 |
| T5 | **concurrent** verify + reject, both orderings | never ends `rejected` with a verified payment present |
| T6 | payment rejected on an already-`confirmed` enrollment | enrollment stays confirmed — the ownership change, pinned |
| T7 | rejection of an already-`rejected` enrollment | no change — #187 still holds |
| T8 | migration guard | fails loudly against a non-#187 baseline |
| T9 | **dead active row** — superseded payment left `awaiting_payment`, real attempt rejected | documents the invariant: the enrollment is *not* rejected, which is why Plan B must retire superseded rows |
| T10a | correct `public` function **and** a same-named function in another schema | guard **passes** — the other schema is irrelevant |
| T10b | `public` function wrong or absent, matching function **only** in another schema | guard **fails** — proves another schema cannot satisfy the baseline |
| T11 | guard run twice | second run fails: the body no longer hashes to the pre-fix baseline |
| T12 | **hash mutation** — a single character changed in the installed function | guard fails, proving the constant is not vacuous |

T5 uses two real connections with **explicit synchronisation points** — B's
`UPDATE` is not issued until A's transaction has issued its own and is confirmed
open-but-uncommitted — and a per-step timeout. Without both, "tested in both
orderings" can pass while the intended interleaving never actually occurred.

### Phase matrix — to be recorded during implementation, not asserted now

Nothing is implemented yet, so no run has happened. Not every test should be red
either; claiming a blanket red phase would be false.

| Tests | Expected against the current baseline |
|---|---|
| T1, T3, T4, T5, T6, T9 | **fail** — they name the defect |
| T2, T7 | **pass** — regression guards for behaviour that must not change |
| T8, T10a, T10b, T11, T12 | migration-safety; not behavioural red tests |

The **observed** counts must be recorded in the PR, not predicted here.

## Deployment

1. Branch from `dev`; migration + tests
2. Apply to dev; full suite
3. PR → `dev` → staging
4. **You** apply to production (gated path)
5. Stripe settlement work (Plan B) depends on this being live

## Out of scope

- An audited "cancel a confirmed enrollment" operation — needed, separate
- Historical repair of enrollments already wrongly rejected by this bug.
  **Worth an audit before launch** — but the query below returns
  **reconciliation candidates, not proven corruption**. The same shape is
  produced legitimately by a late payment arriving against an already-rejected
  enrollment, which #187 deliberately allows and records as a refund case.

  **No automatic repair.** Each row needs payment history, ticket state,
  capacity, timestamps and provider status inspected before anything changes:

  ```sql
  SELECT e.id, e.enrollment_ref, e.status, p.id AS payment_id, p.status
    FROM enrollments e JOIN payments p ON p.enrollment_id = e.id
   WHERE e.status = 'rejected' AND p.status = 'verified';
  ```
