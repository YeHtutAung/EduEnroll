# Promoting `staging` to `main` — production runbook

**Status:** for review
**Type:** release plan, not a code change
**Scale:** 152 commits, 12 unapplied migrations, 3 features that have never run in production

---

## What this promotion contains

`main` has not moved since PR #219. Everything below has been sitting on `dev`,
and all of it is on `staging` now:

| Feature | Notes |
|---|---|
| **KBZPay MMQR** | New payment provider. UAT-proven, **no production credentials yet** |
| **Event interest priority window** | Signup cutoff, priority tokens, rotation; 9 migrations |
| **Online platform fee** | Configurable per-tenant fee; 2 migrations |
| **E-ticket QR on the payment page** | Renderer extraction + fail-closed gating |
| Assorted | MMQR card branding, ticket artwork crop, scanner date bomb, typecheck clean, git identity |

## The merge is clean — verified, not assumed

A trial merge of `dev` into `main` was run locally and **completed with zero
conflicts**, and the merged tree passes everything:

| Check | Result |
|---|---|
| `git merge --no-commit --no-ff` | 0 conflicts |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` | exit 0, 1,105 tests |
| `npx next lint` | clean |
| `npm run build` | exit 0 |

### The one thing that looked like a blocker and is not

`main` carries a production-only fix `dev` has never had — `e13bc97`, which hides
the "X seats remaining" line on ticket cards (`SHOW_SEAT_COUNT = false`). It is
the **only** non-merge commit on `main` that `dev` lacks.

A promotion that *replaced* `main` would silently revert it and put seat counts
back in front of customers. A **merge** does not: `e13bc97` is an ancestor of
`main` and survives. Confirmed on the merged tree — `SHOW_SEAT_COUNT = false` is
still there, and `dev`'s priority-token code is present alongside it, both hunks
of the same file merged cleanly.

**Do not rebase, squash, or force-push this promotion.** The merge is what
preserves that fix.

---

## ⚠️ Migrations go first. This is not a preference.

**12 migrations are in the repo but not on `main`, and none are applied to the
production database:**

```
20260820120000_kbzpay_mmqr.sql
20260827120000_event_interest_priority_window.sql
20260827120100_enrollment_rpc_priority_token.sql
20260828120000_rotate_interest_token.sql
20260828120100_rollback_interest_rotation.sql
20260829120000_rotate_checks_revocation.sql
20260830120000_interest_signup_cutoff.sql
20260830120100_cutoff_locks_intake.sql
20260830120200_cart_aggregates_duplicate_classes.sql
20260830130000_priority_window_triggers_secdef.sql
20260902120000_platform_fee.sql
20260903090000_payments_platform_fee.sql
```

Shipping the code first breaks **every payment-creation path, for every tenant**,
fee configured or not — the routes pass the fee unconditionally as `0`:

| Path | Failure |
|---|---|
| abank, hitpay, mmpay, paypay, upload | `PGRST204` HTTP 400 — unknown column `platform_fee` |
| kbzpay, stripe, stripe/intent | `PGRST202` HTTP 404 — unknown argument `p_platform_fee` |

Both reproduced against a real PostgREST, not reasoned about.

The reverse order is safe by construction: `payments.platform_fee` is
`DEFAULT 0`, and the three `SECURITY DEFINER` functions take the fee as a
**trailing `DEFAULT 0` parameter**, so the currently-deployed code keeps working
against the migrated schema. Covered by a database test.

### Two migration hazards specific to this set

1. **`20260903090000` drops and recreates three `SECURITY DEFINER` functions**
   (`claim_kbzpay_order_slot`, `complete_kbzpay_supersede`,
   `finalize_stripe_payment_attempt`) and re-applies their `REVOKE`/`GRANT`.
   `DROP` takes the grants with it and PostgreSQL grants `EXECUTE` to `PUBLIC`
   on the replacement — if the grant half does not run, those functions become
   callable through PostgREST. Verify privileges after applying.

2. **Production's functions are probably stored with CRLF.** Dev's were, because
   they were applied by pasting into the SQL editor. That breaks any `prosrc`
   hash guard and any server-side string patching. Apply the migration **files**
   (`db push`) rather than pasting, and the problem does not arise.

---

## Environment variables production does not have

These are **not one group**. Only one is needed for this release; the rest are
needed only if a production tenant is turned onto KBZPay, which this release
does not do.

**Required for this release:**

| Variable | If unset |
|---|---|
| `INTEREST_IP_SECRET` | `/api/public/interest` returns 500 per request |

**Required only before enabling a KBZPay tenant — not part of this release:**

| Variable | If unset |
|---|---|
| `KBZPAY_APPID`, `KBZPAY_MERCH_CODE`, `KBZPAY_APP_KEY` | KBZPay calls fail |
| `KBZPAY_MODE` | **throws on a production deployment** — see below |
| `KBZPAY_NOTIFY_ORIGIN`, `KBZPAY_PROXY_URL` | callback/egress config |

Setting the KBZPay group now is not wrong, just unnecessary: nothing in this
promotion exercises it while every tenant's `mmqr_provider` stays unset. Do not
let "set them all while we're in here" become the reason `KBZPAY_MODE` ends up
configured before credentials do — that is exactly the state `resolveMode()`
throws on.

Set them with `printf`, not `echo` — a trailing newline breaks HMAC signatures.

### KBZPay is not production-ready, and the code knows it

`resolveMode()` **throws** when `VERCEL_ENV === "production"` and `KBZPAY_MODE`
is anything other than `"production"`. That is deliberate: it refuses to send
production credentials to the plaintext UAT gateway. Production credentials have
**not been issued by KBZ yet**.

So before promoting, one of these must be true:

- production KBZPay credentials exist and `KBZPAY_MODE=production` is set; **or**
- **no production tenant has `mmqr_provider = 'kbzpay'`**, so the path is never
  entered.

The second is the expected answer today, and it is a read-only check — see the
authorized-operator gate below, which covers this alongside the migration
review rather than as a separate ad hoc query.

---

## Runbook

### Step 0 — Authorized-operator gate (required before anything below touches production)

This workspace does not run production queries or migrations unsupervised —
[[feedback-no-touch-prod]] — so this is not "run these checks," it is a handoff
to whoever has that access, with a defined stop condition.

1. An authorized operator runs the read-only checks:
   - `supabase migration list` (or equivalent) against production — the applied
     migration history.
   - Each production tenant's `mmqr_provider` and `platform_fee_mode`.
2. That operator (or this workspace, handed the output) evaluates all three
   results against their own stop condition. Each is independent — a pass on
   one does not excuse a failure on another, and all three must pass before
   step 3.

   **Migration list** — diff the observed applied-migration list against the
   12 expected above.
   - **Matches the 12 exactly** — pass.
   - **Does not match** — stop. Do not apply anything. A smaller pending set
     means some of the 12 already landed through a path this plan does not know
     about; a larger or different one means production has drifted from what
     this plan was written against. Either way the migration diff has to be
     re-derived by hand before proceeding, not applied on the assumption that
     "12" is still correct.

   **`mmqr_provider`** — check every tenant.
   - **No tenant is `'kbzpay'`** — pass.
   - **Some tenant is `'kbzpay'`** — stop, unless production KBZPay credentials
     (`KBZPAY_APPID`, `KBZPAY_MERCH_CODE`, `KBZPAY_APP_KEY`) and the rest of the
     KBZPay configuration (`KBZPAY_MODE=production`, `KBZPAY_NOTIFY_ORIGIN`,
     `KBZPAY_PROXY_URL`) are already set and ready in Vercel Production *before*
     this deployment goes out. `resolveMode()` throws on a production
     deployment with an unrecognised `KBZPAY_MODE`, so shipping with that
     tenant live and the configuration incomplete is not a degraded state —
     it is every KBZPay call on that tenant failing outright the moment the
     new code deploys.

   **`platform_fee_mode`** — check every tenant.
   - **Every tenant is `'none'`** — pass.
   - **Some tenant is not `'none'`** — stop. Either deliberately set it back to
     `'none'` before merging (the fee-off default this plan otherwise assumes),
     or obtain explicit approval that fees going live on that tenant AT THE
     MOMENT `main` deploys is intended. Silently proceeding is not acceptable:
     an operator who set a non-default fee earlier, for testing or otherwise,
     may not be the same person running this release, and this promotion must
     not be the thing that turns a fee on in production as a side effect.
3. The operator reviews the actual migration diff (the SQL, not just the
   filenames) and gives **explicit approval to apply**.
4. Only then does step 1 below run, by or under that same operator.

### Steps

1. **Apply the 12 migrations to production**, in filename order, from the
   files, under the authorization obtained in Step 0. Verify afterwards: the
   three functions exist with the new arity, exactly one of each, and
   `anon`/`authenticated` cannot execute them.
2. **`platform_fee_mode` is already confirmed by Step 0** — this step is not a
   second check, it is the reminder that "every tenant `'none'`" was the pass
   condition that let this deployment proceed at all. Turn fees on per-tenant
   afterwards, deliberately, never as a side effect of this merge.
3. **Set `INTEREST_IP_SECRET`** in Vercel Production. Leave the KBZPay
   variables unset unless Step 0 found production credentials ready and a
   tenant about to be switched to `kbzpay` — see the environment-variables
   section above.
4. **Open the PR `staging` → `main`.** Merge, do not rebase or squash.
5. **CI/CD deploys.** No manual `vercel --prod`.
6. **Smoke-test in production**, in this order: an existing bank-transfer
   enrollment (the path with the most tenants behind it), then a paid order's
   confirmation screen, then an e-ticket download and a physical scan.

## Rollback

- **Code:** revert the merge commit and redeploy. The migrations are additive
  and the old code runs against the new schema, so a code-only rollback is safe
  and is the first response to anything unexpected.
- **Schema:** `20260903090000` documents its own reversal. Do not roll migrations
  back to fix a code problem — the ordering constraint runs the other way.

## What this plan cannot tell you

The production database is off limits to this workspace, so **every claim about
what production currently has is inferred from the repo and from notes, not
observed**. Specifically unverified: which migrations are actually applied,
which tenants exist, their `mmqr_provider` and `platform_fee_mode`, and whether
the three functions are CRLF. Each is answered by the Step 0 handoff above, not
by this workspace running a query against production directly.

Local success is not evidence about production, and dev is not evidence about
prod. The trial merge, the test suite and the build were all run here.
