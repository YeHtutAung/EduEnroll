# CB Bank MMQR Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let tenant `beatsrun` take MMQR payments through CB Bank into its own merchant account (YOUNG MONEY), with no path to double collection, the wrong merchant, or settlement on an unverified callback.

**Architecture:** A new provider beside KBZPay, mirroring it module for module. A pure client (`src/lib/cbmmqr.ts`) talks to CB's QR Gateway; per-merchant credentials come from `CBMMQR_<ID>_*`; a `service_role`-only table assigns tenants to merchants and every payment row is pinned to the merchant that created it. Four `SECURITY DEFINER` RPCs own the order slot, the QR store, replacement and settlement binding. Callbacks only trigger our own status check; settlement goes through a CB wrapper and then the existing `settleMmqrPayment()`, unchanged.

**Tech Stack:** Next.js 14 route handlers, TypeScript, Supabase Postgres (plpgsql, RLS), undici, Vitest (`npm test`, `npm run test:db`).

**Spec:** `docs/superpowers/specs/2026-10-31-cb-mmqr-integration-design.md` (PR #329). Read it first; § numbers below refer to it. KBZPay is the model throughout: `src/lib/kbzpay.ts`, `src/app/api/public/payments/kbzpay/**`, `src/app/api/webhooks/kbzmmqr/route.ts`, `src/server/payments/resolveKbzpayOrder.ts`, `supabase/migrations/20261030120000_kbzpay_per_tenant_merchants.sql` and their tests. When this plan says "as KBZPay", open the KBZPay file and copy its structure.

---

## Ground rules for whoever executes this

- Work on a branch off `origin/dev`: `git fetch origin && git switch -c feature/cb-mmqr origin/dev`. Before the first commit, `git config user.email` must print `yehtutaung.yha@gmail.com`; if it doesn't, stop.
- Show `git status` and `git diff` before every commit.
- **Never** run `supabase db push`, `supabase db reset` or `supabase link` against anything but `fnfvwzwrdsnmwxunciti` (dev). Task 14 applies the migration to the **dev** DB, and only after the owner says yes. Production is off limits.
- Never print a real `CBMMQR_*` value. Refer to variables by name.
- Judge tests, `tsc` and builds by **exit code**.
- Don't run `npm run build` while `npm run dev` is running; that corrupts `.next`.
- The repo is public. Commit messages describe behaviour, never an exploit recipe.
- **Do not change** any KBZPay, ABank or MMPay file except where a task says so (`settleMmqrPayment.ts` is called, never edited).
- No CB credentials exist yet. Everything up to Task 13 is built and tested against mocks and the local database. UAT (Task 15) waits for CB.

## Where this plan refines the spec

These were settled while writing the plan. The spec in PR #329 was updated to match **before** implementation (plan review #6); Task 13 only re-checks it.

| Spec | Plan | Why |
|---|---|---|
| `CBMMQR_TIMEZONE=Asia/Yangon` (§5.0, §6) | `CBMMQR_UTC_OFFSET=+06:30` | Parsing an IANA zone needs a library; Myanmar has one fixed offset and no DST. |
| `CBMMQR_<ID>_NOTIFY_ORIGIN` (§6) | removed | CB's `/dynamicqr` takes no callback URL; the URL is registered with CB out of band, so nothing would read the variable. |
| §4.1 `src/server/payments/cbmmqrMerchant.ts` | `getCbMerchant()` lives in `src/lib/cbmmqr.ts` | Same place as `getKbzMerchant()` in `kbzpay.ts`. |
| §4.3 claim: "no assignment → raises" | claim returns `invalid_enrollment` / `no_merchant` outcomes | Same outcomes as `claim_kbzpay_order_slot`; the route maps them to 409 / 503. |
| §5.1 step 8 "one conditional update" | `store_cbmmqr_qr` RPC | The enrollment re-check must happen under a lock, which a PostgREST update cannot do. |
| §5.4 `PENDING \| SUCCESS \| FAILED` | `PENDING \| SUCCESS` only | Nothing in the CB flow needs `FAILED`; a retired row reports `PENDING` and the modal's retry path takes over. |
| §4.2 `src/mocks/handlers.ts` | not touched | KBZPay has no MSW handlers either; tests mock `fetch` and the client module. |
| §7.2 modal "states" | error states are the routes' `message` text | The modal already shows `body.message` on any non-2xx; only the countdown and the expired-QR view are new UI. |

## File map

| File | Change | Responsibility |
|---|---|---|
| `supabase/migrations/20261031120000_cbmmqr.sql` | Create | Assignments table, pin + `provider_order_ref` columns, CHECK, trigger, indexes, four RPCs |
| `src/__tests__/db/cbmmqr-order-slot.db.test.ts` | Create | RPCs, trigger, indexes and grants against the real local DB |
| `src/lib/cbmmqr.ts` | Create | Pure client: merchant config, reference, timestamps, return codes, token cache, `createDynamicQr`, `checkStatus` |
| `src/__tests__/payments/cbmmqr-client.test.ts` | Create | Client unit tests |
| `src/__tests__/payments/cbmmqr-merchant.test.ts` | Create | `getCbMerchant` unit tests |
| `src/server/payments/cbmmqrOrderWindow.ts` | Create | Pre-check and post-check against the enrollment deadline |
| `src/__tests__/payments/cbmmqr-order-window.test.ts` | Create | Window unit tests |
| `src/server/payments/settleCbmmqrPayment.ts` | Create | Field checks → `bind_cbmmqr_settlement` → `settleMmqrPayment()` |
| `src/__tests__/payments/cbmmqr-settle.test.ts` | Create | Wrapper unit tests |
| `src/server/payments/resolveCbmmqrOrder.ts` | Create | `isConfirmedDead`, unresolved-row procedure |
| `src/__tests__/payments/cbmmqr-resolve.test.ts` | Create | Resolver unit tests |
| `src/app/api/public/payments/cbmmqr/route.ts` | Create | `POST` create |
| `src/__tests__/payments/cbmmqr-create-route.test.ts` | Create | Create-route tests |
| `src/app/api/public/payments/cbmmqr/status/route.ts` | Create | `GET` status |
| `src/__tests__/payments/cbmmqr-status-route.test.ts` | Create | Status-route tests |
| `src/app/api/webhooks/cbmmqr/route.ts` | Create | `POST` callback |
| `src/__tests__/payments/cbmmqr-webhook-route.test.ts` | Create | Webhook tests |
| `public/cbmmqr/myanmarpay-banner.png`, `public/cbmmqr/cb-bank-logo.png` | Create | Assets from CB's WebFrame sample |
| `src/components/payments/CbMmqrCard.tsx` | Create | CB's WebFrame card as a 500×725 SVG |
| `src/__tests__/payments/cbMmqrCard.test.tsx` | Create | Card geometry |
| `src/components/payments/QRPaymentModal.tsx` | Modify | `cbmmqr` provider, endpoint, card, countdown, expired-QR view |
| `src/__tests__/payments/cbmmqr-modal.test.ts` | Create | `interpretCreateResponse` expiry, `qrCountdown` |
| `src/app/(public)/enroll/[slug]/checkout/payment/page.tsx` | Modify | Provider union and mapping (`:649`, `:698-701`, `:814`) |
| `src/app/(public)/enroll/payment/[ref]/page.tsx` | Modify | Provider union (`:58`) |
| `src/app/admin/settings/page.tsx` | Modify | Provider union and option (`:539`, `:607`, `:1399-1405`) |
| `src/types/database.ts` | Modify | `mmqr_provider` union (`:131`); `Payment` gains `cbmmqr_merchant`, `provider_order_ref` |
| `src/__tests__/payments/cbmmqr-provider-dispatch.test.ts` | Create | `cbmmqr` never falls through to MMPay |
| `.env.local.example` | Modify | `CBMMQR_*` |
| `docs/superpowers/specs/2026-10-31-cb-mmqr-integration-design.md` | Modify | The refinements above |
| `docs/clients/beatsrun.md` | Modify | Env var names, how to assign the merchant |

---

### Task 1: Migration

**Files:**
- Create: `supabase/migrations/20261031120000_cbmmqr.sql`

- [ ] **Step 1: Confirm the facts the SQL relies on**

```bash
grep -n "subdomain" supabase/migrations/000_combined_schema.sql | head -3
grep -n "payment_method\|bank_reference" supabase/migrations/000_combined_schema.sql | head -5
grep -rn "FUNCTION public.set_updated_at" supabase/migrations | head -1
ls supabase/migrations | sort | tail -3
```

Expected: `tenants.subdomain` exists (BeatsRun's is `beatsrun`); `payments.payment_method` and `payments.bank_reference` are plain `text` with no CHECK listing methods; `set_updated_at()` exists (`068_tenant_telegram_configs.sql`); `20261030120000_kbzpay_per_tenant_merchants.sql` is the newest migration. If any differs, stop and report — the SQL below assumes all of them.

- [ ] **Step 2: Write the migration**

```sql
-- ─── CB Bank MMQR ───────────────────────────────────────────────────────────
-- Spec: docs/superpowers/specs/2026-10-31-cb-mmqr-integration-design.md §4.3
--
-- Mirrors 20261030120000_kbzpay_per_tenant_merchants.sql. Nothing here touches
-- a KBZPay, ABank or MMPay row: every constraint and index is scoped to
-- payment_method = 'cb_mmqr', and the trigger ignores other rows.
--
-- ROLLBACK (safe only while no cb_mmqr payment exists):
--   DROP FUNCTION IF EXISTS public.bind_cbmmqr_settlement(text, text, text, text);
--   DROP FUNCTION IF EXISTS public.store_cbmmqr_qr(text, text, text, timestamptz);
--   DROP FUNCTION IF EXISTS public.complete_cbmmqr_replace(uuid, uuid, text, text, text, integer, timestamptz, integer);
--   DROP FUNCTION IF EXISTS public.claim_cbmmqr_order_slot(uuid, uuid, text, integer, timestamptz, integer);
--   DROP TRIGGER IF EXISTS trg_protect_payment_cbmmqr_fields ON public.payments;
--   DROP FUNCTION IF EXISTS public.protect_payment_cbmmqr_fields();
--   DROP INDEX IF EXISTS public.idx_payments_one_live_cbmmqr_order;
--   DROP INDEX IF EXISTS public.idx_payments_cbmmqr_transaction_unique;
--   DROP INDEX IF EXISTS public.idx_payments_provider_order_ref_unique;
--   ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_cbmmqr_merchant_required;
--   ALTER TABLE public.payments DROP COLUMN IF EXISTS provider_order_ref;
--   ALTER TABLE public.payments DROP COLUMN IF EXISTS cbmmqr_merchant;
--   DROP TABLE IF EXISTS public.cbmmqr_merchant_assignments;

-- Fail fast rather than queue every payment read behind ADD COLUMN's lock.
SET LOCAL lock_timeout = '5s';

-- ── 1. Tenant → merchant mapping ────────────────────────────────────────────
-- Not a tenants column: tenant owners can update their own tenant row, and the
-- mapping is the operator's alone.
CREATE TABLE public.cbmmqr_merchant_assignments (
  tenant_id   uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE RESTRICT,
  merchant_id text NOT NULL CHECK (merchant_id ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Keeps updated_at truthful when the operator reassigns a tenant.
CREATE TRIGGER cbmmqr_merchant_assignments_updated_at
  BEFORE UPDATE ON public.cbmmqr_merchant_assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.cbmmqr_merchant_assignments ENABLE ROW LEVEL SECURITY;
-- No policies: anon and authenticated can neither read nor write.
REVOKE ALL ON public.cbmmqr_merchant_assignments FROM public, anon, authenticated;
-- The operator manages assignments as service_role. The RPCs run as owner and
-- do not need this; without it the operator could not manage assignments.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cbmmqr_merchant_assignments TO service_role;

INSERT INTO public.cbmmqr_merchant_assignments (tenant_id, merchant_id)
SELECT id, 'YOUNGMONEY' FROM public.tenants WHERE subdomain = 'beatsrun'
ON CONFLICT (tenant_id) DO NOTHING;

-- A NOTICE, not an exception: an environment without BeatsRun is legitimate.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE subdomain = 'beatsrun') THEN
    RAISE NOTICE 'cbmmqr: no tenant with subdomain beatsrun; no YOUNGMONEY assignment inserted';
  END IF;
END;
$$;

-- ── 2. Columns, CHECK, indexes ──────────────────────────────────────────────
ALTER TABLE public.payments ADD COLUMN cbmmqr_merchant text;
ALTER TABLE public.payments ADD COLUMN provider_order_ref text;

COMMENT ON COLUMN public.payments.cbmmqr_merchant IS
  'CB merchant id (CBMMQR_<ID>_*) that created this order. Written once at insert by claim_cbmmqr_order_slot / complete_cbmmqr_replace; immutable (trg_protect_payment_cbmmqr_fields). NULL for every other payment method.';
COMMENT ON COLUMN public.payments.provider_order_ref IS
  'CB qrReferenceNo, used for the status check. cb_mmqr rows only; NULL -> value once, never changed (trg_protect_payment_cbmmqr_fields).';

-- No backfill: no cb_mmqr row exists yet.
ALTER TABLE public.payments
  ADD CONSTRAINT payments_cbmmqr_merchant_required
  -- Both directions, null-safe: a CB row must carry a pin, and no other row may.
  CHECK ((payment_method IS NOT DISTINCT FROM 'cb_mmqr') = (cbmmqr_merchant IS NOT NULL));

CREATE UNIQUE INDEX idx_payments_provider_order_ref_unique
  ON public.payments (provider_order_ref)
  WHERE provider_order_ref IS NOT NULL;

-- One CB transaction can settle one payment.
CREATE UNIQUE INDEX idx_payments_cbmmqr_transaction_unique
  ON public.payments (bank_reference)
  WHERE payment_method = 'cb_mmqr' AND bank_reference IS NOT NULL;

-- At most ONE live CB order per enrollment, enforced by the database.
CREATE UNIQUE INDEX idx_payments_one_live_cbmmqr_order
  ON public.payments (enrollment_id)
  WHERE payment_method = 'cb_mmqr'
    AND status = 'awaiting_payment'
    AND mmqr_status = 'PENDING';

-- ── 3. Trigger: pin, tenant, provider_order_ref, bank_reference ─────────────
-- A NEW function; protect_payment_kbzpay_merchant() is not reused or changed.
-- SECURITY INVOKER: inside the SECURITY DEFINER RPCs it runs as their owner and
-- can read the assignments table; a direct PostgREST insert carrying a pin
-- fails on the revoked table.
CREATE OR REPLACE FUNCTION public.protect_payment_cbmmqr_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_assigned text;
BEGIN
  -- provider_order_ref belongs to CB rows only.
  IF new.provider_order_ref IS NOT NULL
     AND new.payment_method IS DISTINCT FROM 'cb_mmqr' THEN
    RAISE EXCEPTION 'provider_order_ref is only valid on cb_mmqr payments' USING errcode = '42501';
  END IF;

  IF tg_op = 'UPDATE' THEN
    IF new.cbmmqr_merchant IS DISTINCT FROM old.cbmmqr_merchant THEN
      RAISE EXCEPTION 'payments.cbmmqr_merchant is immutable' USING errcode = '42501';
    END IF;
    IF new.tenant_id IS DISTINCT FROM old.tenant_id AND old.cbmmqr_merchant IS NOT NULL THEN
      RAISE EXCEPTION 'a pinned CB payment cannot move tenant' USING errcode = '42501';
    END IF;
    -- NULL -> value once; never changed or cleared afterwards.
    IF old.provider_order_ref IS NOT NULL
       AND new.provider_order_ref IS DISTINCT FROM old.provider_order_ref THEN
      RAISE EXCEPTION 'payments.provider_order_ref is write-once' USING errcode = '42501';
    END IF;
    IF old.payment_method = 'cb_mmqr'
       AND old.bank_reference IS NOT NULL
       AND new.bank_reference IS DISTINCT FROM old.bank_reference THEN
      RAISE EXCEPTION 'bank_reference on a cb_mmqr payment is write-once' USING errcode = '42501';
    END IF;
    RETURN new;
  END IF;

  IF new.cbmmqr_merchant IS NOT NULL THEN
    SELECT a.merchant_id INTO v_assigned
      FROM public.cbmmqr_merchant_assignments a
     WHERE a.tenant_id = new.tenant_id;

    IF v_assigned IS DISTINCT FROM new.cbmmqr_merchant THEN
      RAISE EXCEPTION 'cbmmqr_merchant does not match the tenant assignment' USING errcode = '42501';
    END IF;
  END IF;

  RETURN new;
END;
$$;

CREATE TRIGGER trg_protect_payment_cbmmqr_fields
  BEFORE INSERT OR UPDATE OF cbmmqr_merchant, tenant_id, provider_order_ref, bank_reference, payment_method
  ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.protect_payment_cbmmqr_fields();

-- ── 4. claim_cbmmqr_order_slot ──────────────────────────────────────────────
-- Same contract as claim_kbzpay_order_slot (20261030120000), plus three output
-- columns the CB route needs to decide an unresolved row (spec §5.2).
CREATE FUNCTION public.claim_cbmmqr_order_slot(
  p_enrollment_id uuid,
  p_tenant_id     uuid,
  p_payment_ref   text,
  p_amount        integer,
  p_expires_at    timestamptz,
  p_platform_fee  integer DEFAULT 0
)
RETURNS TABLE (
  outcome    text,
  payment_id uuid,
  ref        text,
  qr         text,
  merchant   text,
  expires_at timestamptz,
  order_ref  text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_live     public.payments%ROWTYPE;
  v_tenant   uuid;
  v_new_id   uuid;
  v_merchant text;
BEGIN
  -- Serialise creators AND re-prove ownership and status under the lock: the
  -- route's earlier check is a TOCTOU read (same reasoning as KBZPay's claim).
  SELECT e.tenant_id INTO v_tenant
    FROM public.enrollments e
   WHERE e.id        = p_enrollment_id
     AND e.tenant_id = p_tenant_id
     AND e.status IN ('pending_payment', 'partial_payment')
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_enrollment'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::text, NULL::timestamptz, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO v_live
    FROM public.payments
   WHERE enrollment_id  = p_enrollment_id
     AND payment_method = 'cb_mmqr'
     AND status         = 'awaiting_payment'
     AND mmqr_status    = 'PENDING'
   LIMIT 1;

  -- reuse / unresolved return the EXISTING row's pin, never the current
  -- assignment: removing an assignment must not strand an order already live.
  IF FOUND THEN
    IF v_live.amount = p_amount
       AND v_live.platform_fee = p_platform_fee
       AND v_live.provider_qr IS NOT NULL
       AND v_live.provider_order_expires_at IS NOT NULL
       AND v_live.provider_order_expires_at > now()
    THEN
      RETURN QUERY SELECT 'reuse'::text, v_live.id, v_live.payment_ref, v_live.provider_qr,
                          v_live.cbmmqr_merchant, v_live.provider_order_expires_at,
                          v_live.provider_order_ref, v_live.created_at;
    ELSE
      RETURN QUERY SELECT 'unresolved'::text, v_live.id, v_live.payment_ref, NULL::text,
                          v_live.cbmmqr_merchant, v_live.provider_order_expires_at,
                          v_live.provider_order_ref, v_live.created_at;
    END IF;
    RETURN;
  END IF;

  -- FOR SHARE holds the assignment until commit, so a concurrent reassignment
  -- cannot make the trigger's re-read disagree.
  SELECT a.merchant_id INTO v_merchant
    FROM public.cbmmqr_merchant_assignments a
   WHERE a.tenant_id = v_tenant
     FOR SHARE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_merchant'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::text, NULL::timestamptz, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- 'awaiting_payment', never 'pending': the INSERT branch of
  -- trg_payments_sync_enrollment fires on 'pending' (migration 054).
  INSERT INTO public.payments (
    enrollment_id, tenant_id, amount, platform_fee, payment_ref, payment_method,
    mmqr_status, status, provider_order_expires_at, cbmmqr_merchant
  ) VALUES (
    p_enrollment_id, v_tenant, p_amount, p_platform_fee, p_payment_ref, 'cb_mmqr',
    'PENDING', 'awaiting_payment', p_expires_at, v_merchant
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'created'::text, v_new_id, p_payment_ref, NULL::text,
                      v_merchant, p_expires_at, NULL::text, now();
END;
$$;

REVOKE ALL ON FUNCTION public.claim_cbmmqr_order_slot(uuid, uuid, text, integer, timestamptz, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_cbmmqr_order_slot(uuid, uuid, text, integer, timestamptz, integer)
  TO service_role;

-- ── 5. store_cbmmqr_qr ──────────────────────────────────────────────────────
-- Spec §5.1 steps 7-8. Stores CB's answer for a live row, re-checking the
-- enrollment under its lock. CB's reference and expiry are ALWAYS stored for a
-- live row (they are what lets §5.2 resolve it later); the QR only when p_qr is
-- non-null AND the enrollment is still payable.
--   stored       — written (with the QR if one was given)
--   not_payable  — reference and expiry written, QR withheld
--   not_live     — the row is no longer the live order; nothing written
--   ref_conflict — a different provider_order_ref is already stored
--   not_found    — no such cb_mmqr payment
CREATE FUNCTION public.store_cbmmqr_qr(
  p_payment_ref text,
  p_qr          text,
  p_order_ref   text,
  p_expires_at  timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enrollment_id uuid;
  v_status        public.enrollments.status%TYPE;
  v_pay           public.payments%ROWTYPE;
BEGIN
  SELECT p.enrollment_id INTO v_enrollment_id
    FROM public.payments p
   WHERE p.payment_ref = p_payment_ref AND p.payment_method = 'cb_mmqr';
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  -- Lock order matches the claim: enrollment, then payment.
  SELECT e.status INTO v_status
    FROM public.enrollments e
   WHERE e.id = v_enrollment_id
   FOR UPDATE;

  SELECT * INTO v_pay
    FROM public.payments
   WHERE payment_ref = p_payment_ref AND payment_method = 'cb_mmqr'
   FOR UPDATE;

  IF v_pay.status <> 'awaiting_payment' OR v_pay.mmqr_status IS DISTINCT FROM 'PENDING' THEN
    RETURN 'not_live';
  END IF;

  IF v_pay.provider_order_ref IS NOT NULL AND v_pay.provider_order_ref <> p_order_ref THEN
    RETURN 'ref_conflict';
  END IF;

  IF v_status IN ('pending_payment', 'partial_payment') AND p_qr IS NOT NULL THEN
    UPDATE public.payments
       SET provider_qr = p_qr,
           provider_order_ref = p_order_ref,
           provider_order_expires_at = p_expires_at
     WHERE id = v_pay.id;
    RETURN 'stored';
  END IF;

  UPDATE public.payments
     SET provider_order_ref = p_order_ref,
         provider_order_expires_at = p_expires_at
   WHERE id = v_pay.id;
  RETURN CASE WHEN p_qr IS NULL THEN 'stored' ELSE 'not_payable' END;
END;
$$;

REVOKE ALL ON FUNCTION public.store_cbmmqr_qr(text, text, text, timestamptz)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_cbmmqr_qr(text, text, text, timestamptz)
  TO service_role;

-- ── 6. complete_cbmmqr_replace ──────────────────────────────────────────────
-- Spec §4.3. Only called after the route has PROVEN the old QR dead (§5.2).
-- No SUPERSEDED: nothing can be superseded while it is still payable.
CREATE FUNCTION public.complete_cbmmqr_replace(
  p_enrollment_id    uuid,
  p_tenant_id        uuid,
  p_expected_old_ref text,
  p_reason           text,
  p_new_ref          text,
  p_amount           integer,
  p_expires_at       timestamptz,
  p_platform_fee     integer DEFAULT 0
)
RETURNS TABLE (outcome text, payment_id uuid, merchant text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old               public.payments%ROWTYPE;
  v_tenant            uuid;
  v_enrollment_status public.enrollments.status%TYPE;
  v_new_id            uuid;
  v_merchant          text;
BEGIN
  IF p_reason NOT IN ('EXPIRED', 'FAILED') THEN
    RAISE EXCEPTION 'invalid reason: %', p_reason;
  END IF;

  -- Ownership on every path; status checked only just before the write, so the
  -- 'already_settled' case (enrollment now confirmed) is reported, not refused
  -- (KBZPay R11).
  SELECT e.tenant_id, e.status
    INTO v_tenant, v_enrollment_status
    FROM public.enrollments e
   WHERE e.id        = p_enrollment_id
     AND e.tenant_id = p_tenant_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_enrollment'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- FOR UPDATE: bind_cbmmqr_settlement locks this same row. Taking the lock
  -- here makes a replace that races a settlement wait for the bind to commit,
  -- and then see its bank_reference below (plan review #1).
  SELECT * INTO v_old
    FROM public.payments
   WHERE enrollment_id  = p_enrollment_id
     AND payment_ref    = p_expected_old_ref
     AND payment_method = 'cb_mmqr'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  IF v_old.status = 'verified' THEN
    RETURN QUERY SELECT 'already_settled'::text, v_old.id, NULL::text;
    RETURN;
  END IF;

  -- A bound transaction means CB has reported this order PAID and settlement
  -- is under way (bind commits before settleMmqrPayment transitions the row).
  -- Retiring it now would issue a second payable QR for a paid enrollment.
  IF v_old.bank_reference IS NOT NULL THEN
    RETURN QUERY SELECT 'settling'::text, v_old.id, NULL::text;
    RETURN;
  END IF;

  IF v_old.status <> 'awaiting_payment' OR v_old.mmqr_status IS DISTINCT FROM 'PENDING' THEN
    RETURN QUERY SELECT 'not_live'::text, v_old.id, NULL::text;
    RETURN;
  END IF;

  IF v_enrollment_status NOT IN ('pending_payment', 'partial_payment') THEN
    RETURN QUERY SELECT 'not_payable'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT a.merchant_id INTO v_merchant
    FROM public.cbmmqr_merchant_assignments a
   WHERE a.tenant_id = v_tenant
     FOR SHARE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_merchant'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  UPDATE public.payments
     SET mmqr_status = p_reason
   WHERE id = v_old.id;

  INSERT INTO public.payments (
    enrollment_id, tenant_id, amount, platform_fee, payment_ref, payment_method,
    mmqr_status, status, provider_order_expires_at, cbmmqr_merchant
  ) VALUES (
    p_enrollment_id, v_tenant, p_amount, p_platform_fee, p_new_ref, 'cb_mmqr',
    'PENDING', 'awaiting_payment', p_expires_at, v_merchant
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'replaced'::text, v_new_id, v_merchant;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_cbmmqr_replace(uuid, uuid, text, text, text, integer, timestamptz, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_cbmmqr_replace(uuid, uuid, text, text, text, integer, timestamptz, integer)
  TO service_role;

-- ── 7. bind_cbmmqr_settlement ───────────────────────────────────────────────
-- Spec §5.5 step 1. Binds CB's qrReferenceNo and transactionId to this payment
-- under a row lock, BEFORE settleMmqrPayment() transitions it. A replay with
-- the same values is 'bound'; anything different is refused.
CREATE FUNCTION public.bind_cbmmqr_settlement(
  p_payment_ref     text,
  p_qr_reference_no text,
  p_transaction_id  text,
  p_merchant        text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pay        public.payments%ROWTYPE;
  v_constraint text;
BEGIN
  SELECT * INTO v_pay
    FROM public.payments
   WHERE payment_ref = p_payment_ref AND payment_method = 'cb_mmqr'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF v_pay.cbmmqr_merchant IS DISTINCT FROM p_merchant
     OR coalesce(p_transaction_id, '') = ''
     OR coalesce(p_qr_reference_no, '') = ''
     OR (v_pay.provider_order_ref IS NOT NULL AND v_pay.provider_order_ref <> p_qr_reference_no)
     OR (v_pay.bank_reference IS NOT NULL AND v_pay.bank_reference <> p_transaction_id)
  THEN
    RETURN 'mismatch';
  END IF;

  BEGIN
    UPDATE public.payments
       SET provider_order_ref = p_qr_reference_no,
           bank_reference     = p_transaction_id
     WHERE id = v_pay.id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RETURN CASE WHEN v_constraint = 'idx_payments_cbmmqr_transaction_unique'
                THEN 'duplicate_transaction' ELSE 'mismatch' END;
  END;

  RETURN 'bound';
END;
$$;

REVOKE ALL ON FUNCTION public.bind_cbmmqr_settlement(text, text, text, text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_cbmmqr_settlement(text, text, text, text)
  TO service_role;

-- ── 8. Documentation ────────────────────────────────────────────────────────
COMMENT ON COLUMN public.tenants.mmqr_provider IS
  'abank | mmpay | kbzpay | cbmmqr — only used when payment_mode = mmqr';
```

- [ ] **Step 3: Apply it to the LOCAL stack only**

The local Supabase stack must be running (`npx supabase status` shows it). Then:

```bash
npx supabase migration up --local
```

Expected: exit code 0 and `20261031120000_cbmmqr.sql` applied. This is the local Docker database, not `db push`.

- [ ] **Step 4: Commit**

```bash
git status
git diff --stat
git add supabase/migrations/20261031120000_cbmmqr.sql
git commit -m "feat(cbmmqr): migration for CB Bank MMQR orders and merchant pinning"
```

---

### Task 2: Database tests for the migration

**Files:**
- Create: `src/__tests__/db/cbmmqr-order-slot.db.test.ts`

These run against the real local database (`npm run test:db`), like `kbzpay-order-slot.db.test.ts`. Row locks, partial unique indexes and triggers cannot be mocked.

- [ ] **Step 1: Write the harness**

Copy `src/__tests__/db/kbzpay-order-slot.db.test.ts:1-170` (pool, `sql`, `AMOUNT`, `future`, `past`, `Tracked`, `uniq`, `beforeAll`, `afterEach`, `afterAll`) and change only what follows.

```ts
const REF = (n: number) => `CB${String(n).padStart(23, "A")}`; // 25 chars, like buildReferenceNo()

type ClaimRow = {
  outcome: string; payment_id: string | null; ref: string | null; qr: string | null;
  merchant: string | null; expires_at: string | null; order_ref: string | null; created_at: string | null;
};

const claim = (enrollmentId: string, tenantId: string, ref: string, amount = AMOUNT,
               expiresAt: string = future(), platformFee = 0) =>
  sql<ClaimRow>(
    `SELECT * FROM public.claim_cbmmqr_order_slot($1,$2,$3,$4,$5::timestamptz,$6)`,
    [enrollmentId, tenantId, ref, amount, expiresAt, platformFee],
  );

const replace = (enrollmentId: string, tenantId: string, oldRef: string, reason: string, newRef: string) =>
  sql<{ outcome: string; payment_id: string | null; merchant: string | null }>(
    `SELECT * FROM public.complete_cbmmqr_replace($1,$2,$3,$4,$5,$6,$7::timestamptz,0)`,
    [enrollmentId, tenantId, oldRef, reason, newRef, AMOUNT, future()],
  );

const store = async (ref: string, qr: string | null, orderRef: string) =>
  (await sql<{ r: string }>(`SELECT public.store_cbmmqr_qr($1,$2,$3,$4::timestamptz) AS r`,
    [ref, qr, orderRef, future()]))[0].r;

const bind = async (ref: string, qrRef: string, txn: string, merchant = "YOUNGMONEY") =>
  (await sql<{ r: string }>(`SELECT public.bind_cbmmqr_settlement($1,$2,$3,$4) AS r`,
    [ref, qrRef, txn, merchant]))[0].r;
```

In `makeWorld({ enrollmentStatus = "pending_payment", merchant = "YOUNGMONEY" })` insert into `cbmmqr_merchant_assignments` instead of `kbzpay_merchant_assignments`. `seedLive()` becomes:

```ts
async function seedLive(
  enrollmentId: string, tenantId: string, ref: string,
  opts: { qr?: string | null; amount?: number; expiresAt?: string; merchant?: string; orderRef?: string | null } = {},
) {
  const { qr = "0002010102QR", amount = AMOUNT, expiresAt = future(), merchant = "YOUNGMONEY", orderRef = null } = opts;
  const [p] = await sql<{ id: string }>(
    `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_ref, payment_method, mmqr_status,
                           status, provider_qr, provider_order_expires_at, cbmmqr_merchant, provider_order_ref)
     VALUES ($1,$2,$3,$4,'cb_mmqr','PENDING','awaiting_payment',$5,$6::timestamptz,$7,$8) RETURNING id`,
    [enrollmentId, tenantId, amount, ref, qr, expiresAt, merchant, orderRef],
  );
  return p.id;
}
```

`liveRows()` filters `payment_method='cb_mmqr'`. The `afterEach` deletes from `cbmmqr_merchant_assignments`.

- [ ] **Step 2: Write the tests**

```ts
describe("claim_cbmmqr_order_slot", () => {
  it("created: one PENDING awaiting_payment row pinned to the assignment", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const [r] = await claim(enrollmentId, tenantId, REF(1));
    expect(r.outcome).toBe("created");
    expect(r.merchant).toBe("YOUNGMONEY");
    const [row] = await sql(`SELECT status, mmqr_status, cbmmqr_merchant FROM payments WHERE id=$1`, [r.payment_id]);
    expect(row).toEqual({ status: "awaiting_payment", mmqr_status: "PENDING", cbmmqr_merchant: "YOUNGMONEY" });
  });

  it("reuse: same amount, stored QR, inside the expiry", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: "0002QR" });
    const [r] = await claim(enrollmentId, tenantId, REF(2));
    expect(r.outcome).toBe("reuse");
    expect(r.qr).toBe("0002QR");
    expect(r.expires_at).toBeTruthy();
  });

  it.each([
    ["a different amount", { amount: AMOUNT + 1 }],
    ["no stored QR", { qr: null }],
    ["a passed expiry", { expiresAt: past() }],
  ])("unresolved with %s, returning the old row's reference; inserts nothing", async (_n, opts) => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { ...opts, orderRef: "QR-1" });
    const [r] = await claim(enrollmentId, tenantId, REF(2));
    expect(r).toMatchObject({ outcome: "unresolved", ref: REF(1), order_ref: "QR-1", merchant: "YOUNGMONEY" });
    expect(await liveRows(enrollmentId)).toHaveLength(1);
  });

  it("invalid_enrollment for another tenant's enrollment or a rejected one", async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    expect((await claim(a.enrollmentId, b.tenantId, REF(1)))[0].outcome).toBe("invalid_enrollment");
    const r = await makeWorld({ enrollmentStatus: "rejected" });
    expect((await claim(r.enrollmentId, r.tenantId, REF(2)))[0].outcome).toBe("invalid_enrollment");
  });

  it("no_merchant without an assignment, and inserts nothing", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ merchant: null });
    expect((await claim(enrollmentId, tenantId, REF(1)))[0].outcome).toBe("no_merchant");
    expect(await liveRows(enrollmentId)).toHaveLength(0);
  });

  it("two concurrent claims leave exactly one live row", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const results = await Promise.allSettled([
      claim(enrollmentId, tenantId, REF(1)),
      claim(enrollmentId, tenantId, REF(2)),
    ]);
    const created = results.filter((r) => r.status === "fulfilled" && r.value[0].outcome === "created");
    expect(created).toHaveLength(1);
    expect(await liveRows(enrollmentId)).toHaveLength(1);
  });
});

describe("store_cbmmqr_qr", () => {
  const read = async (ref: string) =>
    (await sql(`SELECT provider_qr, provider_order_ref FROM payments WHERE payment_ref=$1`, [ref]))[0];

  it("stored: QR, reference and expiry on a live row of a payable enrollment", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null });
    expect(await store(REF(1), "0002QR", "QR-1")).toBe("stored");
    expect(await read(REF(1))).toEqual({ provider_qr: "0002QR", provider_order_ref: "QR-1" });
  });

  it("not_payable: enrollment rejected meanwhile — reference stored, QR withheld", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null });
    await sql(`UPDATE enrollments SET status='rejected' WHERE id=$1`, [enrollmentId]);
    expect(await store(REF(1), "0002QR", "QR-1")).toBe("not_payable");
    expect(await read(REF(1))).toEqual({ provider_qr: null, provider_order_ref: "QR-1" });
  });

  it("stored without a QR when p_qr is null (post-check failed)", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null });
    expect(await store(REF(1), null, "QR-1")).toBe("stored");
    expect(await read(REF(1))).toEqual({ provider_qr: null, provider_order_ref: "QR-1" });
  });

  it("ref_conflict when a different reference is already stored", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null, orderRef: "QR-1" });
    expect(await store(REF(1), "0002QR", "QR-2")).toBe("ref_conflict");
  });

  it("not_live for a retired row; not_found for an unknown reference", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null });
    await sql(`UPDATE payments SET mmqr_status='EXPIRED' WHERE payment_ref=$1`, [REF(1)]);
    expect(await store(REF(1), "0002QR", "QR-1")).toBe("not_live");
    expect(await store(REF(9), "0002QR", "QR-9")).toBe("not_found");
  });
});

describe("complete_cbmmqr_replace", () => {
  it("replaced: old row retired, new row pinned and the only live one", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1));
    const [r] = await replace(enrollmentId, tenantId, REF(1), "EXPIRED", REF(2));
    expect(r).toMatchObject({ outcome: "replaced", merchant: "YOUNGMONEY" });
    expect((await liveRows(enrollmentId)).map((x) => x.payment_ref)).toEqual([REF(2)]);
    const [old] = await sql(`SELECT mmqr_status FROM payments WHERE payment_ref=$1`, [REF(1)]);
    expect(old).toEqual({ mmqr_status: "EXPIRED" });
  });

  it("raises on SUPERSEDED", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1));
    await expect(replace(enrollmentId, tenantId, REF(1), "SUPERSEDED", REF(2))).rejects.toThrow(/invalid reason/);
  });

  it("invalid_enrollment for the wrong tenant", async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    await seedLive(a.enrollmentId, a.tenantId, REF(1));
    expect((await replace(a.enrollmentId, b.tenantId, REF(1), "EXPIRED", REF(2)))[0].outcome).toBe("invalid_enrollment");
  });

  it("already_settled when settlement won the race", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1));
    await sql(`UPDATE payments SET status='verified', mmqr_status='SUCCESS' WHERE payment_ref=$1`, [REF(1)]);
    expect((await replace(enrollmentId, tenantId, REF(1), "EXPIRED", REF(2)))[0].outcome).toBe("already_settled");
  });

  it("not_live, not_payable and no_merchant leave the old row live and untouched", async () => {
    const w = await makeWorld();
    await seedLive(w.enrollmentId, w.tenantId, REF(1));
    await sql(`UPDATE payments SET mmqr_status='FAILED' WHERE payment_ref=$1`, [REF(1)]);
    expect((await replace(w.enrollmentId, w.tenantId, REF(1), "EXPIRED", REF(2)))[0].outcome).toBe("not_live");

    const r = await makeWorld();
    await seedLive(r.enrollmentId, r.tenantId, REF(3));
    await sql(`UPDATE enrollments SET status='rejected' WHERE id=$1`, [r.enrollmentId]);
    expect((await replace(r.enrollmentId, r.tenantId, REF(3), "EXPIRED", REF(4)))[0].outcome).toBe("not_payable");
    expect((await liveRows(r.enrollmentId)).map((x) => x.payment_ref)).toEqual([REF(3)]);

    const n = await makeWorld();
    await seedLive(n.enrollmentId, n.tenantId, REF(5));
    await sql(`DELETE FROM cbmmqr_merchant_assignments WHERE tenant_id=$1`, [n.tenantId]);
    expect((await replace(n.enrollmentId, n.tenantId, REF(5), "EXPIRED", REF(6)))[0].outcome).toBe("no_merchant");
    expect((await liveRows(n.enrollmentId)).map((x) => x.payment_ref)).toEqual([REF(5)]);
  });

  it("settling: refuses to retire a row a settlement has already bound", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null, orderRef: null });
    expect(await bind(REF(1), "QR-1", "TXN-1")).toBe("bound");
    expect((await replace(enrollmentId, tenantId, REF(1), "FAILED", REF(2)))[0].outcome).toBe("settling");
    expect((await liveRows(enrollmentId)).map((x) => x.payment_ref)).toEqual([REF(1)]);
  });

  it("a replace racing a bind on the same row: the replace waits, then answers settling", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null, orderRef: null });
    // Hold the bind's row lock open in its own transaction.
    const binder = new Client({ connectionString: process.env.DATABASE_URL });
    await binder.connect();
    try {
      await binder.query("BEGIN");
      await binder.query(`SELECT public.bind_cbmmqr_settlement($1,'QR-1','TXN-1','YOUNGMONEY')`, [REF(1)]);
      const pending = replace(enrollmentId, tenantId, REF(1), "FAILED", REF(2));
      await new Promise((r) => setTimeout(r, 300)); // the replace is now blocked on the row lock
      await binder.query("COMMIT");
      expect((await pending)[0].outcome).toBe("settling");
    } finally {
      await binder.end();
    }
    expect((await liveRows(enrollmentId)).map((x) => x.payment_ref)).toEqual([REF(1)]);
  });
});

describe("bind_cbmmqr_settlement", () => {
  it("bound, and a replay with the same values is bound again", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { orderRef: "QR-1" });
    expect(await bind(REF(1), "QR-1", "TXN-1")).toBe("bound");
    expect(await bind(REF(1), "QR-1", "TXN-1")).toBe("bound");
  });

  it("binds provider_order_ref when it was never stored (lost create response)", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null, orderRef: null });
    expect(await bind(REF(1), "QR-1", "TXN-1")).toBe("bound");
    const [p] = await sql(`SELECT provider_order_ref, bank_reference FROM payments WHERE payment_ref=$1`, [REF(1)]);
    expect(p).toEqual({ provider_order_ref: "QR-1", bank_reference: "TXN-1" });
  });

  it.each([
    ["a different QR reference", "QR-2", "TXN-1", "YOUNGMONEY"],
    ["another merchant", "QR-1", "TXN-1", "OTHER"],
    ["an empty transaction id", "QR-1", "", "YOUNGMONEY"],
  ])("mismatch for %s", async (_n, qrRef, txn, merchant) => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { orderRef: "QR-1" });
    expect(await bind(REF(1), qrRef, txn, merchant)).toBe("mismatch");
  });

  it("mismatch for a second, different transaction on the same payment", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { orderRef: "QR-1" });
    expect(await bind(REF(1), "QR-1", "TXN-1")).toBe("bound");
    expect(await bind(REF(1), "QR-1", "TXN-2")).toBe("mismatch");
  });

  it("duplicate_transaction when the transaction already bound another payment", async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    await seedLive(a.enrollmentId, a.tenantId, REF(1), { orderRef: "QR-1" });
    await seedLive(b.enrollmentId, b.tenantId, REF(2), { orderRef: "QR-2" });
    expect(await bind(REF(1), "QR-1", "TXN-1")).toBe("bound");
    expect(await bind(REF(2), "QR-2", "TXN-1")).toBe("duplicate_transaction");
  });

  it("two concurrent binds with different transactions: exactly one is bound", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { orderRef: "QR-1" });
    const out = await Promise.all([bind(REF(1), "QR-1", "TXN-1"), bind(REF(1), "QR-1", "TXN-2")]);
    expect(out.sort()).toEqual(["bound", "mismatch"]);
  });

  it("not_found for a reference that is not a CB payment", async () => {
    expect(await bind("KBZ_none", "QR-1", "TXN-1")).toBe("not_found");
  });
});

describe("trg_protect_payment_cbmmqr_fields and the CHECK", () => {
  it("refuses a pin that does not match the assignment", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await expect(seedLive(enrollmentId, tenantId, REF(1), { merchant: "OTHER" }))
      .rejects.toThrow(/does not match the tenant assignment/);
  });

  it("refuses changing the pin, provider_order_ref or a CB bank_reference once set", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { orderRef: "QR-1" });
    await sql(`UPDATE payments SET bank_reference='TXN-1' WHERE payment_ref=$1`, [REF(1)]);
    for (const set of [
      "cbmmqr_merchant='OTHER'", "provider_order_ref='QR-2'", "provider_order_ref=NULL", "bank_reference='TXN-2'",
    ]) {
      await expect(sql(`UPDATE payments SET ${set} WHERE payment_ref=$1`, [REF(1)])).rejects.toThrow(/immutable|write-once/);
    }
  });

  it("refuses provider_order_ref on a non-CB row, and a CB row without a pin", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await expect(sql(
      `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status, provider_order_ref)
       VALUES ($1,$2,1000,'bank_transfer','awaiting_payment','QR-1')`, [enrollmentId, tenantId],
    )).rejects.toThrow(/only valid on cb_mmqr/);
    await expect(sql(
      `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status, mmqr_status)
       VALUES ($1,$2,1000,'cb_mmqr','awaiting_payment','PENDING')`, [enrollmentId, tenantId],
    )).rejects.toThrow(/payments_cbmmqr_merchant_required/);
  });
});

describe("cbmmqr_merchant_assignments", () => {
  it("a reassignment advances updated_at", async () => {
    const { tenantId } = await makeWorld();
    const at = async () => (await sql<{ updated_at: Date }>(
      `SELECT updated_at FROM cbmmqr_merchant_assignments WHERE tenant_id=$1`, [tenantId]))[0].updated_at.getTime();
    const before = await at();
    await sql(`SELECT pg_sleep(0.02)`);
    await sql(`UPDATE cbmmqr_merchant_assignments SET merchant_id='OTHER' WHERE tenant_id=$1`, [tenantId]);
    expect(await at()).toBeGreaterThan(before);
  });
});

describe("grants", () => {
  const can = async (role: string, privilege: string) =>
    (await sql<{ ok: boolean }>(
      `SELECT has_table_privilege($1,'public.cbmmqr_merchant_assignments',$2) AS ok`, [role, privilege]))[0].ok;
  const canExec = async (role: string, fn: string) =>
    (await sql<{ ok: boolean }>(`SELECT has_function_privilege($1,$2,'EXECUTE') AS ok`, [role, fn]))[0].ok;

  it("service_role manages assignments; anon and authenticated cannot", async () => {
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(await can("service_role", p)).toBe(true);
      expect(await can("anon", p)).toBe(false);
      expect(await can("authenticated", p)).toBe(false);
    }
  });

  it.each([
    "public.claim_cbmmqr_order_slot(uuid,uuid,text,integer,timestamptz,integer)",
    "public.store_cbmmqr_qr(text,text,text,timestamptz)",
    "public.complete_cbmmqr_replace(uuid,uuid,text,text,text,integer,timestamptz,integer)",
    "public.bind_cbmmqr_settlement(text,text,text,text)",
  ])("only service_role can execute %s", async (fn) => {
    expect(await canExec("service_role", fn)).toBe(true);
    expect(await canExec("anon", fn)).toBe(false);
    expect(await canExec("authenticated", fn)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the DB suites**

Run: `npm run test:db -- src/__tests__/db/cbmmqr-order-slot.db.test.ts`
Expected: exit code 0.

Run: `npm run test:db`
Expected: exit code 0 — the KBZPay suite still passes.

If a CB test fails, the fault is in the SQL: fix Task 1's migration, reload it locally the way `src/__tests__/db/setup.ts` documents, and re-run. Never weaken a test to match broken SQL.

- [ ] **Step 4: Commit**

```bash
git status
git diff --stat
git add src/__tests__/db/cbmmqr-order-slot.db.test.ts
git commit -m "test(cbmmqr): database tests for the CB order functions and trigger"
```

---

### Task 3: CB client — merchant config, reference, timestamps, codes

**Files:**
- Create: `src/lib/cbmmqr.ts` (first half)
- Test: `src/__tests__/payments/cbmmqr-merchant.test.ts`, `src/__tests__/payments/cbmmqr-client.test.ts` (first half)

Everything in this task is pure: no network, no database. Mirror the shape of `src/lib/kbzpay.ts`.

- [ ] **Step 1: Write the failing merchant tests**

`src/__tests__/payments/cbmmqr-merchant.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── getCbMerchant ──────────────────────────────────────────────────────────
// Spec §2 and §6: one named credential set per merchant, no fallback between
// merchants, ever. A fallback is how one tenant's buyers would pay another's
// account.

const YM = {
  CBMMQR_YOUNGMONEY_USER_ID: "ym-user",
  CBMMQR_YOUNGMONEY_PASSWORD: "ym-password",
  CBMMQR_YOUNGMONEY_SOURCE_ID: "ym-source",
  CBMMQR_YOUNGMONEY_MERCHANT_ID: "M0001",
  CBMMQR_YOUNGMONEY_TERMINAL_ID: "T0001",
  CBMMQR_YOUNGMONEY_API_KEY: "ym-api-key",
};

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("CBMMQR_")) delete process.env[k];
  Object.assign(process.env, YM);
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("CBMMQR_")) delete process.env[k];
});

const { getCbMerchant } = await import("@/lib/cbmmqr");

describe("getCbMerchant", () => {
  it("returns the named merchant", () => {
    expect(getCbMerchant("YOUNGMONEY")).toEqual({
      id: "YOUNGMONEY",
      userId: "ym-user",
      password: "ym-password",
      sourceId: "ym-source",
      merchantId: "M0001",
      terminalId: "T0001",
      apiKey: "ym-api-key",
    });
  });

  it.each([null, undefined, "", "youngmoney", "1BAD", "A"])("refuses the id %s", (id) => {
    expect(() => getCbMerchant(id as string)).toThrow(/missing or malformed/);
  });

  it.each(Object.keys(YM))("fails closed when %s is missing, naming it and not its value", (name) => {
    delete process.env[name];
    let message = "";
    try { getCbMerchant("YOUNGMONEY"); } catch (e) { message = (e as Error).message; }
    expect(message).toContain(name);
    for (const v of Object.values(YM)) expect(message).not.toContain(v);
  });

  it("never falls back to another merchant's variables", () => {
    process.env.CBMMQR_OTHER_USER_ID = "other";
    expect(() => getCbMerchant("OTHER")).toThrow(/CBMMQR_OTHER_PASSWORD/);
  });
});
```

- [ ] **Step 2: Write the failing pure-helper tests**

Start `src/__tests__/payments/cbmmqr-client.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const {
  buildReferenceNo, REFERENCE_PATTERN, parseCbTimestamp, normaliseCode,
  apiKeyMatches, currencyFromCb, isPendingCode,
} = await import("@/lib/cbmmqr");

describe("buildReferenceNo", () => {
  it("is CB + 23 base32 characters, 25 in all (CB's referenceNo limit)", () => {
    const ref = buildReferenceNo();
    expect(ref).toHaveLength(25);
    expect(ref).toMatch(REFERENCE_PATTERN);
  });

  it("does not repeat across 10,000 draws", () => {
    const seen = new Set(Array.from({ length: 10_000 }, buildReferenceNo));
    expect(seen.size).toBe(10_000);
  });

  it("cannot collide with another provider's format", () => {
    expect(buildReferenceNo().startsWith("KBZ_")).toBe(false);
  });
});

describe("parseCbTimestamp", () => {
  afterEach(() => { delete process.env.CBMMQR_UTC_OFFSET; });

  it("reads CB's format in Myanmar time (+06:30) by default", () => {
    expect(parseCbTimestamp("20261031 10:14:14")).toBe(Date.parse("2026-10-31T10:14:14+06:30"));
  });

  it("uses CBMMQR_UTC_OFFSET when set", () => {
    process.env.CBMMQR_UTC_OFFSET = "+00:00";
    expect(parseCbTimestamp("20261031 10:14:14")).toBe(Date.parse("2026-10-31T10:14:14Z"));
  });

  it("throws on a malformed offset rather than guessing", () => {
    process.env.CBMMQR_UTC_OFFSET = "Asia/Yangon";
    expect(() => parseCbTimestamp("20261031 10:14:14")).toThrow(/CBMMQR_UTC_OFFSET/);
  });

  it.each([undefined, null, "", "2026-10-31 10:14:14", "20261331 10:14:14", 20261031])(
    "returns null for %s", (v) => { expect(parseCbTimestamp(v)).toBeNull(); },
  );
});

describe("normaliseCode", () => {
  it.each([[0, "0000"], [6, "0006"], ["0006", "0006"], [" 52 ", "0052"], ["0000", "0000"]])(
    "%s → %s", (v, out) => { expect(normaliseCode(v)).toBe(out); },
  );
  it.each([undefined, null, "", "abc", "00001", 1.5])("%s → null", (v) => {
    expect(normaliseCode(v)).toBeNull();
  });
});

describe("isPendingCode", () => {
  it("0006 and 0008 are pending; nothing else is", () => {
    expect(isPendingCode("0006")).toBe(true);
    expect(isPendingCode("0008")).toBe(true);
    for (const c of ["0000", "0007", "0009", "0026", null]) expect(isPendingCode(c)).toBe(false);
  });
});

describe("apiKeyMatches", () => {
  it("matches only the exact key", () => {
    expect(apiKeyMatches("secret-key", "secret-key")).toBe(true);
    expect(apiKeyMatches("secret-kez", "secret-key")).toBe(false);
    expect(apiKeyMatches("secret", "secret-key")).toBe(false);
    expect(apiKeyMatches(undefined, "secret-key")).toBe(false);
    expect(apiKeyMatches(123, "secret-key")).toBe(false);
  });
});

describe("currencyFromCb", () => {
  it("104 is MMK; anything else is null", () => {
    expect(currencyFromCb("104")).toBe("MMK");
    expect(currencyFromCb(104)).toBe("MMK");
    for (const v of ["MMK", "840", "", null, undefined]) expect(currencyFromCb(v)).toBeNull();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/__tests__/payments/cbmmqr-merchant.test.ts src/__tests__/payments/cbmmqr-client.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/cbmmqr"`.

- [ ] **Step 4: Write the first half of `src/lib/cbmmqr.ts`**

```ts
// ─── CB Bank QR Gateway (MMQR) client ───────────────────────────────────────
// Design: docs/superpowers/specs/2026-10-31-cb-mmqr-integration-design.md
// CB API: QR Gateway API Specification v1.0.10 (CB's PDF; not in the repo).
//
// Pure module: no Supabase, no Next.js imports. Mirrors src/lib/kbzpay.ts.

import { randomBytes, timingSafeEqual } from "crypto";

// ── Merchants ──────────────────────────────────────────────────────────────

/**
 * One CB merchant's credentials, read from `CBMMQR_<ID>_*` (spec §6). A
 * tenant's merchant id comes from cbmmqr_merchant_assignments and is pinned on
 * each payment row; every call for an order uses the merchant pinned on it.
 */
export type CbMerchant = {
  id: string;
  userId: string;
  password: string;
  sourceId: string;
  merchantId: string;
  terminalId: string;
  /** The static key CB sends on callbacks. */
  apiKey: string;
};
// No notify origin: CB's /dynamicqr takes no callback URL. The URL is
// registered with CB out of band, per merchant and environment.

const MERCHANT_ID_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;

/**
 * Resolves a merchant, failing closed. There is deliberately NO fallback to
 * another merchant: that is how one tenant's buyers would pay another's
 * account. Errors name the variable, never its value.
 */
export function getCbMerchant(id: string | null | undefined): CbMerchant {
  if (!id || !MERCHANT_ID_PATTERN.test(id)) {
    throw new Error("CB merchant id is missing or malformed");
  }

  const read = (suffix: string): string => {
    const name = `CBMMQR_${id}_${suffix}`;
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };

  return {
    id,
    userId: read("USER_ID"),
    password: read("PASSWORD"),
    sourceId: read("SOURCE_ID"),
    merchantId: read("MERCHANT_ID"),
    terminalId: read("TERMINAL_ID"),
    apiKey: read("API_KEY"),
  };
}

// ── Reference ──────────────────────────────────────────────────────────────

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** `CB` + 23 base32 characters: 25, CB's referenceNo maximum. */
export const REFERENCE_PATTERN = /^CB[A-Z2-7]{23}$/;

/**
 * Our referenceNo, stored as payments.payment_ref. 115 bits of randomness, so
 * collisions are not a practical concern, and the `CB` prefix keeps it apart
 * from every other provider's format (KBZPay's start `KBZ_`). The unique index
 * on payment_ref is still the backstop (spec §5.0).
 */
export function buildReferenceNo(): string {
  const bytes = randomBytes(15); // 120 bits → 24 base32 characters
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `CB${out.slice(0, 23)}`;
}

// ── Time ───────────────────────────────────────────────────────────────────

const CB_TIMESTAMP = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const OFFSET_PATTERN = /^[+-]\d{2}:\d{2}$/;

/**
 * CB's timestamps carry no zone. Myanmar has one fixed offset and no DST, so a
 * configured offset (default +06:30) is enough; it is gate G2 to confirm it.
 */
function utcOffset(): string {
  const raw = (process.env.CBMMQR_UTC_OFFSET ?? "+06:30").trim();
  if (!OFFSET_PATTERN.test(raw)) {
    throw new Error('CBMMQR_UTC_OFFSET must look like "+06:30"');
  }
  return raw;
}

/**
 * `20261031 10:14:14` → epoch ms, or null when it is not in that exact shape
 * or not a real date. Callers treat null as "do not display this QR".
 */
export function parseCbTimestamp(value: unknown): number | null {
  const offset = utcOffset();
  if (typeof value !== "string") return null;
  const m = CB_TIMESTAMP.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  // Date.parse rolls 2026-13-31 over instead of failing; refuse it.
  const check = new Date(ms + offsetMs(offset));
  if (check.getUTCMonth() + 1 !== Number(mo) || check.getUTCDate() !== Number(d)) return null;
  return ms;
}

function offsetMs(offset: string): number {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  return sign * (h * 60 + m) * 60_000;
}

// ── Return codes ───────────────────────────────────────────────────────────
// CB's §4.2 gives several codes two meanings (0006, 0017, 0018), so a code is
// never interpreted alone where money is concerned (spec §3).

export const CB_SUCCESS = "0000";

/** CB's returnCode arrives as a number or a string; normalise to 4 digits. */
export function normaliseCode(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 9999 ? String(value).padStart(4, "0") : null;
  }
  if (typeof value === "string" && /^\d{1,4}$/.test(value.trim())) {
    return value.trim().padStart(4, "0");
  }
  return null;
}

/** Waiting for payment (0006) / in progress (0008). */
export function isPendingCode(code: string | null): boolean {
  return code === "0006" || code === "0008";
}

/**
 * Codes on /dynamicqr after which CB has created NOTHING, so the row may be
 * marked FAILED (spec §5.1 step 6). Every other code is ambiguous.
 */
export const CREATE_REJECTIONS: Readonly<Record<string, "below_minimum" | "above_maximum" | "config">> = {
  "0051": "below_minimum",
  "0052": "above_maximum",
  "0001": "config", // invalid merchant id
  "0002": "config", // invalid terminal id
  "0016": "config", // please change password
  "0021": "config", // invalid user id or password
};

// ── Callback key ───────────────────────────────────────────────────────────

/** Constant-time comparison of the callback's apiKey with the expected key. */
export function apiKeyMatches(received: unknown, expected: string): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Currency ───────────────────────────────────────────────────────────────

/** CB sends ISO 4217 numeric. 104 is MMK; nothing else is accepted. */
export function currencyFromCb(value: unknown): "MMK" | null {
  return String(value ?? "").trim() === "104" ? "MMK" : null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/payments/cbmmqr-merchant.test.ts src/__tests__/payments/cbmmqr-client.test.ts`
Expected: PASS, exit code 0.

- [ ] **Step 6: Commit**

```bash
git status
git diff --stat
git add src/lib/cbmmqr.ts src/__tests__/payments/cbmmqr-merchant.test.ts src/__tests__/payments/cbmmqr-client.test.ts
git commit -m "feat(cbmmqr): CB client merchant config, reference, timestamps and return codes"
```

---

### Task 4: CB client — transport, token cache, create and status calls

**Files:**
- Modify: `src/lib/cbmmqr.ts` (second half)
- Test: `src/__tests__/payments/cbmmqr-client.test.ts` (second half)

- [ ] **Step 1: Write the failing transport tests**

Append to `src/__tests__/payments/cbmmqr-client.test.ts`. They stub `fetch`; the request URL decides the canned answer.

```ts
const { createDynamicQr, checkStatus, __resetTokenCacheForTests } = await import("@/lib/cbmmqr");

const MERCHANT = {
  id: "YOUNGMONEY", userId: "ym-user", password: "ym-password", sourceId: "ym-source",
  merchantId: "M0001", terminalId: "T0001", apiKey: "ym-api-key"
};

type Answer = { status?: number; body: unknown } | Error;
let answers: Record<string, Answer[]>;
let calls: { url: string; method: string; body: Record<string, unknown> }[];

const tokenOk = (minutes = 30): Answer => ({
  body: { token: "TOKEN-1", returnCode: "0000", message: "ok",
          expiredDateTime: cbTime(Date.now() + minutes * 60_000) },
});
const cbTime = (ms: number) => {
  const d = new Date(ms + 390 * 60_000); // +06:30 wall clock
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
const route = (url: string) =>
  url.endsWith("/auth/token") ? "token" : url.endsWith("/dynamicqr") ? "create" : "status";

beforeEach(() => {
  process.env.CBMMQR_BASE_URL = "https://cbgw.test/api";
  delete process.env.CBMMQR_MODE;
  delete process.env.VERCEL_ENV;
  __resetTokenCacheForTests();
  answers = { token: [tokenOk()], create: [], status: [] };
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method!, body: JSON.parse(String(init.body)) });
    const a = answers[route(url)].shift() ?? new Error("no canned answer");
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.CBMMQR_BASE_URL; });

const createOk = {
  body: { returnCode: "0000", message: "ok", referenceNo: "CBREF", qrCodeInfo: "000201QR",
          qrReferenceNo: "QR-1", qrIssuedDateTime: "20261031 10:11:14", qrExpiredDateTime: "20261031 10:14:14" },
};
const params = { referenceNo: "CBAAAAAAAAAAAAAAAAAAAAAAA", amount: 40000, purpose: "Ticket payment" };

describe("createDynamicQr", () => {
  it("sends one token request, then the QR request with the merchant's ids", async () => {
    answers.create = [createOk];
    const r = await createDynamicQr(MERCHANT, params);
    expect(r).toEqual({ kind: "created", qr: "000201QR", qrReferenceNo: "QR-1",
                        expiresAtMs: Date.parse("2026-10-31T10:14:14+06:30") });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "https://cbgw.test/api/auth/token"],
      ["POST", "https://cbgw.test/api/dynamicqr"],
    ]);
    expect(calls[0].body).toEqual({ userId: "ym-user", password: "ym-password" });
    expect(calls[1].body).toEqual({
      token: "TOKEN-1", sourceId: "ym-source", transCurrency: "104", transAmount: 40000,
      purposeOfTransaction: "Ticket payment", referenceNo: params.referenceNo,
      merchantId: "M0001", terminalId: "T0001",
    });
  });

  it("reuses a cached token on the next call", async () => {
    answers.create = [createOk, createOk];
    await createDynamicQr(MERCHANT, params);
    await createDynamicQr(MERCHANT, params);
    expect(calls.filter((c) => route(c.url) === "token")).toHaveLength(1);
  });

  it("fetches one token for concurrent first calls (single-flight)", async () => {
    answers.create = [createOk, createOk];
    await Promise.all([createDynamicQr(MERCHANT, params), createDynamicQr(MERCHANT, params)]);
    expect(calls.filter((c) => route(c.url) === "token")).toHaveLength(1);
  });

  it.each(["0012", "0017"])("on %s refreshes the token and retries exactly once", async (code) => {
    answers.token = [tokenOk(), { body: { ...((tokenOk() as { body: object }).body), token: "TOKEN-2" } }];
    answers.create = [{ body: { returnCode: code } }, createOk];
    const r = await createDynamicQr(MERCHANT, params);
    expect(r.kind).toBe("created");
    expect(calls.filter((c) => route(c.url) === "create").map((c) => c.body.token)).toEqual(["TOKEN-1", "TOKEN-2"]);
  });

  it("does not retry a second token failure", async () => {
    answers.token = [tokenOk(), tokenOk()];
    answers.create = [{ body: { returnCode: "0012" } }, { body: { returnCode: "0012" } }];
    expect((await createDynamicQr(MERCHANT, params)).kind).toBe("ambiguous");
    expect(calls.filter((c) => route(c.url) === "create")).toHaveLength(2);
  });

  it.each([
    ["0051", "below_minimum"], ["0052", "above_maximum"], ["0001", "config"],
    ["0002", "config"], ["0016", "config"], ["0021", "config"],
  ])("%s is a definite rejection (%s)", async (code, reason) => {
    answers.create = [{ body: { returnCode: code } }];
    expect(await createDynamicQr(MERCHANT, params)).toEqual({ kind: "rejected", reason, code });
  });

  it.each([
    ["0003 (reference exists)", { body: { returnCode: "0003" } }],
    ["an unknown code", { body: { returnCode: "0099" } }],
    ["0000 without a QR", { body: { returnCode: "0000", qrReferenceNo: "QR-1" } }],
    ["0000 without a QR reference", { body: { returnCode: "0000", qrCodeInfo: "000201QR" } }],
    ["HTTP 500", { status: 500, body: {} }],
    ["a transport error", new Error("socket hang up")],
  ])("%s is ambiguous", async (_n, answer) => {
    answers.create = [answer as Answer];
    expect((await createDynamicQr(MERCHANT, params)).kind).toBe("ambiguous");
  });

  it("returns a null expiry when CB's expiry cannot be read", async () => {
    answers.create = [{ body: { ...createOk.body, qrExpiredDateTime: "soon" } }];
    expect(await createDynamicQr(MERCHANT, params)).toMatchObject({ kind: "created", expiresAtMs: null });
  });

  it("truncates the purpose to 25 characters", async () => {
    answers.create = [createOk];
    await createDynamicQr(MERCHANT, { ...params, purpose: "x".repeat(40) });
    expect(String(calls[1].body.purposeOfTransaction)).toHaveLength(25);
  });

  it("is ambiguous without calling CB when the token request fails", async () => {
    answers.token = [{ body: { returnCode: "0021" } }];
    expect((await createDynamicQr(MERCHANT, params)).kind).toBe("ambiguous");
    expect(calls.filter((c) => route(c.url) === "create")).toHaveLength(0);
  });

  it("never logs the password, token or API key", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    answers.create = [new Error("boom")];
    await createDynamicQr(MERCHANT, params);
    const logged = spy.mock.calls.flat().join(" ");
    for (const secret of ["ym-password", "TOKEN-1", "ym-api-key"]) expect(logged).not.toContain(secret);
    spy.mockRestore();
  });

  it("starts nothing when the request budget is spent", async () => {
    expect((await createDynamicQr(MERCHANT, params, { deadlineMs: Date.now() })).kind).toBe("ambiguous");
    expect(calls).toHaveLength(0);
  });
});

describe("checkStatus", () => {
  const paid = {
    body: { returnCode: "0000", referenceNo: "CBREF", qrReferenceNo: "QR-1", transactionId: "TXN-1",
            transCurrency: "104", transAmount: 40000, merchantId: "M0001", institutionName: "Wave Money" },
  };

  it("PATCHes /dynamicqr/{qrReferenceNo}/status and returns CB's fields", async () => {
    answers.status = [paid];
    const r = await checkStatus(MERCHANT, "QR 1/x");
    expect(calls[1]).toMatchObject({ method: "PATCH", url: "https://cbgw.test/api/dynamicqr/QR%201%2Fx/status",
                                     body: { token: "TOKEN-1", sourceId: "ym-source" } });
    expect(r).toEqual({
      kind: "answer", code: "0000", referenceNo: "CBREF", qrReferenceNo: "QR-1", transactionId: "TXN-1",
      currency: "MMK", amount: 40000, merchantId: "M0001", institutionName: "Wave Money",
    });
  });

  it("returns pending codes as answers", async () => {
    answers.status = [{ body: { returnCode: 6 } }];
    expect(await checkStatus(MERCHANT, "QR-1")).toMatchObject({ kind: "answer", code: "0006" });
  });

  it("is unreachable on a transport error or a body without a code", async () => {
    answers.status = [new Error("timeout")];
    expect(await checkStatus(MERCHANT, "QR-1")).toEqual({ kind: "unreachable" });
    answers.status = [{ body: { message: "?" } }];
    expect(await checkStatus(MERCHANT, "QR-1")).toEqual({ kind: "unreachable" });
  });
});

describe("mode and base URL", () => {
  it("refuses a production deployment without CBMMQR_MODE=production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(createDynamicQr(MERCHANT, params)).rejects.toThrow(/CBMMQR_MODE/);
  });

  it("refuses an unrecognised CBMMQR_MODE", async () => {
    process.env.CBMMQR_MODE = "prod";
    await expect(createDynamicQr(MERCHANT, params)).rejects.toThrow(/unrecognised/);
  });

  it("refuses a plaintext base URL in production mode", async () => {
    process.env.CBMMQR_MODE = "production";
    process.env.CBMMQR_BASE_URL = "http://cbgw.test/api";
    await expect(createDynamicQr(MERCHANT, params)).rejects.toThrow(/https/);
  });

  it("refuses a missing base URL", async () => {
    delete process.env.CBMMQR_BASE_URL;
    await expect(createDynamicQr(MERCHANT, params)).rejects.toThrow(/CBMMQR_BASE_URL/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/__tests__/payments/cbmmqr-client.test.ts`
Expected: FAIL — `createDynamicQr` is not exported.

- [ ] **Step 3: Append the second half of `src/lib/cbmmqr.ts`**

Add `import { Agent, ProxyAgent } from "undici";` under the `crypto` import, then append:

```ts
// ── Mode and base URL ──────────────────────────────────────────────────────

/**
 * Same fail-closed rules as KBZPay's resolveMode(): an unrecognised value is
 * always an error, and on VERCEL_ENV=production only "production" is accepted.
 */
function resolveMode(): "production" | "uat" {
  const raw = (process.env.CBMMQR_MODE ?? "").trim().toLowerCase();
  if (raw === "production") return "production";
  if (process.env.VERCEL_ENV === "production") {
    throw new Error('CBMMQR_MODE must be "production" on a production deployment.');
  }
  if (raw !== "" && raw !== "uat") {
    throw new Error('CBMMQR_MODE is set to an unrecognised value — expected "production" or "uat".');
  }
  return "uat";
}

/**
 * CB will send the UAT and Live gateway URLs (spec §6). Production must be
 * https; UAT may be whatever CB gives us, since its scheme is not ours to pick.
 */
function baseUrl(): string {
  const mode = resolveMode();
  const raw = process.env.CBMMQR_BASE_URL?.trim();
  if (!raw) throw new Error("CBMMQR_BASE_URL is not set");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("CBMMQR_BASE_URL is not a valid URL");
  }
  if (mode === "production" && parsed.protocol !== "https:") {
    throw new Error("CBMMQR_BASE_URL must use https in production");
  }
  return raw.replace(/\/+$/, "");
}

// ── Egress and timeout (as src/lib/kbzpay.ts) ──────────────────────────────

// CB allowlists caller IPs (spec §3). CBMMQR_PROXY_URL routes ONLY this client
// through a fixed-IP host; unset means direct egress (UAT runs on the office
// IP). Per-request dispatcher, never setGlobalDispatcher().
const ipv4Agent = new Agent({ connect: { family: 4 } } as unknown as Agent.Options);
let cachedProxy: ProxyAgent | null | undefined;

function egressDispatcher(): ProxyAgent | Agent {
  if (cachedProxy === undefined) {
    const url = process.env.CBMMQR_PROXY_URL;
    cachedProxy = url ? new ProxyAgent(url) : null;
  }
  return cachedProxy ?? ipv4Agent;
}

const CALL_TIMEOUT_MS = 20_000;
const MIN_CALL_MS = 1_000;

export type CallBudget = { deadlineMs: number };

function timeoutFor(budget: CallBudget | undefined, now: number): number | null {
  if (!budget) return CALL_TIMEOUT_MS;
  const remaining = budget.deadlineMs - now;
  if (remaining < MIN_CALL_MS) return null;
  return Math.min(CALL_TIMEOUT_MS, remaining);
}

type SendResult = { ok: false } | { ok: true; code: string | null; body: Record<string, unknown> };

/**
 * One HTTP call. `ok: false` means we did not get a parseable answer. A non-2xx
 * with a JSON body is still an answer: CB may put a returnCode on a 400.
 * Bodies are never logged — the token request carries the password.
 */
async function send(
  label: string,
  method: "POST" | "PATCH",
  path: string,
  body: Record<string, unknown>,
  budget?: CallBudget,
): Promise<SendResult> {
  const timeout = timeoutFor(budget, Date.now());
  if (timeout === null) {
    console.error(`[cbmmqr] ${label} skipped: request budget exhausted`);
    return { ok: false };
  }

  // Outside the try: a configuration error must surface, not read as "CB down".
  const url = `${baseUrl()}${path}`;

  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      dispatcher: egressDispatcher(),
    } as RequestInit & { dispatcher?: ProxyAgent | Agent });

    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json || typeof json !== "object") {
      console.error(`[cbmmqr] ${label} HTTP ${res.status} without a JSON body`);
      return { ok: false };
    }
    const code = normaliseCode(json.returnCode);
    if (!res.ok && code === null) {
      console.error(`[cbmmqr] ${label} HTTP ${res.status}`);
      return { ok: false };
    }
    return { ok: true, code, body: json };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    console.error(
      `[cbmmqr] ${label} transport error${timedOut ? " (timeout — check IP allowlisting)" : ""}:`,
      err instanceof Error ? err.message : "unknown",
    );
    return { ok: false };
  }
}

// ── Token cache ────────────────────────────────────────────────────────────

/** Token codes: expired / invalid. Refresh and retry once. */
const TOKEN_CODES = new Set(["0012", "0017"]);
const TOKEN_EARLY_MS = 60_000;

const tokens = new Map<string, { token: string; expiresAtMs: number }>();
const inflight = new Map<string, Promise<string | null>>();

export function __resetTokenCacheForTests(): void {
  tokens.clear();
  inflight.clear();
}

/**
 * The merchant's token, cached per instance until 60s before CB's expiry.
 * Concurrent callers share one request (single-flight). null = no token.
 */
async function getToken(merchant: CbMerchant, budget: CallBudget | undefined, force: boolean): Promise<string | null> {
  const cached = tokens.get(merchant.id);
  if (!force && cached && cached.expiresAtMs - TOKEN_EARLY_MS > Date.now()) return cached.token;

  const pending = inflight.get(merchant.id);
  if (pending) return pending;

  const request = (async () => {
    tokens.delete(merchant.id);
    const r = await send("auth/token", "POST", "/auth/token",
      { userId: merchant.userId, password: merchant.password }, budget);
    if (!r.ok || r.code !== CB_SUCCESS || typeof r.body.token !== "string" || !r.body.token) {
      console.error(`[cbmmqr] token request failed for ${merchant.id}: code=${r.ok ? r.code : "none"}`);
      return null;
    }
    const expiresAtMs = parseCbTimestamp(r.body.expiredDateTime) ?? Date.now() + 5 * 60_000;
    tokens.set(merchant.id, { token: r.body.token, expiresAtMs });
    return r.body.token;
  })();

  inflight.set(merchant.id, request);
  try {
    return await request;
  } finally {
    inflight.delete(merchant.id);
  }
}

/** Runs `call` with a token; on a token code, refreshes once and retries once. */
async function withToken(
  merchant: CbMerchant,
  budget: CallBudget | undefined,
  call: (token: string) => Promise<SendResult>,
): Promise<SendResult> {
  const first = await getToken(merchant, budget, false);
  if (!first) return { ok: false };
  const r = await call(first);
  if (!r.ok || !TOKEN_CODES.has(r.code ?? "")) return r;

  const second = await getToken(merchant, budget, true);
  if (!second) return { ok: false };
  return call(second);
}

// ── Create QR ──────────────────────────────────────────────────────────────

export type CreateQrParams = { referenceNo: string; amount: number; purpose: string };

export type CreateQrResult =
  | { kind: "created"; qr: string; qrReferenceNo: string; expiresAtMs: number | null }
  /** CB created nothing (spec §5.1 step 6): the row may be marked FAILED. */
  | { kind: "rejected"; reason: "below_minimum" | "above_maximum" | "config"; code: string }
  /** We cannot tell whether CB created a QR: the row stays PENDING (R13). */
  | { kind: "ambiguous"; code: string | null };

export async function createDynamicQr(
  merchant: CbMerchant,
  p: CreateQrParams,
  budget?: CallBudget,
): Promise<CreateQrResult> {
  const r = await withToken(merchant, budget, (token) =>
    send("dynamicqr", "POST", "/dynamicqr", {
      token,
      sourceId: merchant.sourceId,
      // CB's spec shows "104"; whether it wants a string or a number is a UAT check.
      transCurrency: "104",
      transAmount: p.amount,
      purposeOfTransaction: p.purpose.slice(0, 25),
      referenceNo: p.referenceNo,
      merchantId: merchant.merchantId,
      terminalId: merchant.terminalId,
    }, budget),
  );

  if (!r.ok) return { kind: "ambiguous", code: null };

  if (r.code === CB_SUCCESS) {
    const qr = r.body.qrCodeInfo;
    const qrRef = r.body.qrReferenceNo;
    if (typeof qr !== "string" || !qr || typeof qrRef !== "string" || !qrRef) {
      console.error(`[cbmmqr] dynamicqr 0000 without a QR or reference for ${p.referenceNo}`);
      return { kind: "ambiguous", code: r.code };
    }
    return { kind: "created", qr, qrReferenceNo: qrRef, expiresAtMs: parseCbTimestamp(r.body.qrExpiredDateTime) };
  }

  const reason = r.code ? CREATE_REJECTIONS[r.code] : undefined;
  if (reason) return { kind: "rejected", reason, code: r.code! };

  console.error(`[cbmmqr] dynamicqr returned ${r.code ?? "no code"} for ${p.referenceNo}; treating as ambiguous`);
  return { kind: "ambiguous", code: r.code };
}

// ── Status check ───────────────────────────────────────────────────────────

export type StatusResult =
  | { kind: "unreachable" }
  | {
      kind: "answer";
      code: string;
      referenceNo?: string;
      qrReferenceNo?: string;
      transactionId?: string;
      currency: "MMK" | null;
      amount: number | null;
      merchantId?: string;
      institutionName?: string;
    };

/**
 * The settlement authority (spec §5.5). Its answer is only ever used together
 * with every field check in settleCbmmqrPayment(); a code alone means little,
 * since CB gives several codes two meanings.
 */
export async function checkStatus(
  merchant: CbMerchant,
  qrReferenceNo: string,
  budget?: CallBudget,
): Promise<StatusResult> {
  const r = await withToken(merchant, budget, (token) =>
    send("status", "PATCH", `/dynamicqr/${encodeURIComponent(qrReferenceNo)}/status`,
      { token, sourceId: merchant.sourceId }, budget),
  );

  if (!r.ok || r.code === null) return { kind: "unreachable" };

  const b = r.body;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const amount = Number(b.transAmount);

  const answer: StatusResult = {
    kind: "answer",
    code: r.code,
    currency: currencyFromCb(b.transCurrency),
    amount: b.transAmount === undefined || b.transAmount === null || !Number.isFinite(amount) ? null : amount,
  };
  if (str(b.referenceNo)) answer.referenceNo = str(b.referenceNo);
  if (str(b.qrReferenceNo)) answer.qrReferenceNo = str(b.qrReferenceNo);
  if (str(b.transactionId)) answer.transactionId = str(b.transactionId);
  if (str(b.merchantId)) answer.merchantId = str(b.merchantId);
  if (str(b.institutionName)) answer.institutionName = str(b.institutionName);
  return answer;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/payments/cbmmqr-client.test.ts src/__tests__/payments/cbmmqr-merchant.test.ts`
Expected: PASS, exit code 0.

Note on the `checkStatus` success test: `toEqual` ignores the absence of optional keys, so the expected object lists exactly the keys CB returned.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git status
git diff --stat
git add src/lib/cbmmqr.ts src/__tests__/payments/cbmmqr-client.test.ts
git commit -m "feat(cbmmqr): CB client token cache, QR creation and status check"
```

---

### Task 5: Order window — the QR must not outlive the enrollment

**Files:**
- Create: `src/server/payments/cbmmqrOrderWindow.ts`
- Test: `src/__tests__/payments/cbmmqr-order-window.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import {
  CB_MAX_QR_MINUTES, CB_EXPIRY_MARGIN_MINUTES, enrollmentDeadline, preCheck, postCheck, provisionalExpiry,
} from "@/server/payments/cbmmqrOrderWindow";

const MIN = 60_000;
const now = Date.parse("2026-10-31T04:00:00Z");
const enrolled = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();

describe("enrollmentDeadline", () => {
  it("none when auto-cancel is off (0 or null)", () => {
    expect(enrollmentDeadline(0, enrolled(1))).toEqual({ kind: "none" });
    expect(enrollmentDeadline(null, enrolled(1))).toEqual({ kind: "none" });
  });
  it("enrolled_at + auto_cancel_hours MINUTES (the column holds minutes, migration 058)", () => {
    expect(enrollmentDeadline(15, enrolled(5))).toEqual({ kind: "at", ms: now + 10 * MIN });
  });
  it("unknown when enrolled_at cannot be read", () => {
    expect(enrollmentDeadline(15, null)).toEqual({ kind: "unknown" });
    expect(enrollmentDeadline(15, "garbage")).toEqual({ kind: "unknown" });
  });
});

describe("preCheck", () => {
  const need = (CB_MAX_QR_MINUTES + CB_EXPIRY_MARGIN_MINUTES) * MIN;
  it("ok with no deadline", () => expect(preCheck({ kind: "none" }, now)).toBe("ok"));
  it("unknown stays unknown", () => expect(preCheck({ kind: "unknown" }, now)).toBe("unknown"));
  it("ok exactly at max validity + margin", () => expect(preCheck({ kind: "at", ms: now + need }, now)).toBe("ok"));
  it("too_close one second inside it", () => expect(preCheck({ kind: "at", ms: now + need - 1000 }, now)).toBe("too_close"));
});

describe("postCheck", () => {
  const deadline = { kind: "at" as const, ms: now + 10 * MIN };
  const margin = CB_EXPIRY_MARGIN_MINUTES * MIN;
  it("ok when CB's expiry is before the deadline minus the margin", () =>
    expect(postCheck(deadline, deadline.ms - margin - 1)).toBe("ok"));
  it("too_late at deadline minus margin", () => expect(postCheck(deadline, deadline.ms - margin)).toBe("too_late"));
  it("too_late when CB's expiry is unreadable", () => expect(postCheck(deadline, null)).toBe("too_late"));
  it("too_late when the deadline is unknown", () => expect(postCheck({ kind: "unknown" }, now)).toBe("too_late"));
  it("ok with no deadline and a readable expiry", () => expect(postCheck({ kind: "none" }, now + MIN)).toBe("ok"));
  it("too_late with no deadline but an unreadable expiry", () => expect(postCheck({ kind: "none" }, null)).toBe("too_late"));
});

describe("provisionalExpiry", () => {
  it("is now + max validity + margin", () =>
    expect(provisionalExpiry(now)).toBe(now + (CB_MAX_QR_MINUTES + CB_EXPIRY_MARGIN_MINUTES) * MIN));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/cbmmqr-order-window.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// ─── CB order window ────────────────────────────────────────────────────────
// Spec §5.1 steps 4 and 7. CB chooses the QR's lifetime (we cannot send one),
// so the rule "a QR must not outlive its enrollment" is enforced twice: before
// asking CB, against CB's maximum validity, and after, against the expiry CB
// actually returned. A QR that fails the second check is never displayed, so
// nobody can pay it.

/** CB's maximum QR validity. 3 until CB answers question 2 (gate G2). */
export const CB_MAX_QR_MINUTES = 3;
/** Clock-skew and round-trip allowance on every CB time comparison. */
export const CB_EXPIRY_MARGIN_MINUTES = 2;

const MIN = 60_000;

export type Deadline = { kind: "none" } | { kind: "unknown" } | { kind: "at"; ms: number };

/**
 * When check_expired_enrollments() will reject this enrollment.
 * NOTE: tenants.auto_cancel_hours holds MINUTES since migration 058.
 */
export function enrollmentDeadline(
  autoCancelMinutes: number | null | undefined,
  enrolledAt: string | null | undefined,
): Deadline {
  if (!autoCancelMinutes || autoCancelMinutes <= 0) return { kind: "none" };
  const enrolled = enrolledAt ? Date.parse(enrolledAt) : NaN;
  if (!Number.isFinite(enrolled)) return { kind: "unknown" };
  return { kind: "at", ms: enrolled + Math.floor(autoCancelMinutes) * MIN };
}

/** Before calling CB: is there room for a full-lifetime QR plus the margin? */
export function preCheck(deadline: Deadline, now: number): "ok" | "too_close" | "unknown" {
  if (deadline.kind === "none") return "ok";
  if (deadline.kind === "unknown") return "unknown";
  return deadline.ms - now >= (CB_MAX_QR_MINUTES + CB_EXPIRY_MARGIN_MINUTES) * MIN ? "ok" : "too_close";
}

/** After CB answers: may this QR be displayed? Unreadable expiry → no. */
export function postCheck(deadline: Deadline, qrExpiresAtMs: number | null): "ok" | "too_late" {
  if (qrExpiresAtMs === null) return "too_late";
  if (deadline.kind === "none") return "ok";
  if (deadline.kind === "unknown") return "too_late";
  return qrExpiresAtMs < deadline.ms - CB_EXPIRY_MARGIN_MINUTES * MIN ? "ok" : "too_late";
}

/** The provisional provider_order_expires_at written at claim time (a hint). */
export function provisionalExpiry(now: number): number {
  return now + (CB_MAX_QR_MINUTES + CB_EXPIRY_MARGIN_MINUTES) * MIN;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/cbmmqr-order-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status
git diff --stat
git add src/server/payments/cbmmqrOrderWindow.ts src/__tests__/payments/cbmmqr-order-window.test.ts
git commit -m "feat(cbmmqr): order window checks before and after CB issues a QR"
```

---

### Task 6: Settlement wrapper

**Files:**
- Create: `src/server/payments/settleCbmmqrPayment.ts`
- Test: `src/__tests__/payments/cbmmqr-settle.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mockRpc }) }));
const mockSettle = vi.fn();
vi.mock("@/server/payments/settleMmqrPayment", () => ({
  settleMmqrPayment: (...a: unknown[]) => mockSettle(...a),
}));

const { settleCbmmqrPayment } = await import("@/server/payments/settleCbmmqrPayment");

const MERCHANT = {
  id: "YOUNGMONEY", userId: "u", password: "p", sourceId: "s", merchantId: "M0001",
  terminalId: "T0001", apiKey: "k"
};
const PAYMENT = { payment_ref: "CBAAAAAAAAAAAAAAAAAAAAAAA", payment_method: "cb_mmqr", cbmmqr_merchant: "YOUNGMONEY" };
const PAID = {
  kind: "answer" as const, code: "0000", referenceNo: PAYMENT.payment_ref, qrReferenceNo: "QR-1",
  transactionId: "TXN-1", currency: "MMK" as const, amount: 40000, merchantId: "M0001", institutionName: "Wave Money",
};
const run = (over: { status?: object; payment?: object } = {}) =>
  settleCbmmqrPayment({
    payment: { ...PAYMENT, ...(over.payment ?? {}) },
    merchant: MERCHANT,
    status: { ...PAID, ...(over.status ?? {}) } as never,
    source: "callback",
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockRpc.mockResolvedValue({ data: "bound", error: null });
  mockSettle.mockResolvedValue({ kind: "settled", paymentId: "p", enrollmentId: "e" });
});

describe("settleCbmmqrPayment", () => {
  it("binds, then settles with the status response's values", async () => {
    expect(await run()).toEqual({ kind: "settled" });
    expect(mockRpc).toHaveBeenCalledWith("bind_cbmmqr_settlement", {
      p_payment_ref: PAYMENT.payment_ref, p_qr_reference_no: "QR-1", p_transaction_id: "TXN-1", p_merchant: "YOUNGMONEY",
    });
    expect(mockSettle).toHaveBeenCalledWith({
      paymentRef: PAYMENT.payment_ref, observedAmount: 40000, observedCurrency: "MMK",
      mmOrderId: "TXN-1", walletIdentifier: "Wave Money", source: "callback",
    });
  });

  it("passes already_settled through", async () => {
    mockSettle.mockResolvedValue({ kind: "already_settled", paymentId: "p", enrollmentId: "e" });
    expect(await run()).toEqual({ kind: "already_settled" });
  });

  it.each([
    ["not a CB payment", { payment: { payment_method: "kbzpay_mmqr" } }],
    ["a payment pinned to another merchant", { payment: { cbmmqr_merchant: "OTHER" } }],
    ["a pending code", { status: { code: "0006" } }],
    ["an unreachable status", { status: { kind: "unreachable" } }],
    ["another reference", { status: { referenceNo: "CBBBBBBBBBBBBBBBBBBBBBBBB" } }],
    ["a missing reference", { status: { referenceNo: undefined } }],
    ["another merchant id", { status: { merchantId: "M0002" } }],
    ["a currency other than 104", { status: { currency: null } }],
    ["a fractional amount", { status: { amount: 40000.5 } }],
    ["no amount", { status: { amount: null } }],
    ["no transaction id", { status: { transactionId: undefined } }],
    ["no QR reference", { status: { qrReferenceNo: undefined } }],
  ])("refuses %s without binding or settling", async (_n, over) => {
    expect((await run(over)).kind).toBe("refused");
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it.each(["mismatch", "duplicate_transaction", "not_found"])("refuses when the bind returns %s", async (r) => {
    mockRpc.mockResolvedValue({ data: r, error: null });
    expect(await run()).toEqual({ kind: "refused", reason: `bind ${r}` });
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("is retryable when the bind RPC errors", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    expect((await run()).kind).toBe("retryable");
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it.each([
    ["amount_mismatch", "refused"], ["currency_mismatch", "refused"],
    ["not_found", "retryable"], ["retryable", "retryable"],
  ])("maps settleMmqrPayment's %s to %s", async (kind, expected) => {
    mockSettle.mockResolvedValue({ kind, reason: "x" });
    expect((await run()).kind).toBe(expected);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/cbmmqr-settle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// ─── settleCbmmqrPayment ────────────────────────────────────────────────────
// Spec §5.5. Input is ALWAYS a status-check response obtained with the pinned
// merchant's credentials — never callback fields. Order:
//   1. every field check below, with no side effects;
//   2. bind_cbmmqr_settlement, which ties CB's qrReferenceNo and transactionId
//      to this payment under a row lock (a different transaction is refused);
//   3. settleMmqrPayment(), unchanged: snapshot amount check, conditional
//      transition, fulfilment.

import { createAdminClient } from "@/lib/supabase/admin";
import { CB_SUCCESS, type CbMerchant, type StatusResult } from "@/lib/cbmmqr";
import { settleMmqrPayment, type SettleMmqrSource } from "@/server/payments/settleMmqrPayment";

export type CbPaymentIdentity = {
  payment_ref: string;
  payment_method: string | null;
  cbmmqr_merchant: string | null;
};

export type CbSettleOutcome =
  | { kind: "settled" }
  | { kind: "already_settled" }
  /** Money must not move on this answer. Logged; needs a human if it was real. */
  | { kind: "refused"; reason: string }
  /** Could not finish; a retry may. */
  | { kind: "retryable"; reason: string };

export async function settleCbmmqrPayment(input: {
  payment: CbPaymentIdentity;
  merchant: CbMerchant;
  status: StatusResult;
  source: SettleMmqrSource;
}): Promise<CbSettleOutcome> {
  const { payment, merchant, status, source } = input;
  const ref = payment.payment_ref;

  const refuse = (reason: string): CbSettleOutcome => {
    // Merchant id and our reference only; never credentials or CB's token.
    console.error(`[cbmmqr-settle] refused ${ref} (merchant ${merchant.id}): ${reason}`);
    return { kind: "refused", reason };
  };

  if (payment.payment_method !== "cb_mmqr") return refuse("not a cb_mmqr payment");
  if (payment.cbmmqr_merchant !== merchant.id) return refuse("merchant is not the payment's pin");
  if (status.kind !== "answer" || status.code !== CB_SUCCESS) return refuse("status is not success");
  if (status.referenceNo !== ref) return refuse("referenceNo does not match");
  if (status.merchantId !== merchant.merchantId) return refuse("merchantId does not match");
  if (status.currency !== "MMK") return refuse("currency is not 104");
  if (status.amount === null || !Number.isInteger(status.amount)) return refuse("amount is not a whole number");
  if (!status.transactionId) return refuse("no transactionId");
  if (!status.qrReferenceNo) return refuse("no qrReferenceNo");

  const { data, error } = (await createAdminClient().rpc("bind_cbmmqr_settlement", {
    p_payment_ref: ref,
    p_qr_reference_no: status.qrReferenceNo,
    p_transaction_id: status.transactionId,
    p_merchant: merchant.id,
  } as never)) as { data: string | null; error: { message: string } | null };

  if (error) {
    console.error(`[cbmmqr-settle] bind failed for ${ref}: ${error.message}`);
    return { kind: "retryable", reason: "bind failed" };
  }
  if (data !== "bound") return refuse(`bind ${data}`);

  const settled = await settleMmqrPayment({
    paymentRef: ref,
    observedAmount: status.amount,
    observedCurrency: "MMK",
    mmOrderId: status.transactionId,
    walletIdentifier: status.institutionName ?? null,
    source,
  });

  switch (settled.kind) {
    case "settled":
      return { kind: "settled" };
    case "already_settled":
      return { kind: "already_settled" };
    case "amount_mismatch":
    case "currency_mismatch":
      return refuse(settled.kind);
    default:
      return { kind: "retryable", reason: settled.kind };
  }
}
```

Note: the test's `refuses when the bind returns %s` expects `reason: "bind <value>"`, which `refuse()` produces.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/cbmmqr-settle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status
git diff --stat
git add src/server/payments/settleCbmmqrPayment.ts src/__tests__/payments/cbmmqr-settle.test.ts
git commit -m "feat(cbmmqr): settle only on a verified status response bound to the payment"
```

---

### Task 7: Resolver for a live row we cannot serve

**Files:**
- Create: `src/server/payments/resolveCbmmqrOrder.ts`
- Test: `src/__tests__/payments/cbmmqr-resolve.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockStatus = vi.fn();
vi.mock("@/lib/cbmmqr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cbmmqr")>();
  return { ...actual, checkStatus: (...a: unknown[]) => mockStatus(...a) };
});
const mockSettle = vi.fn();
vi.mock("@/server/payments/settleCbmmqrPayment", () => ({
  settleCbmmqrPayment: (...a: unknown[]) => mockSettle(...a),
}));

const mod = await import("@/server/payments/resolveCbmmqrOrder");
const { resolveCbmmqrOrder, isConfirmedDead, CB_CONFIRMED_DEAD_CODES } = mod;
const { CB_MAX_QR_MINUTES, CB_EXPIRY_MARGIN_MINUTES } = await import("@/server/payments/cbmmqrOrderWindow");

const MIN = 60_000;
const NOW = Date.parse("2026-10-31T04:00:00Z");
const MERCHANT = {
  id: "YOUNGMONEY", userId: "u", password: "p", sourceId: "s", merchantId: "M0001",
  terminalId: "T0001", apiKey: "k"
};
const row = (over: object = {}) => ({
  ref: "CBAAAAAAAAAAAAAAAAAAAAAAA", orderRef: "QR-1" as string | null,
  expiresAtMs: NOW - 10 * MIN as number | null, createdAtMs: NOW - 15 * MIN, ...over,
});
const run = (r = row()) => resolveCbmmqrOrder({ row: r, merchant: MERCHANT, source: "create", now: NOW });

beforeEach(() => {
  vi.clearAllMocks();
  mockStatus.mockResolvedValue({ kind: "answer", code: "0006", currency: null, amount: null });
});
afterEach(() => { (CB_CONFIRMED_DEAD_CODES as Set<string>).clear(); });

describe("isConfirmedDead", () => {
  const dead = { kind: "answer" as const, code: "0099", currency: null, amount: null };

  it("is false for every code while CB_CONFIRMED_DEAD_CODES is empty (gate G1)", () => {
    for (const code of ["0000", "0006", "0007", "0008", "0009", "0026", "0099"]) {
      expect(isConfirmedDead({ ...dead, code }, NOW - 60 * MIN, NOW)).toBe(false);
    }
  });

  it("needs both a confirmed code AND expiry + margin passed", () => {
    (CB_CONFIRMED_DEAD_CODES as Set<string>).add("0099");
    const margin = CB_EXPIRY_MARGIN_MINUTES * MIN;
    expect(isConfirmedDead(dead, NOW - margin - 1, NOW)).toBe(true);
    expect(isConfirmedDead(dead, NOW - margin, NOW)).toBe(false);
    expect(isConfirmedDead(dead, null, NOW)).toBe(false);
    expect(isConfirmedDead({ kind: "unreachable" }, NOW - 60 * MIN, NOW)).toBe(false);
  });
});

describe("resolveCbmmqrOrder — row with CB's reference", () => {
  it("already_paid when the status check shows success and settlement succeeds", async () => {
    mockStatus.mockResolvedValue({ kind: "answer", code: "0000", currency: "MMK", amount: 40000 });
    mockSettle.mockResolvedValue({ kind: "settled" });
    expect(await run()).toEqual({ kind: "already_paid" });
    expect(mockStatus).toHaveBeenCalledWith(MERCHANT, "QR-1", undefined);
    expect(mockSettle).toHaveBeenCalledWith(expect.objectContaining({
      payment: { payment_ref: row().ref, payment_method: "cb_mmqr", cbmmqr_merchant: "YOUNGMONEY" },
    }));
  });

  it("settlement_conflict when settlement refuses; blocked when it is retryable", async () => {
    mockStatus.mockResolvedValue({ kind: "answer", code: "0000", currency: "MMK", amount: 40000 });
    mockSettle.mockResolvedValue({ kind: "refused", reason: "x" });
    expect((await run()).kind).toBe("settlement_conflict");
    mockSettle.mockResolvedValue({ kind: "retryable", reason: "x" });
    expect((await run()).kind).toBe("blocked");
  });

  it("active, never retire, while no dead code is confirmed — however old the QR", async () => {
    expect(await run(row({ expiresAtMs: NOW - 600 * MIN }))).toEqual({
      kind: "active", retryAtMs: NOW + CB_EXPIRY_MARGIN_MINUTES * MIN,
    });
  });

  it("active with retryAt = expiry + margin for a QR not yet expired", async () => {
    expect(await run(row({ expiresAtMs: NOW + MIN }))).toEqual({
      kind: "active", retryAtMs: NOW + MIN + CB_EXPIRY_MARGIN_MINUTES * MIN,
    });
  });

  it("retire EXPIRED once a confirmed dead code is returned after expiry + margin", async () => {
    (CB_CONFIRMED_DEAD_CODES as Set<string>).add("0099");
    mockStatus.mockResolvedValue({ kind: "answer", code: "0099", currency: null, amount: null });
    expect(await run()).toEqual({ kind: "retire", reason: "EXPIRED" });
  });

  it("active when the status check is unreachable", async () => {
    mockStatus.mockResolvedValue({ kind: "unreachable" });
    expect((await run()).kind).toBe("active");
  });
});

describe("resolveCbmmqrOrder — row without CB's reference (lost create response)", () => {
  const window = (CB_MAX_QR_MINUTES + CB_EXPIRY_MARGIN_MINUTES) * MIN;

  it("retire FAILED after created_at + max validity + margin, without calling CB", async () => {
    expect(await run(row({ orderRef: null, createdAtMs: NOW - window - 1 }))).toEqual({ kind: "retire", reason: "FAILED" });
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("active before that", async () => {
    expect(await run(row({ orderRef: null, createdAtMs: NOW - window + 1000 }))).toEqual({
      kind: "active", retryAtMs: NOW + 1000,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/cbmmqr-resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// ─── resolveCbmmqrOrder ─────────────────────────────────────────────────────
// Spec §5.2. Called for a live CB row the create route cannot simply re-serve
// (amount changed, QR missing, or past its stored expiry). CB has no close
// call, so — unlike resolveKbzpayOrder — this never makes an order dead; it
// can only find out that CB says it is.

import { checkStatus, type CbMerchant, type CallBudget, type StatusResult, CB_SUCCESS } from "@/lib/cbmmqr";
import { settleCbmmqrPayment } from "@/server/payments/settleCbmmqrPayment";
import type { SettleMmqrSource } from "@/server/payments/settleMmqrPayment";
import { CB_EXPIRY_MARGIN_MINUTES, CB_MAX_QR_MINUTES } from "@/server/payments/cbmmqrOrderWindow";

const MIN = 60_000;

/**
 * Status codes CB has confirmed IN WRITING to be final and unpaid: no
 * in-flight or later payment can settle. EMPTY until gate G1 — so until then a
 * QR that was displayed is never replaced. Add a code only with CB's written
 * confirmation and a UAT run that reproduces it, in a reviewed change.
 */
export const CB_CONFIRMED_DEAD_CODES: ReadonlySet<string> = new Set<string>();

/** The only test allowed to free the slot of a QR that was displayed. */
export function isConfirmedDead(status: StatusResult, expiresAtMs: number | null, now: number): boolean {
  if (status.kind !== "answer" || !CB_CONFIRMED_DEAD_CODES.has(status.code)) return false;
  if (expiresAtMs === null) return false;
  return now > expiresAtMs + CB_EXPIRY_MARGIN_MINUTES * MIN;
}

export type CbResolveOutcome =
  | { kind: "already_paid" }
  | { kind: "settlement_conflict"; reason: string }
  | { kind: "retire"; reason: "EXPIRED" | "FAILED" }
  /** Still possibly payable: tell the buyer to wait until retryAtMs. */
  | { kind: "active"; retryAtMs: number }
  | { kind: "blocked"; reason: string };

export async function resolveCbmmqrOrder(input: {
  row: { ref: string; orderRef: string | null; expiresAtMs: number | null; createdAtMs: number };
  /** The merchant pinned on THIS row — never the tenant's current assignment. */
  merchant: CbMerchant;
  source: SettleMmqrSource;
  budget?: CallBudget;
  now?: number;
}): Promise<CbResolveOutcome> {
  const { row, merchant, source, budget } = input;
  const now = input.now ?? Date.now();
  const margin = CB_EXPIRY_MARGIN_MINUTES * MIN;

  // CB's create response was lost: we never received the QR, so it was never
  // displayed and nobody can scan it. This is the ONE documented exception to
  // "never free a slot on elapsed time" (spec §5.2; disputed by Codex in two
  // reviews and kept deliberately — holding the slot would block the buyer for
  // good after one network failure). If a callback arrives meanwhile, the bind
  // sets bank_reference and complete_cbmmqr_replace refuses with 'settling'.
  // Idempotent re-create with the same reference (spec §5.2) is NOT built: it
  // waits for CB's answer to question 3.
  if (!row.orderRef) {
    const freeAt = row.createdAtMs + CB_MAX_QR_MINUTES * MIN + margin;
    return now > freeAt ? { kind: "retire", reason: "FAILED" } : { kind: "active", retryAtMs: freeAt };
  }

  const status = await checkStatus(merchant, row.orderRef, budget);

  if (status.kind === "answer" && status.code === CB_SUCCESS) {
    const settled = await settleCbmmqrPayment({
      payment: { payment_ref: row.ref, payment_method: "cb_mmqr", cbmmqr_merchant: merchant.id },
      merchant,
      status,
      source,
    });
    if (settled.kind === "settled" || settled.kind === "already_settled") return { kind: "already_paid" };
    if (settled.kind === "refused") return { kind: "settlement_conflict", reason: settled.reason };
    return { kind: "blocked", reason: settled.reason };
  }

  if (isConfirmedDead(status, row.expiresAtMs, now)) return { kind: "retire", reason: "EXPIRED" };

  return { kind: "active", retryAtMs: Math.max(row.expiresAtMs ?? now, now) + margin };
}
```

Note: the `active` test for an old expiry expects `NOW + margin` — `Math.max(expiresAtMs, now)` keeps `retryAt` in the future.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/cbmmqr-resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status
git diff --stat
git add src/server/payments/resolveCbmmqrOrder.ts src/__tests__/payments/cbmmqr-resolve.test.ts
git commit -m "feat(cbmmqr): resolve an unservable CB order without ever assuming it dead"
```

---

### Task 8: Create route — `POST /api/public/payments/cbmmqr`

**Files:**
- Create: `src/app/api/public/payments/cbmmqr/route.ts`
- Test: `src/__tests__/payments/cbmmqr-create-route.test.ts`

Read `src/app/api/public/payments/kbzpay/route.ts` first. This route keeps its structure (budget, enrollment lookup, guard, tenant lookup, fee, claim with one retry, translate every outcome) and differs where CB differs: no close call, CB chooses the expiry, a 1,000 minimum, and the QR is stored through `store_cbmmqr_qr`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── POST /api/public/payments/cbmmqr ───────────────────────────────────────
// Spec §5.1, §5.2, §8. Ordering and translation:
//   - the payment row exists BEFORE any CB call (R2)
//   - an ambiguous CB answer never marks the row terminal (R13)
//   - a QR that would outlive the enrollment is never returned (§5.1 step 7)
//   - a live QR is never replaced unless resolveCbmmqrOrder says retire

Object.assign(process.env, {
  CBMMQR_YOUNGMONEY_USER_ID: "u", CBMMQR_YOUNGMONEY_PASSWORD: "p", CBMMQR_YOUNGMONEY_SOURCE_ID: "s",
  CBMMQR_YOUNGMONEY_MERCHANT_ID: "M0001", CBMMQR_YOUNGMONEY_TERMINAL_ID: "T0001", CBMMQR_YOUNGMONEY_API_KEY: "k",
});

type Row = Record<string, unknown>;
let enrollment: Row | null;
let tenant: Row | null;
let rpcResults: Record<string, { data: unknown; error: { message: string } | null }>;
let rpcCalls: { name: string; args: Row }[];
let paymentUpdates: { payload: Row; filters: [string, unknown][] }[];
let events: string[];

vi.mock("@/lib/api", () => ({ resolveTenantId: async () => "ten-1" }));

const mockFrom = vi.fn();
const mockRpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockFrom, rpc: mockRpc }) }));

const mockCreate = vi.fn();
vi.mock("@/lib/cbmmqr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cbmmqr")>();
  return { ...actual, createDynamicQr: (...a: unknown[]) => { events.push("cb:create"); return mockCreate(...a); } };
});

const mockResolve = vi.fn();
vi.mock("@/server/payments/resolveCbmmqrOrder", () => ({
  resolveCbmmqrOrder: (...a: unknown[]) => mockResolve(...a),
}));

vi.mock("@/server/payments/platformFee", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/payments/platformFee")>();
  return { ...actual, attachPackSizes: async (_s: unknown, items: unknown) => items };
});

const { POST } = await import("@/app/api/public/payments/cbmmqr/route");

const MIN = 60_000;
const ENROLLMENT = {
  id: "e-1", enrollment_ref: "ENR-1", tenant_id: "ten-1", class_id: "cls-1", quantity: 2,
  status: "pending_payment", enrolled_at: new Date().toISOString(), student_name_en: "Test",
  classes: { id: "cls-1", fee_amount: 20000, level: "N5" }, enrollment_items: null,
};
const CB_EXPIRY = () => Date.now() + 3 * MIN;

const req = (body: unknown = { enrollmentRef: "ENR-1" }) =>
  new NextRequest("https://beatsrun.kuunyi.com/api/public/payments/cbmmqr", {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

const claimRow = (over: Row = {}) => ({
  outcome: "created", payment_id: "pay-1", ref: null, qr: null, merchant: "YOUNGMONEY",
  expires_at: new Date(Date.now() + 5 * MIN).toISOString(), order_ref: null,
  created_at: new Date().toISOString(), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  enrollment = { ...ENROLLMENT };
  tenant = { auto_cancel_hours: 0, payment_mode: "mmqr", platform_fee_mode: "none", platform_fee_amount: 0 };
  rpcCalls = [];
  paymentUpdates = [];
  events = [];
  rpcResults = {
    claim_cbmmqr_order_slot: { data: [claimRow()], error: null },
    store_cbmmqr_qr: { data: "stored", error: null },
    complete_cbmmqr_replace: { data: [{ outcome: "replaced", payment_id: "pay-2", merchant: "YOUNGMONEY" }], error: null },
  };
  mockCreate.mockResolvedValue({ kind: "created", qr: "000201QR", qrReferenceNo: "QR-1", expiresAtMs: CB_EXPIRY() });

  mockRpc.mockImplementation(async (name: string, args: Row) => {
    events.push(`rpc:${name}`);
    rpcCalls.push({ name, args });
    return rpcResults[name];
  });

  mockFrom.mockImplementation((table: string) => {
    if (table === "enrollments") {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: enrollment, error: enrollment ? null : { message: "none" } }) }) }) }) };
    }
    if (table === "tenants") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: tenant, error: null }) }) }) };
    }
    if (table === "payments") {
      return {
        select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ single: async () => ({ data: null, error: null }) }) }) }) }),
        update: (payload: Row) => {
          const entry = { payload, filters: [] as [string, unknown][] };
          paymentUpdates.push(entry);
          const chain = {
            eq: (col: string, val: unknown) => { entry.filters.push([col, val]); return chain; },
            then: (resolve: (v: unknown) => void) => resolve({ error: null }),
          };
          return chain;
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
});

const called = (name: string) => rpcCalls.filter((c) => c.name === name);

describe("validation and guards", () => {
  it("400 on bad JSON or a missing enrollmentRef", async () => {
    expect((await POST(req("{nope"))).status).toBe(400);
    expect((await POST(req({}))).status).toBe(400);
  });

  it("404 for an unknown enrollment; 409 when it is not awaiting payment", async () => {
    enrollment = null;
    expect((await POST(req())).status).toBe(404);
    enrollment = { ...ENROLLMENT, status: "confirmed" };
    expect((await POST(req())).status).toBe(409);
  });

  it("422 below 1,000 MMK, before any claim or CB call", async () => {
    enrollment = { ...ENROLLMENT, quantity: 1, classes: { id: "cls-1", fee_amount: 999, level: "N5" } };
    const res = await POST(req());
    expect(res.status).toBe(422);
    expect((await res.json()).message).toMatch(/1,000 MMK/);
    expect(rpcCalls).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("409 deadline when auto-cancel leaves no room for a full QR lifetime", async () => {
    tenant = { ...tenant, auto_cancel_hours: 15 };
    enrollment = { ...ENROLLMENT, enrolled_at: new Date(Date.now() - 11 * MIN).toISOString() };
    expect((await POST(req())).status).toBe(409);
    expect(rpcCalls).toHaveLength(0);
  });

  it("502 and no claim when the tenant row cannot be read", async () => {
    tenant = null;
    expect((await POST(req())).status).toBe(502);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("created", () => {
  it("claims, then calls CB, then stores; returns qr, orderId, amount and expiresAt", async () => {
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(events).toEqual(["rpc:claim_cbmmqr_order_slot", "cb:create", "rpc:store_cbmmqr_qr"]);
    const ref = called("claim_cbmmqr_order_slot")[0].args.p_payment_ref as string;
    expect(ref).toMatch(/^CB[A-Z2-7]{23}$/);
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ referenceNo: ref, amount: 40000 });
    expect(called("store_cbmmqr_qr")[0].args).toMatchObject({ p_payment_ref: ref, p_qr: "000201QR", p_order_ref: "QR-1" });
    expect(body).toMatchObject({ status: "created", qr: "000201QR", orderId: ref, amount: 40000 });
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("uses the merchant pinned by the claim", async () => {
    await POST(req());
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ id: "YOUNGMONEY", merchantId: "M0001" });
  });

  it("reuse: returns the stored QR without calling CB", async () => {
    rpcResults.claim_cbmmqr_order_slot = { data: [claimRow({ outcome: "reuse", ref: "CBOLD", qr: "000201OLD" })], error: null };
    const body = await (await POST(req())).json();
    expect(body).toMatchObject({ status: "created", qr: "000201OLD", orderId: "CBOLD" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("409 when the claim says invalid_enrollment", async () => {
    rpcResults.claim_cbmmqr_order_slot = { data: [claimRow({ outcome: "invalid_enrollment" })], error: null };
    expect((await POST(req())).status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("503 on no_merchant or a pinned merchant with no config; CB never called", async () => {
    rpcResults.claim_cbmmqr_order_slot = { data: [claimRow({ outcome: "no_merchant", merchant: null })], error: null };
    expect((await POST(req())).status).toBe(503);
    rpcResults.claim_cbmmqr_order_slot = { data: [claimRow({ merchant: "NOCONFIG" })], error: null };
    expect((await POST(req())).status).toBe(503);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("CB's answer", () => {
  it("ambiguous: 502, row left PENDING (no update), nothing stored", async () => {
    mockCreate.mockResolvedValue({ kind: "ambiguous", code: null });
    expect((await POST(req())).status).toBe(502);
    expect(paymentUpdates).toHaveLength(0);
    expect(called("store_cbmmqr_qr")).toHaveLength(0);
  });

  it.each([
    ["below_minimum", 422], ["above_maximum", 422], ["config", 503],
  ])("rejected (%s): marks the row FAILED and answers %i", async (reason, status) => {
    mockCreate.mockResolvedValue({ kind: "rejected", reason, code: "0051" });
    expect((await POST(req())).status).toBe(status);
    expect(paymentUpdates).toHaveLength(1);
    expect(paymentUpdates[0].payload).toEqual({ mmqr_status: "FAILED" });
    expect(paymentUpdates[0].filters).toEqual(expect.arrayContaining([["mmqr_status", "PENDING"]]));
  });

  it("post-check too late: stores CB's reference WITHOUT the QR and answers 409", async () => {
    tenant = { ...tenant, auto_cancel_hours: 15 };
    mockCreate.mockResolvedValue({ kind: "created", qr: "000201QR", qrReferenceNo: "QR-1", expiresAtMs: Date.now() + 60 * MIN });
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(called("store_cbmmqr_qr")[0].args).toMatchObject({ p_qr: null, p_order_ref: "QR-1" });
    expect(JSON.stringify(await res.json())).not.toContain("000201QR");
  });

  it("post-check: an unreadable CB expiry is never displayed", async () => {
    mockCreate.mockResolvedValue({ kind: "created", qr: "000201QR", qrReferenceNo: "QR-1", expiresAtMs: null });
    expect((await POST(req())).status).toBe(409);
    expect(called("store_cbmmqr_qr")[0].args).toMatchObject({ p_qr: null });
  });

  it("409 when the enrollment stopped being payable before the QR was stored", async () => {
    rpcResults.store_cbmmqr_qr = { data: "not_payable", error: null };
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain("000201QR");
  });

  it.each(["not_live", "ref_conflict", "not_found"])("502 when the store returns %s", async (r) => {
    rpcResults.store_cbmmqr_qr = { data: r, error: null };
    expect((await POST(req())).status).toBe(502);
  });

  it("502 when the store errors", async () => {
    rpcResults.store_cbmmqr_qr = { data: null, error: { message: "boom" } };
    expect((await POST(req())).status).toBe(502);
  });
});

describe("unresolved", () => {
  beforeEach(() => {
    rpcResults.claim_cbmmqr_order_slot = {
      data: [claimRow({ outcome: "unresolved", ref: "CBOLD", order_ref: "QR-OLD" })], error: null,
    };
  });

  it("active: 409 qr_active with retryAt; no replacement, no CB create", async () => {
    const retryAtMs = Date.now() + 4 * MIN;
    mockResolve.mockResolvedValue({ kind: "active", retryAtMs });
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ status: "qr_active", retryAt: new Date(retryAtMs).toISOString() });
    expect(body.message).toMatch(/previous QR is still active/);
    expect(called("complete_cbmmqr_replace")).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("passes the old row and its pinned merchant to the resolver", async () => {
    mockResolve.mockResolvedValue({ kind: "active", retryAtMs: Date.now() + MIN });
    await POST(req());
    expect(mockResolve.mock.calls[0][0]).toMatchObject({
      row: { ref: "CBOLD", orderRef: "QR-OLD" }, merchant: { id: "YOUNGMONEY" }, source: "create",
    });
  });

  it("already_paid → { status: 'already_paid' }", async () => {
    mockResolve.mockResolvedValue({ kind: "already_paid" });
    expect(await (await POST(req())).json()).toEqual({ status: "already_paid" });
  });

  it("settlement_conflict → 409; blocked → 502", async () => {
    mockResolve.mockResolvedValue({ kind: "settlement_conflict", reason: "x" });
    expect((await POST(req())).status).toBe(409);
    mockResolve.mockResolvedValue({ kind: "blocked", reason: "x" });
    expect((await POST(req())).status).toBe(502);
  });

  it("retire: replaces with the tenant id and reason, then creates under the new reference", async () => {
    mockResolve.mockResolvedValue({ kind: "retire", reason: "EXPIRED" });
    const body = await (await POST(req())).json();
    const args = called("complete_cbmmqr_replace")[0].args;
    expect(args).toMatchObject({ p_enrollment_id: "e-1", p_tenant_id: "ten-1", p_expected_old_ref: "CBOLD", p_reason: "EXPIRED" });
    expect(mockCreate.mock.calls[0][1].referenceNo).toBe(args.p_new_ref);
    expect(body.orderId).toBe(args.p_new_ref);
  });

  it.each([
    ["already_settled", 200], ["settling", 409], ["not_payable", 409], ["invalid_enrollment", 409],
    ["no_merchant", 503], ["not_live", 502],
  ])("replace outcome %s → %i", async (outcome, status) => {
    mockResolve.mockResolvedValue({ kind: "retire", reason: "EXPIRED" });
    rpcResults.complete_cbmmqr_replace = { data: [{ outcome, payment_id: null, merchant: null }], error: null };
    const res = await POST(req());
    expect(res.status).toBe(status);
    if (outcome === "already_settled") expect(await res.json()).toEqual({ status: "already_paid" });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/cbmmqr-create-route.test.ts`
Expected: FAIL — route module not found.

- [ ] **Step 3: Implement the route**

```ts
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import {
  buildReferenceNo,
  createDynamicQr,
  getCbMerchant,
  type CallBudget,
  type CbMerchant,
} from "@/lib/cbmmqr";
import { resolveCbmmqrOrder } from "@/server/payments/resolveCbmmqrOrder";
import {
  enrollmentDeadline,
  postCheck,
  preCheck,
  provisionalExpiry,
} from "@/server/payments/cbmmqrOrderWindow";
import { attachPackSizes, computeOrderTotal } from "@/server/payments/platformFee";

// Same 10s Vercel cap as the KBZPay route; declared so it is visible.
export const maxDuration = 10;
const GATEWAY_BUDGET_MS = 8_000;

/** CB's §4.2 code 0051: "The payment amount must be at least 1000." */
const CB_MIN_AMOUNT = 1000;

// ─── POST /api/public/payments/cbmmqr ───────────────────────────────────────
// Design: docs/superpowers/specs/2026-10-31-cb-mmqr-integration-design.md §5.1
//
// Body: { enrollmentRef: string }
// 200 { status: 'created', qr, orderId, amount, expiresAt } | { status: 'already_paid' }
// Every other answer is an error with a `message` the modal shows as is.

type EnrollmentRow = {
  id: string;
  enrollment_ref: string;
  tenant_id: string;
  class_id: string | null;
  quantity: number | null;
  status: string;
  enrolled_at: string | null;
  classes: { id: string; fee_amount: number; level: string } | null;
  enrollment_items: { class_id: string; quantity: number; fee_amount: number }[] | null;
};

type ClaimRow = {
  outcome: string;
  payment_id: string | null;
  ref: string | null;
  qr: string | null;
  merchant: string | null;
  expires_at: string | null;
  order_ref: string | null;
  created_at: string | null;
};
type ReplaceRow = { outcome: string; payment_id: string | null; merchant: string | null };

const fail = (status: number, message: string, error: string) =>
  NextResponse.json({ error, message }, { status });

const gatewayError = () => fail(502, "Failed to generate QR code. Please try again.", "Payment Gateway Error");
const notConfigured = () => fail(503, "Payment is not available for this event yet.", "Service Unavailable");
const notAwaiting = () => fail(409, "This enrollment is not awaiting payment.", "Conflict");
const belowMinimum = () => fail(422, "CB Bank QR payments need at least 1,000 MMK.", "Unprocessable Entity");
const aboveMaximum = () =>
  fail(422, "This amount is above CB Bank's QR payment limit. Please contact the organiser.", "Unprocessable Entity");
const deadlineConflict = () =>
  fail(409, "This booking expires too soon for a QR payment. Please start a new booking.", "Conflict");

function qrActive(retryAtMs: number) {
  const minutes = Math.max(1, Math.ceil((retryAtMs - Date.now()) / 60_000));
  return NextResponse.json(
    {
      error: "Conflict",
      status: "qr_active",
      retryAt: new Date(retryAtMs).toISOString(),
      message: `Your previous QR is still active. Scan it if you still have it, or try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    },
    { status: 409 },
  );
}

function resolveMerchant(id: string | null, context: string): CbMerchant | null {
  try {
    return getCbMerchant(id);
  } catch (err) {
    console.error(`[cbmmqr] merchant config error for ${context}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** As the KBZPay route: a budget only where a platform caps the request. */
function gatewayBudget(): CallBudget | undefined {
  if (!process.env.VERCEL) return undefined;
  return { deadlineMs: Date.now() + GATEWAY_BUDGET_MS };
}

export async function POST(request: NextRequest) {
  const budget = gatewayBudget();

  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  // ── 1. Parse ───────────────────────────────────────────────
  let body: { enrollmentRef?: string };
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body.", "Bad Request");
  }
  const { enrollmentRef } = body;
  if (!enrollmentRef || typeof enrollmentRef !== "string") {
    return fail(400, "enrollmentRef is required.", "Bad Request");
  }

  const supabase = createAdminClient();

  // ── 2. Enrollment ──────────────────────────────────────────
  const { data: enrollment, error: enrollmentError } = (await supabase
    .from("enrollments")
    .select("*, classes(id, fee_amount, level), enrollment_items(class_id, quantity, fee_amount)")
    .eq("enrollment_ref", enrollmentRef.trim())
    .eq("tenant_id", tenantId)
    .single()) as { data: EnrollmentRow | null; error: unknown };

  if (enrollmentError || !enrollment) return fail(404, "Enrollment not found.", "Not Found");

  // ── 3. Guard (re-proven under the claim's lock) ────────────
  if (enrollment.status !== "pending_payment" && enrollment.status !== "partial_payment") {
    return notAwaiting();
  }

  // ── 4. Tenant settings and the pre-check (spec §5.1 step 4) ─
  const { data: tenant, error: tenantError } = (await supabase
    .from("tenants")
    .select("auto_cancel_hours, payment_mode, platform_fee_mode, platform_fee_amount")
    .eq("id", enrollment.tenant_id)
    .maybeSingle()) as {
    data: {
      auto_cancel_hours: number | null;
      payment_mode: string | null;
      platform_fee_mode: string | null;
      platform_fee_amount: number | null;
    } | null;
    error: { message: string } | null;
  };

  // Fail closed: without the tenant row we do not know the deadline.
  if (tenantError || !tenant) {
    console.error(`[cbmmqr] tenant ${enrollment.tenant_id} lookup failed; refusing to guess the deadline`);
    return gatewayError();
  }

  const deadline = enrollmentDeadline(tenant.auto_cancel_hours, enrollment.enrolled_at);
  const pre = preCheck(deadline, Date.now());
  if (pre === "unknown") {
    console.error(`[cbmmqr] cannot derive the deadline for ${enrollment.enrollment_ref}; refusing to guess`);
    return gatewayError();
  }
  if (pre === "too_close") return deadlineConflict();

  // ── 5. Total, exactly as the KBZPay route ──────────────────
  const isCart =
    !enrollment.class_id && enrollment.enrollment_items && enrollment.enrollment_items.length > 0;
  const orderItems = isCart
    ? enrollment.enrollment_items!.map((i) => ({ class_id: i.class_id, fee_amount: i.fee_amount, quantity: i.quantity }))
    : enrollment.classes
      ? [{ class_id: enrollment.classes.id, fee_amount: enrollment.classes.fee_amount, quantity: enrollment.quantity ?? 1 }]
      : null;
  if (!orderItems) return fail(500, "Class data not found.", "Internal Server Error");

  const order = computeOrderTotal(await attachPackSizes(supabase, orderItems, tenant), tenant);
  let totalFee = order.total;
  let recordedFee = order.platformFee;

  if (enrollment.status === "partial_payment") {
    const { data: existingPayment } = (await supabase
      .from("payments")
      .select("received_amount")
      .eq("enrollment_id", enrollment.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()) as { data: { received_amount: number | null } | null; error: unknown };
    if (existingPayment?.received_amount) {
      totalFee = totalFee - existingPayment.received_amount;
      recordedFee = 0;
    }
  }

  // ── 6. CB's minimum, before any row or call ────────────────
  if (totalFee < CB_MIN_AMOUNT) return belowMinimum();

  // ── 7. Claim the slot ──────────────────────────────────────
  const claimed = await claimSlot();
  if (claimed instanceof NextResponse) return claimed;

  if (claimed.outcome === "no_merchant") {
    console.error(`[cbmmqr] tenant ${enrollment.tenant_id} has no CB merchant assigned`);
    return notConfigured();
  }

  // The pinned merchant, before ANY branch — including reuse: a merchant whose
  // config is broken must not keep handing out QRs we cannot verify.
  let merchant = resolveMerchant(claimed.merchant, claimed.ref ?? enrollment.enrollment_ref);
  if (!merchant) return notConfigured();

  if (claimed.outcome === "reuse") {
    return NextResponse.json({
      status: "created",
      qr: claimed.qr,
      orderId: claimed.ref,
      amount: totalFee,
      expiresAt: claimed.expires_at,
    });
  }

  if (claimed.outcome !== "created" && claimed.outcome !== "unresolved") {
    console.error(`[cbmmqr] unexpected claim outcome "${claimed.outcome}"; refusing to call CB`);
    return gatewayError();
  }

  let ref = claimed.ref;

  // ── 8. Unresolved → ask CB, never assume (spec §5.2) ───────
  if (claimed.outcome === "unresolved") {
    const oldRef = claimed.ref!;
    const resolution = await resolveCbmmqrOrder({
      row: {
        ref: oldRef,
        orderRef: claimed.order_ref,
        expiresAtMs: claimed.expires_at ? Date.parse(claimed.expires_at) : null,
        createdAtMs: claimed.created_at ? Date.parse(claimed.created_at) : Date.now(),
      },
      merchant,
      source: "create",
      budget,
    });

    if (resolution.kind === "already_paid") return NextResponse.json({ status: "already_paid" });
    if (resolution.kind === "settlement_conflict") {
      return fail(409, "A previous payment for this enrollment needs review. Please contact support.", "Conflict");
    }
    if (resolution.kind === "active") return qrActive(resolution.retryAtMs);
    if (resolution.kind === "blocked") {
      console.error(`[cbmmqr] resolve blocked for ${oldRef}: ${resolution.reason}`);
      return gatewayError();
    }

    // retire — CB proved the old QR dead (or it was never displayed).
    const newRef = buildReferenceNo();
    const { data, error } = (await supabase.rpc("complete_cbmmqr_replace", {
      p_enrollment_id: enrollment.id,
      p_tenant_id: enrollment.tenant_id,
      p_expected_old_ref: oldRef,
      p_reason: resolution.reason,
      p_new_ref: newRef,
      p_amount: totalFee,
      p_platform_fee: recordedFee,
      p_expires_at: new Date(provisionalExpiry(Date.now())).toISOString(),
    } as never)) as { data: ReplaceRow[] | null; error: { message: string } | null };

    if (error || !data?.length) {
      console.error(`[cbmmqr] replace failed for ${oldRef}: ${error?.message ?? "no rows"}`);
      return gatewayError();
    }
    const outcome = data[0].outcome;
    if (outcome === "already_settled") return NextResponse.json({ status: "already_paid" });
    if (outcome === "settling") {
      // CB reported the old order paid and settlement is finishing. Never a new QR.
      return fail(409, "We have received a payment for this booking and are confirming it. Please wait a moment.", "Conflict");
    }
    if (outcome === "not_payable" || outcome === "invalid_enrollment") return notAwaiting();
    if (outcome === "no_merchant") return notConfigured();
    if (outcome !== "replaced") {
      console.error(`[cbmmqr] replace returned ${outcome} for ${oldRef}`);
      return gatewayError();
    }

    ref = newRef;
    const next = resolveMerchant(data[0].merchant, newRef);
    if (!next) return notConfigured();
    merchant = next;
  }

  if (!ref) {
    console.error("[cbmmqr] no payment_ref after claim/replace; refusing to call CB");
    return gatewayError();
  }

  // ── 9. Ask CB for the QR. The row already exists (R2). ─────
  const created = await createDynamicQr(
    merchant,
    { referenceNo: ref, amount: totalFee, purpose: `Payment ${enrollment.enrollment_ref}` },
    budget,
  );

  if (created.kind === "ambiguous") {
    // NOT marked FAILED: CB may hold a QR under this reference (R13). §5.2
    // frees the slot later; the QR was never shown, so nobody can pay it.
    console.error(`[cbmmqr] create ambiguous for ${ref} (code ${created.code ?? "none"}); row left PENDING`);
    return gatewayError();
  }

  if (created.kind === "rejected") {
    // CB created nothing, so the slot can be freed now.
    const { error: markError } = (await supabase
      .from("payments")
      .update({ mmqr_status: "FAILED" } as never)
      .eq("payment_ref", ref)
      .eq("mmqr_status", "PENDING")) as { error: { message: string } | null };
    if (markError) console.error(`[cbmmqr] could not mark ${ref} FAILED: ${markError.message}`);
    console.error(`[cbmmqr] CB rejected ${ref} with ${created.code} (${created.reason})`);
    if (created.reason === "below_minimum") return belowMinimum();
    if (created.reason === "above_maximum") return aboveMaximum();
    return notConfigured();
  }

  // ── 10. Post-check, then store through the locking RPC ─────
  const displayable = postCheck(deadline, created.expiresAtMs) === "ok";
  const expiresAtIso = new Date(created.expiresAtMs ?? provisionalExpiry(Date.now())).toISOString();

  const { data: stored, error: storeError } = (await supabase.rpc("store_cbmmqr_qr", {
    p_payment_ref: ref,
    p_qr: displayable ? created.qr : null,
    p_order_ref: created.qrReferenceNo,
    p_expires_at: expiresAtIso,
  } as never)) as { data: string | null; error: { message: string } | null };

  if (storeError) {
    console.error(`[cbmmqr] store failed for ${ref}: ${storeError.message}; row left PENDING`);
    return gatewayError();
  }
  if (stored === "not_payable") return notAwaiting();
  if (stored !== "stored") {
    console.error(`[cbmmqr] store returned ${stored} for ${ref}`);
    return gatewayError();
  }
  if (!displayable) {
    console.error(`[cbmmqr] QR for ${ref} would outlive its enrollment; withheld`);
    return deadlineConflict();
  }

  return NextResponse.json({
    status: "created",
    qr: created.qr,
    orderId: ref,
    amount: totalFee,
    expiresAt: expiresAtIso,
  });

  // ── Claim with one retry on a lost unique-index race ───────
  async function claimSlot(): Promise<ClaimRow | NextResponse> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, error } = (await supabase.rpc("claim_cbmmqr_order_slot", {
        p_enrollment_id: enrollment!.id,
        p_tenant_id: enrollment!.tenant_id,
        p_payment_ref: buildReferenceNo(),
        p_amount: totalFee,
        p_platform_fee: recordedFee,
        p_expires_at: new Date(provisionalExpiry(Date.now())).toISOString(),
      } as never)) as { data: ClaimRow[] | null; error: { message: string } | null };

      if (error) {
        if (attempt === 0 && /duplicate key|unique/i.test(error.message)) continue;
        console.error(`[cbmmqr] claim failed: ${error.message}`);
        return gatewayError();
      }
      if (!data?.length) {
        console.error("[cbmmqr] claim returned no rows");
        return gatewayError();
      }
      if (data[0].outcome === "invalid_enrollment") return notAwaiting();
      return data[0];
    }
    return gatewayError();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/cbmmqr-create-route.test.ts`
Expected: PASS. If a test about ordering fails, fix the route, not the test: the order "claim → CB → store" is the R2 guarantee.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit` — expected exit code 0.

```bash
git status
git diff --stat
git add src/app/api/public/payments/cbmmqr/route.ts src/__tests__/payments/cbmmqr-create-route.test.ts
git commit -m "feat(cbmmqr): create route — row first, CB second, QR withheld if it would outlive the booking"
```

---

### Task 9: Status route — `GET /api/public/payments/cbmmqr/status`

**Files:**
- Create: `src/app/api/public/payments/cbmmqr/status/route.ts`
- Test: `src/__tests__/payments/cbmmqr-status-route.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Spec §5.4: PENDING | SUCCESS only. Local time never reports a QR dead, and
// the route never replaces an order.

Object.assign(process.env, {
  CBMMQR_YOUNGMONEY_USER_ID: "u", CBMMQR_YOUNGMONEY_PASSWORD: "p", CBMMQR_YOUNGMONEY_SOURCE_ID: "s",
  CBMMQR_YOUNGMONEY_MERCHANT_ID: "M0001", CBMMQR_YOUNGMONEY_TERMINAL_ID: "T0001", CBMMQR_YOUNGMONEY_API_KEY: "k",
});

let payment: Record<string, unknown> | null;
const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockFrom }) }));
const mockStatus = vi.fn();
vi.mock("@/lib/cbmmqr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cbmmqr")>();
  return { ...actual, checkStatus: (...a: unknown[]) => mockStatus(...a) };
});
const mockSettle = vi.fn();
vi.mock("@/server/payments/settleCbmmqrPayment", () => ({
  settleCbmmqrPayment: (...a: unknown[]) => mockSettle(...a),
}));

const { GET } = await import("@/app/api/public/payments/cbmmqr/status/route");

const REF = "CBAAAAAAAAAAAAAAAAAAAAAAA";
const get = (ref: string | null = REF) =>
  GET(new NextRequest(`https://beatsrun.kuunyi.com/api/public/payments/cbmmqr/status${ref === null ? "" : `?ref=${ref}`}`));
const PAYMENT = {
  payment_ref: REF, payment_method: "cb_mmqr", cbmmqr_merchant: "YOUNGMONEY", status: "awaiting_payment",
  mmqr_status: "PENDING", provider_order_ref: "QR-1", provider_order_expires_at: "2026-10-31T04:03:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  payment = { ...PAYMENT };
  mockFrom.mockImplementation(() => ({
    select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: payment, error: null }) }) }) }),
  }));
  mockStatus.mockResolvedValue({ kind: "answer", code: "0006", currency: null, amount: null });
  mockSettle.mockResolvedValue({ kind: "settled" });
});

describe("GET /api/public/payments/cbmmqr/status", () => {
  it("400 without a well-formed ref", async () => {
    expect((await get(null)).status).toBe(400);
    expect((await get("KBZ_x")).status).toBe(400);
  });

  it("PENDING for an unknown reference", async () => {
    payment = null;
    expect(await (await get()).json()).toEqual({ mmqr_status: "PENDING" });
  });

  it("SUCCESS for a verified payment without calling CB", async () => {
    payment = { ...PAYMENT, status: "verified" };
    expect((await (await get()).json()).mmqr_status).toBe("SUCCESS");
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("PENDING with expiresAt while CB says waiting — even long past the expiry", async () => {
    payment = { ...PAYMENT, provider_order_expires_at: "2020-01-01T00:00:00.000Z" };
    expect(await (await get()).json()).toEqual({ mmqr_status: "PENDING", expiresAt: "2020-01-01T00:00:00.000Z" });
  });

  it("PENDING without calling CB when CB's reference is unknown or the row is retired", async () => {
    payment = { ...PAYMENT, provider_order_ref: null };
    expect((await (await get()).json()).mmqr_status).toBe("PENDING");
    payment = { ...PAYMENT, mmqr_status: "EXPIRED" };
    expect((await (await get()).json()).mmqr_status).toBe("PENDING");
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("settles through the wrapper on CB success and answers SUCCESS", async () => {
    const answer = { kind: "answer", code: "0000", currency: "MMK", amount: 40000 };
    mockStatus.mockResolvedValue(answer);
    expect((await (await get()).json()).mmqr_status).toBe("SUCCESS");
    expect(mockStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "YOUNGMONEY" }), "QR-1", undefined);
    expect(mockSettle).toHaveBeenCalledWith(expect.objectContaining({
      payment: { payment_ref: REF, payment_method: "cb_mmqr", cbmmqr_merchant: "YOUNGMONEY" },
      status: answer, source: "status",
    }));
  });

  it.each(["refused", "retryable"])("PENDING when settlement is %s", async (kind) => {
    mockStatus.mockResolvedValue({ kind: "answer", code: "0000", currency: "MMK", amount: 40000 });
    mockSettle.mockResolvedValue({ kind, reason: "x" });
    expect((await (await get()).json()).mmqr_status).toBe("PENDING");
  });

  it("PENDING when the pinned merchant has no config", async () => {
    payment = { ...PAYMENT, cbmmqr_merchant: "NOCONFIG" };
    expect((await (await get()).json()).mmqr_status).toBe("PENDING");
    expect(mockStatus).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/cbmmqr-status-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CB_SUCCESS, REFERENCE_PATTERN, checkStatus, getCbMerchant, type CallBudget, type CbMerchant } from "@/lib/cbmmqr";
import { settleCbmmqrPayment } from "@/server/payments/settleCbmmqrPayment";

export const maxDuration = 10;
/** Smaller than the create route's: settlement runs after the call (as KBZPay). */
const GATEWAY_BUDGET_MS = 6_000;

// ─── GET /api/public/payments/cbmmqr/status?ref= ────────────────────────────
// Spec §5.4. Answers { mmqr_status: 'PENDING' | 'SUCCESS', expiresAt? }.
// There is no EXPIRED or FAILED: local time never says a CB QR is dead, and a
// retired row simply stays PENDING here while the modal's retry path takes over.

type PaymentRow = {
  payment_ref: string;
  payment_method: string | null;
  cbmmqr_merchant: string | null;
  status: string;
  mmqr_status: string | null;
  provider_order_ref: string | null;
  provider_order_expires_at: string | null;
};

function gatewayBudget(): CallBudget | undefined {
  if (!process.env.VERCEL) return undefined;
  return { deadlineMs: Date.now() + GATEWAY_BUDGET_MS };
}

export async function GET(request: NextRequest) {
  const ref = request.nextUrl.searchParams.get("ref");
  if (!ref || !REFERENCE_PATTERN.test(ref)) {
    return NextResponse.json({ error: "Bad Request", message: "ref is required." }, { status: 400 });
  }

  const { data: payment, error } = (await createAdminClient()
    .from("payments")
    .select("payment_ref, payment_method, cbmmqr_merchant, status, mmqr_status, provider_order_ref, provider_order_expires_at")
    .eq("payment_ref", ref)
    .eq("payment_method", "cb_mmqr")
    .maybeSingle()) as { data: PaymentRow | null; error: { message: string } | null };

  if (error) console.error(`[cbmmqr-status] lookup failed for ${ref}: ${error.message}`);
  if (!payment) return NextResponse.json({ mmqr_status: "PENDING" });

  if (payment.status === "verified") return NextResponse.json({ mmqr_status: "SUCCESS" });

  const pending = () =>
    NextResponse.json({ mmqr_status: "PENDING", expiresAt: payment.provider_order_expires_at });

  if (payment.status !== "awaiting_payment" || payment.mmqr_status !== "PENDING" || !payment.provider_order_ref) {
    return pending();
  }

  let merchant: CbMerchant;
  try {
    merchant = getCbMerchant(payment.cbmmqr_merchant);
  } catch (err) {
    console.error(`[cbmmqr-status] merchant config error for ${ref}: ${err instanceof Error ? err.message : err}`);
    return pending();
  }

  const status = await checkStatus(merchant, payment.provider_order_ref, gatewayBudget());
  if (status.kind !== "answer" || status.code !== CB_SUCCESS) return pending();

  const outcome = await settleCbmmqrPayment({
    payment: { payment_ref: payment.payment_ref, payment_method: payment.payment_method, cbmmqr_merchant: payment.cbmmqr_merchant },
    merchant,
    status,
    source: "status",
  });

  if (outcome.kind === "settled" || outcome.kind === "already_settled") {
    return NextResponse.json({ mmqr_status: "SUCCESS" });
  }
  console.error(`[cbmmqr-status] ${ref} settlement returned ${outcome.kind}`);
  return pending();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/cbmmqr-status-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status
git diff --stat
git add src/app/api/public/payments/cbmmqr/status/route.ts src/__tests__/payments/cbmmqr-status-route.test.ts
git commit -m "feat(cbmmqr): status route that never reports a QR dead from local time"
```

---

### Task 10: Callback — `POST /api/webhooks/cbmmqr`

**Files:**
- Create: `src/app/api/webhooks/cbmmqr/route.ts`
- Test: `src/__tests__/payments/cbmmqr-webhook-route.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Spec §5.3. The callback is a wake-up only: no callback field ever moves
// money. Settlement happens solely through our own status check.

Object.assign(process.env, {
  CBMMQR_YOUNGMONEY_USER_ID: "u", CBMMQR_YOUNGMONEY_PASSWORD: "p", CBMMQR_YOUNGMONEY_SOURCE_ID: "s",
  CBMMQR_YOUNGMONEY_MERCHANT_ID: "M0001", CBMMQR_YOUNGMONEY_TERMINAL_ID: "T0001",
  CBMMQR_YOUNGMONEY_API_KEY: "ym-api-key",
  CBMMQR_OTHER_USER_ID: "u2", CBMMQR_OTHER_PASSWORD: "p2", CBMMQR_OTHER_SOURCE_ID: "s2",
  CBMMQR_OTHER_MERCHANT_ID: "M0002", CBMMQR_OTHER_TERMINAL_ID: "T0002", CBMMQR_OTHER_API_KEY: "other-api-key",
});

let payment: Record<string, unknown> | null;
let lookupError: { message: string } | null;
const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockFrom }) }));
const mockStatus = vi.fn();
vi.mock("@/lib/cbmmqr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cbmmqr")>();
  return { ...actual, checkStatus: (...a: unknown[]) => mockStatus(...a) };
});
const mockSettle = vi.fn();
vi.mock("@/server/payments/settleCbmmqrPayment", () => ({
  settleCbmmqrPayment: (...a: unknown[]) => mockSettle(...a),
}));

const { POST } = await import("@/app/api/webhooks/cbmmqr/route");

const REF = "CBAAAAAAAAAAAAAAAAAAAAAAA";
const BODY = {
  apiKey: "ym-api-key", referenceNo: REF, transactionId: "TXN-1", transCurrency: "104", transAmount: 40000,
  transDateTime: "20261031 10:12:00", transStatusCode: "0000", transStatusDescription: "SUCCESS",
  qrReferenceNo: "QR-1", institutionId: "1111", institutionName: "Wave Money", merchantId: "M0001",
  remark: "", terminalId: "T0001",
};
const post = (body: unknown = BODY) =>
  POST(new NextRequest("https://beatsrun.kuunyi.com/api/webhooks/cbmmqr", {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }));
const PAID = { kind: "answer", code: "0000", referenceNo: REF, currency: "MMK", amount: 40000 };

beforeEach(() => {
  vi.clearAllMocks();
  payment = { payment_ref: REF, payment_method: "cb_mmqr", cbmmqr_merchant: "YOUNGMONEY", status: "awaiting_payment" };
  lookupError = null;
  mockFrom.mockImplementation(() => ({
    select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: payment, error: lookupError }) }) }) }),
  }));
  mockStatus.mockResolvedValue(PAID);
  mockSettle.mockResolvedValue({ kind: "settled" });
});

describe("POST /api/webhooks/cbmmqr", () => {
  it("settles via our status check and acknowledges with CB's reply shape", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ qrReferenceNo: "QR-1", returnCode: "0000", message: "Success" });
    expect(mockStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "YOUNGMONEY" }), "QR-1", undefined);
    expect(mockSettle).toHaveBeenCalledWith(expect.objectContaining({ status: PAID, source: "callback" }));
  });

  it("never passes a callback field to settlement — only the status response", async () => {
    await post({ ...BODY, transAmount: 1, transCurrency: "840" });
    expect(mockSettle.mock.calls[0][0].status).toBe(PAID);
  });

  it.each([
    ["malformed JSON", "{nope"],
    ["a non-object", "[]"],
    ["a bad referenceNo", { ...BODY, referenceNo: "KBZ_x" }],
    ["a missing apiKey", { ...BODY, apiKey: undefined }],
    ["an over-long qrReferenceNo", { ...BODY, qrReferenceNo: "Q".repeat(26) }],
    ["a body over 8 KB", { ...BODY, remark: "x".repeat(9000) }],
    ["an over-long transactionId", { ...BODY, transactionId: "T".repeat(36) }],
    ["a non-string merchantId", { ...BODY, merchantId: { x: 1 } }],
    ["an over-long terminalId", { ...BODY, terminalId: "T".repeat(9) }],
    ["a non-numeric transAmount", { ...BODY, transAmount: "lots" }],
    ["a negative transAmount", { ...BODY, transAmount: -1 }],
    ["an over-long institutionName", { ...BODY, institutionName: "I".repeat(151) }],
  ])("400 for %s, before any lookup", async (_n, body) => {
    expect((await post(body)).status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("404 for an unknown reference; 500 when the lookup fails", async () => {
    payment = null;
    expect((await post()).status).toBe(404);
    lookupError = { message: "down" };
    expect((await post()).status).toBe(500);
  });

  it("403 for a wrong key — including another merchant's valid key", async () => {
    expect((await post({ ...BODY, apiKey: "wrong" })).status).toBe(403);
    expect((await post({ ...BODY, apiKey: "other-api-key" })).status).toBe(403);
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("500 when the pinned merchant has no config", async () => {
    payment = { ...payment, cbmmqr_merchant: "NOCONFIG" };
    expect((await post()).status).toBe(500);
  });

  it("FAIL is acknowledged and changes nothing", async () => {
    const res = await post({ ...BODY, transStatusDescription: "FAIL" });
    expect(res.status).toBe(200);
    expect(mockStatus).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("500 when the status check is unreachable or does not show success", async () => {
    mockStatus.mockResolvedValue({ kind: "unreachable" });
    expect((await post()).status).toBe(500);
    mockStatus.mockResolvedValue({ kind: "answer", code: "0006", currency: null, amount: null });
    expect((await post()).status).toBe(500);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("refused settlement is acknowledged (retrying cannot change it); retryable is 500", async () => {
    mockSettle.mockResolvedValue({ kind: "refused", reason: "x" });
    expect((await post()).status).toBe(200);
    mockSettle.mockResolvedValue({ kind: "retryable", reason: "x" });
    expect((await post()).status).toBe(500);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/cbmmqr-webhook-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  CB_SUCCESS,
  REFERENCE_PATTERN,
  apiKeyMatches,
  checkStatus,
  getCbMerchant,
  type CallBudget,
  type CbMerchant,
} from "@/lib/cbmmqr";
import { settleCbmmqrPayment } from "@/server/payments/settleCbmmqrPayment";

export const maxDuration = 10;
const GATEWAY_BUDGET_MS = 6_000;
const MAX_BODY_BYTES = 8 * 1024;
const QR_REF_PATTERN = /^[\x21-\x7E]{1,25}$/;

/**
 * CB's other callback fields (spec §3), bounded to CB's documented lengths.
 * Absent is allowed — a FAIL callback need not carry a transaction, and none
 * of these ever moves money — but present-and-malformed is a 400.
 */
const OPTIONAL_STRINGS: Record<string, number> = {
  transactionId: 35, transCurrency: 3, transDateTime: 17, transStatusCode: 4,
  institutionId: 4, institutionName: 150, merchantId: 15, remark: 140, terminalId: 8,
};

function optionalFieldsValid(fields: Record<string, unknown>): boolean {
  for (const [name, max] of Object.entries(OPTIONAL_STRINGS)) {
    const v = fields[name];
    if (v === undefined || v === null) continue;
    if (typeof v === "number" && (name === "transCurrency" || name === "transStatusCode")) continue;
    if (typeof v !== "string" || v.length > max) return false;
  }
  const amount = fields.transAmount;
  if (amount !== undefined && amount !== null) {
    const n = typeof amount === "string" ? Number(amount) : amount;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return false;
  }
  return true;
}

// ─── POST /api/webhooks/cbmmqr ──────────────────────────────────────────────
// Spec §5.3. CB authenticates the callback only with a static apiKey and signs
// nothing, so the callback is a wake-up: it names a payment, and we then ask
// CB ourselves (status check with the pinned merchant's credentials) and settle
// on THAT answer through settleCbmmqrPayment(). No callback field moves money.
//
// Replies: 200 { qrReferenceNo, returnCode: "0000", message } when there is
// nothing more CB could usefully do; 500 when a retry might succeed.

const ack = (qrReferenceNo: string) =>
  NextResponse.json({ qrReferenceNo, returnCode: "0000", message: "Success" }, { status: 200 });
const err = (status: number, error: string) => NextResponse.json({ error }, { status });

function gatewayBudget(): CallBudget | undefined {
  if (!process.env.VERCEL) return undefined;
  return { deadlineMs: Date.now() + GATEWAY_BUDGET_MS };
}

export async function POST(request: NextRequest) {
  // ── 1. Size and shape, before anything touches the database ─
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return err(400, "Bad Request");

  let fields: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return err(400, "Bad Request");
    fields = parsed as Record<string, unknown>;
  } catch {
    return err(400, "Bad Request");
  }

  const referenceNo = fields.referenceNo;
  const qrReferenceNo = fields.qrReferenceNo;
  const description = fields.transStatusDescription;
  if (
    typeof referenceNo !== "string" || !REFERENCE_PATTERN.test(referenceNo) ||
    typeof qrReferenceNo !== "string" || !QR_REF_PATTERN.test(qrReferenceNo) ||
    typeof fields.apiKey !== "string" || fields.apiKey.length === 0 || fields.apiKey.length > 150 ||
    typeof description !== "string" || description.length > 250 ||
    !optionalFieldsValid(fields)
  ) {
    return err(400, "Bad Request");
  }

  // ── 2. The payment (its pin decides which key is valid) ────
  const { data: payment, error: lookupError } = (await createAdminClient()
    .from("payments")
    .select("payment_ref, payment_method, cbmmqr_merchant, status")
    .eq("payment_ref", referenceNo)
    .eq("payment_method", "cb_mmqr")
    .maybeSingle()) as {
    data: { payment_ref: string; payment_method: string | null; cbmmqr_merchant: string | null; status: string } | null;
    error: { message: string } | null;
  };

  if (lookupError) {
    console.error(`[cbmmqr-webhook] lookup failed for ${referenceNo}: ${lookupError.message}`);
    return err(500, "Lookup Failed");
  }
  if (!payment) {
    console.warn(`[cbmmqr-webhook] no payment row for ${referenceNo}`);
    return err(404, "Not Found");
  }

  // ── 3. The pinned merchant — our config fault is a 500, not a 403 ─
  let merchant: CbMerchant;
  try {
    merchant = getCbMerchant(payment.cbmmqr_merchant);
  } catch (e) {
    console.error(`[cbmmqr-webhook] merchant config error for ${referenceNo}: ${e instanceof Error ? e.message : e}`);
    return err(500, "Configuration Error");
  }

  // ── 4. The key: exactly ONE, the pinned merchant's ─────────
  if (!apiKeyMatches(fields.apiKey, merchant.apiKey)) {
    console.warn(`[cbmmqr-webhook] invalid apiKey for ${referenceNo}`);
    return err(403, "Forbidden");
  }

  // ── 5. FAIL changes nothing: the QR may still be paid ──────
  if (description.trim().toUpperCase() !== "SUCCESS") {
    console.warn(`[cbmmqr-webhook] ${referenceNo} reported ${description.slice(0, 40)}; nothing changed`);
    return ack(qrReferenceNo);
  }

  // ── 6. Ask CB ourselves ────────────────────────────────────
  const status = await checkStatus(merchant, qrReferenceNo, gatewayBudget());
  if (status.kind !== "answer") return err(500, "Query Failed");
  if (status.code !== CB_SUCCESS) {
    console.warn(`[cbmmqr-webhook] ${referenceNo}: callback said SUCCESS, status says ${status.code}`);
    return err(500, "Not Settled");
  }

  // ── 7. Settle on the status answer ─────────────────────────
  const outcome = await settleCbmmqrPayment({ payment, merchant, status, source: "callback" });

  switch (outcome.kind) {
    case "settled":
    case "already_settled":
      return ack(qrReferenceNo);
    case "refused":
      // Logged loudly by the wrapper and left for an operator. A retry sends
      // the same facts and cannot change the answer.
      return ack(qrReferenceNo);
    default:
      console.error(`[cbmmqr-webhook] ${referenceNo} settlement retryable: ${outcome.reason}`);
      return err(500, "Retry");
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/cbmmqr-webhook-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status
git diff --stat
git add src/app/api/webhooks/cbmmqr/route.ts src/__tests__/payments/cbmmqr-webhook-route.test.ts
git commit -m "feat(cbmmqr): callback that only triggers our own status check"
```

---

### Task 11: `CbMmqrCard` — CB's WebFrame layout

**Files:**
- Create: `public/cbmmqr/myanmarpay-banner.png`, `public/cbmmqr/cb-bank-logo.png`
- Create: `src/components/payments/CbMmqrCard.tsx`
- Test: `src/__tests__/payments/cbMmqrCard.test.tsx`

`MmqrCard` is not changed. Read it first: this card uses the same technique (one SVG on a 500×725 viewBox, so it keeps its shape at any width) with CB's layout (spec §7.1).

- [ ] **Step 1: Copy CB's two images into `public/cbmmqr/`**

CB's sample is `E-commerence MMQR WebFrame.zip`, attached to CB's email of 2026-10-28 and saved by the owner in `C:\Users\yehtu\Documents\YHA\06-KuuNyi\01-Client\03-TheBeatsRun\01-Document\`. If you do not have it, ask the owner. Unzip it into a new empty folder **outside the repo**, then copy:

| From the zip | To |
|---|---|
| `images/Logo_1080px.png` (MyanmarPay banner: yellow rule, logo, wordmark) | `public/cbmmqr/myanmarpay-banner.png` |
| `images/logo.png` (CB Bank) | `public/cbmmqr/cb-bank-logo.png` |

Do not copy `index.html` or `qrSample.jpg`. Then read both images' pixel sizes:

```bash
node -e "for (const f of ['public/cbmmqr/myanmarpay-banner.png','public/cbmmqr/cb-bank-logo.png']) { const b = require('fs').readFileSync(f); console.log(f, b.readUInt32BE(16), b.readUInt32BE(20)); }"
```

Expected: two lines `<file> <width> <height>` (the banner is about 1080×288, the logo about 380×160). Put the exact numbers into `BANNER_W/BANNER_H` and `LOGO_W/LOGO_H` below.

- [ ] **Step 2: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import CbMmqrCard from "@/components/payments/CbMmqrCard";

// CB require their WebFrame sample layout (email of 2026-10-29). Coordinates
// are viewBox units on 500x725 (20:29, CB's UI guideline).

const render = (over: Partial<Parameters<typeof CbMmqrCard>[0]> = {}) =>
  renderToStaticMarkup(
    <CbMmqrCard qrImageUrl="data:image/png;base64,AAAA" receiverName="The Beats Run" amount={40000} currency="MMK" {...over} />,
  );
const attr = (svg: string, tagWith: string, name: string) => {
  const tag = svg.match(new RegExp(`<[^>]*${tagWith}[^>]*>`))?.[0] ?? "";
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
};

describe("CbMmqrCard", () => {
  it("is a 500x725 SVG that scales to its container", () => {
    const svg = render();
    expect(svg).toContain('viewBox="0 0 500 725"');
    expect(svg).toContain('data-testid="cb-mmqr-card"');
  });

  it("puts the QR at 80% of the width, centred", () => {
    const svg = render();
    expect(attr(svg, 'href="data:image/png', "width")).toBe("400");
    expect(attr(svg, 'href="data:image/png', "x")).toBe("50");
  });

  it("left-aligns receiver and amount at the 12.5% inset, amount with two decimals", () => {
    const svg = render();
    expect(svg).toMatch(/<text[^>]*x="62.5"[^>]*text-anchor="start"[^>]*>The Beats Run<\/text>/);
    expect(svg).toContain("40,000.00");
    expect(svg).toContain("MMK");
  });

  it("writes MMQR in black, not blue", () => {
    expect(render()).toMatch(/<text[^>]*fill="#000000"[^>]*>MMQR<\/text>/);
  });

  it("shows CB's logo at 20% width, centred below the QR, and no mark inside the QR", () => {
    const svg = render();
    expect(attr(svg, 'cb-bank-logo.png', "width")).toBe("100");
    expect(attr(svg, 'cb-bank-logo.png', "x")).toBe("200");
    expect(svg.match(/<image/g)).toHaveLength(3); // banner, QR, CB logo
  });

  it("has the #264EA1 bottom rule and a grey border", () => {
    const svg = render();
    expect(svg).toContain('stroke="#264EA1"');
    expect(svg).toContain('stroke="#808080"');
  });

  it("shows a placeholder while the QR is rendering", () => {
    expect(render({ qrImageUrl: null })).toContain("Rendering QR...");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/cbMmqrCard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```tsx
// ─── CB Bank MMQR card ──────────────────────────────────────────────────────
//
// CB require their "E-commerce MMQR WebFrame" layout (CB email, 2026-10-29),
// not MmqrCard's. From CB's sample page and CB's UI guideline v1.0:
//
//   card ratio        20:29 (guideline; the sample itself has no fixed ratio)
//   header            full-width MyanmarPay banner (rule + logo + wordmark)
//   receiver + amount LEFT-aligned at a 12.5% inset, amount with 2 decimals
//   separator         yellow dotted rule, full width
//   MMQR wording      centred, BLACK
//   QR                80% of width, centred
//   CB Bank logo      20% of width, centred below the QR
//   footer            solid #264EA1 rule; 1px grey border round the card
//   font              Arial (guideline) — the sample uses Calibri
//
// At an 80% QR the content only just fits 20:29, so the vertical layout below
// is its own; MmqrCard's constants do not apply. Same SVG technique as
// MmqrCard (see its header for why CSS failed twice).

const VB_W = 500;
const VB_H = VB_W * (29 / 20); // 725

// Pixel sizes of the two assets (Task 11 Step 1). Replace with the measured values.
const BANNER_W = 1080;
const BANNER_H = 288;
const LOGO_W = 380;
const LOGO_H = 160;

const INSET = VB_W * 0.125; // 62.5
const QR = VB_W * 0.8; // 400
const QR_X = (VB_W - QR) / 2; // 50
const LOGO_DRAW_W = VB_W * 0.2; // 100
const LOGO_DRAW_H = LOGO_DRAW_W * (LOGO_H / LOGO_W);
const BANNER_DRAW_H = VB_W * (BANNER_H / BANNER_W);

const NAME_SIZE = VB_H * 0.03;
const AMOUNT_SIZE = VB_H * 0.06;
const CURRENCY_SIZE = VB_H * 0.03;
const MMQR_SIZE = 30;

// Vertical rhythm, top to bottom, in viewBox units.
const NAME_BASELINE = BANNER_DRAW_H + 32;
const AMOUNT_BASELINE = NAME_BASELINE + 45;
const DOTTED_Y = AMOUNT_BASELINE + 18;
const MMQR_BASELINE = DOTTED_Y + 34;
const QR_Y = MMQR_BASELINE + 10;
const LOGO_Y = QR_Y + QR + 6;
const FOOTER_Y = VB_H - 2;

const YELLOW = "#FBD913";
const CB_BLUE = "#264EA1";
const GREY = "#808080";
const FONT = "Arial, Helvetica, sans-serif";

interface CbMmqrCardProps {
  /** Data URL of the rendered QR, or null while it is still being drawn. */
  qrImageUrl: string | null;
  /** Who receives the money — the merchant, never the payer. */
  receiverName: string;
  amount: number;
  currency: string;
  /** Widest the card may render. It shrinks freely below this. */
  maxWidth?: number;
}

export default function CbMmqrCard({ qrImageUrl, receiverName, amount, currency, maxWidth = 320 }: CbMmqrCardProps) {
  const amountText = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <svg
      data-testid="cb-mmqr-card"
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      role="img"
      aria-label={`MMQR payment code for ${amountText} ${currency} to ${receiverName}`}
      style={{ width: "100%", maxWidth, height: "auto", display: "block" }}
    >
      <rect width={VB_W} height={VB_H} fill="#ffffff" />
      <rect x={0.5} y={0.5} width={VB_W - 1} height={VB_H - 1} fill="none" stroke={GREY} strokeWidth={1} />

      <image href="/cbmmqr/myanmarpay-banner.png" x={0} y={0} width={VB_W} height={BANNER_DRAW_H} />

      <text x={INSET} y={NAME_BASELINE} textAnchor="start" fontFamily={FONT} fontSize={NAME_SIZE} letterSpacing="0" fill="#000000">
        {receiverName}
      </text>
      <text x={INSET} y={AMOUNT_BASELINE} textAnchor="start" fontFamily={FONT} fontWeight="bold" fontSize={AMOUNT_SIZE} letterSpacing="0" fill="#000000">
        {amountText}
        <tspan fontSize={CURRENCY_SIZE} fontWeight="normal" dx={10}>
          {currency}
        </tspan>
      </text>

      <line x1={0} y1={DOTTED_Y} x2={VB_W} y2={DOTTED_Y} stroke={YELLOW} strokeWidth={3} strokeDasharray="2 6" strokeLinecap="round" />

      <text x={VB_W / 2} y={MMQR_BASELINE} textAnchor="middle" fontFamily={FONT} fontSize={MMQR_SIZE} letterSpacing="0" fill="#000000">
        MMQR
      </text>

      {qrImageUrl ? (
        <image href={qrImageUrl} x={QR_X} y={QR_Y} width={QR} height={QR} />
      ) : (
        <>
          <rect x={QR_X} y={QR_Y} width={QR} height={QR} fill="none" stroke="#e5e7eb" strokeWidth={2} />
          <text x={VB_W / 2} y={QR_Y + QR / 2} textAnchor="middle" fontFamily={FONT} fontSize={NAME_SIZE} fill="#6b7280">
            Rendering QR...
          </text>
        </>
      )}

      <image href="/cbmmqr/cb-bank-logo.png" x={(VB_W - LOGO_DRAW_W) / 2} y={LOGO_Y} width={LOGO_DRAW_W} height={LOGO_DRAW_H} />

      <line x1={0} y1={FOOTER_Y} x2={VB_W} y2={FOOTER_Y} stroke={CB_BLUE} strokeWidth={4} />
    </svg>
  );
}
```

Then check the layout fits: with the measured asset sizes, `LOGO_Y + LOGO_DRAW_H` must be below `FOOTER_Y - 2`. Add this test to the file and run it:

```tsx
it("fits inside 20:29 with the measured assets", () => {
  const svg = render();
  const y = Number(attr(svg, "cb-bank-logo.png", "y"));
  const h = Number(attr(svg, "cb-bank-logo.png", "height"));
  expect(y + h).toBeLessThan(725 - 4);
});
```

If it fails, reduce the vertical gaps (`+ 32`, `+ 45`, `+ 18`, `+ 34`, `+ 10`, `+ 6`) evenly — never the QR size, which CB fixes at 80%.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/cbMmqrCard.test.tsx src/__tests__/payments/mmqrCard.test.tsx`
Expected: PASS for both (`MmqrCard` unchanged).

- [ ] **Step 6: Commit**

```bash
git status
git diff --stat
git add public/cbmmqr src/components/payments/CbMmqrCard.tsx src/__tests__/payments/cbMmqrCard.test.tsx
git commit -m "feat(cbmmqr): CB Bank MMQR card in CB's WebFrame layout"
```

---

### Task 12: Wire the provider into the modal, pages, settings and types

**Files:**
- Create: `src/lib/mmqrProvider.ts`
- Modify: `src/components/payments/QRPaymentModal.tsx`
- Modify: `src/app/(public)/enroll/[slug]/checkout/payment/page.tsx` (`:649`, `:698-701`, `:814`)
- Modify: `src/app/(public)/enroll/payment/[ref]/page.tsx` (`:58`)
- Modify: `src/app/admin/settings/page.tsx` (`:539`, `:607`, `:1399-1405`)
- Modify: `src/types/database.ts` (`:131`, and the `Payment` type)
- Test: `src/__tests__/payments/cbmmqr-provider-dispatch.test.ts`, `src/__tests__/payments/cbmmqr-modal.test.ts`

All of this lands in **one commit**: today two places send an unknown provider to MMPay (spec §4.2), so CB must be known everywhere at once.

- [ ] **Step 1: Write the failing tests**

`src/__tests__/payments/cbmmqr-provider-dispatch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normaliseMmqrProvider } from "@/lib/mmqrProvider";
import { paymentApiBase } from "@/components/payments/QRPaymentModal";

describe("cbmmqr never falls through to MMPay", () => {
  it("normaliseMmqrProvider keeps every known provider", () => {
    for (const p of ["abank", "mmpay", "kbzpay", "cbmmqr"] as const) {
      expect(normaliseMmqrProvider(p, "mmpay")).toBe(p);
    }
  });

  it("only unknown values take the caller's fallback", () => {
    expect(normaliseMmqrProvider("cb", "mmpay")).toBe("mmpay");
    expect(normaliseMmqrProvider(null, "abank")).toBe("abank");
  });

  it("the modal posts cbmmqr to the CB route", () => {
    expect(paymentApiBase("cbmmqr")).toBe("/api/public/payments/cbmmqr");
    expect(paymentApiBase("kbzpay")).toBe("/api/public/payments/kbzpay");
    expect(paymentApiBase("abank")).toBe("/api/public/payments/abank");
    expect(paymentApiBase("paypay")).toBe("/api/public/payments/paypay");
    expect(paymentApiBase("mmpay")).toBe("/api/public/payments/mmpay");
  });
});
```

`src/__tests__/payments/cbmmqr-modal.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { interpretCreateResponse, qrCountdown } from "@/components/payments/QRPaymentModal";

describe("interpretCreateResponse with expiresAt", () => {
  it("carries CB's expiresAt through", () => {
    expect(interpretCreateResponse({ status: "created", qr: "000201QR", orderId: "CBREF", expiresAt: "2026-10-31T04:03:00.000Z" }))
      .toEqual({ kind: "qr", qrSource: "000201QR", orderId: "CBREF", expiresAt: "2026-10-31T04:03:00.000Z" });
  });
  it("leaves other providers unchanged (no expiresAt)", () => {
    expect(interpretCreateResponse({ qr: "000201QR", orderId: "X" })).toEqual({ kind: "qr", qrSource: "000201QR", orderId: "X" });
  });
});

describe("qrCountdown", () => {
  const now = Date.parse("2026-10-31T04:00:00Z");
  it("m:ss while time remains", () => {
    expect(qrCountdown(now + 125_000, now)).toEqual({ expired: false, label: "2:05" });
  });
  it("expired at or after the expiry", () => {
    expect(qrCountdown(now, now)).toEqual({ expired: true, label: null });
  });
  it("no countdown without an expiry", () => {
    expect(qrCountdown(null, now)).toEqual({ expired: false, label: null });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/__tests__/payments/cbmmqr-provider-dispatch.test.ts src/__tests__/payments/cbmmqr-modal.test.ts`
Expected: FAIL — `@/lib/mmqrProvider` not found, `paymentApiBase` / `qrCountdown` not exported.

- [ ] **Step 3: Create `src/lib/mmqrProvider.ts`**

```ts
// The MMQR providers a tenant can choose (tenants.mmqr_provider). One list, so
// a new provider cannot be known in one place and silently become MMPay in
// another (CB spec §4.2).

export type MmqrProvider = "abank" | "mmpay" | "kbzpay" | "cbmmqr";

const KNOWN: ReadonlySet<string> = new Set<MmqrProvider>(["abank", "mmpay", "kbzpay", "cbmmqr"]);

/** A known provider as is; anything else becomes the caller's fallback. */
export function normaliseMmqrProvider(value: unknown, fallback: MmqrProvider): MmqrProvider {
  return typeof value === "string" && KNOWN.has(value) ? (value as MmqrProvider) : fallback;
}
```

- [ ] **Step 4: Modify `QRPaymentModal.tsx`**

1. Imports: add `import CbMmqrCard from "@/components/payments/CbMmqrCard";`.
2. `type QRProvider = "mmpay" | "abank" | "paypay" | "kbzpay" | "cbmmqr";`
3. Replace the inline `apiBase` ternary with an exported function, and use it:

```ts
/** The create/status route for a provider. Exported for the dispatch test. */
export function paymentApiBase(provider: QRProvider): string {
  switch (provider) {
    case "abank": return "/api/public/payments/abank";
    case "paypay": return "/api/public/payments/paypay";
    case "kbzpay": return "/api/public/payments/kbzpay";
    case "cbmmqr": return "/api/public/payments/cbmmqr";
    default: return "/api/public/payments/mmpay";
  }
}
```

and inside the component: `const apiBase = paymentApiBase(provider);`. `providerLogoUrl` stays `provider === "kbzpay" ? "/kbzpay-logo.png" : null` — CB has no centre mark.

4. `CreateResponse` and `interpretCreateResponse` gain an optional expiry:

```ts
export type CreateResponse =
  | { kind: "already_paid" }
  | { kind: "qr"; qrSource: string; orderId: string; expiresAt?: string };

export function interpretCreateResponse(data: {
  status?: string; qr?: string; url?: string; orderId?: string; expiresAt?: string;
}): CreateResponse | null {
  if (data?.status === "already_paid") return { kind: "already_paid" };
  const qrSource = data?.qr ?? data?.url;
  if (!qrSource || !data?.orderId) return null;
  return typeof data.expiresAt === "string"
    ? { kind: "qr", qrSource, orderId: data.orderId, expiresAt: data.expiresAt }
    : { kind: "qr", qrSource, orderId: data.orderId };
}

/** Countdown under a CB card. Pure, for tests; the component ticks `now`. */
export function qrCountdown(expiresAtMs: number | null, nowMs: number): { expired: boolean; label: string | null } {
  if (expiresAtMs === null) return { expired: false, label: null };
  const left = Math.ceil((expiresAtMs - nowMs) / 1000);
  if (left <= 0) return { expired: true, label: null };
  return { expired: false, label: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` };
}
```

5. State and ticking clock, beside the other `useState` calls:

```ts
const [qrExpiresAtMs, setQrExpiresAtMs] = useState<number | null>(null);
const [nowMs, setNowMs] = useState(() => Date.now());

const cbQrExpired = qrCountdown(qrExpiresAtMs, nowMs).expired;
useEffect(() => {
  if (provider !== "cbmmqr" || state !== "qr" || qrExpiresAtMs === null || cbQrExpired) return;
  const id = setInterval(() => setNowMs(Date.now()), 1000);
  return () => clearInterval(id);
}, [provider, state, qrExpiresAtMs, cbQrExpired]); // stops once expired (review fix)
```

6. In **both** places that handle a `kind: "qr"` response (the mount effect and `handleRetry`), right after `setOrderId(interpreted.orderId);` add:

```ts
const now = Date.now();
setQrExpiresAtMs(localExpiryMs(interpreted.expiresAt, interpreted.serverNow, now));
setNowMs(now);
```

(Review fix.) The CB create route also returns `serverNow`; `interpretCreateResponse` passes it through, and the exported pure `localExpiryMs(expiresAt, serverNow, nowMs)` returns `nowMs + (expiresAt - serverNow)`, the raw expiry when `serverNow` is missing, and `null` when `expiresAt` does not parse. The countdown is then right on a phone whose clock is off.

7. In the QR state's render, add a CB branch **before** the generic MMQR branch (`qrImageUrl || qrData ? <MmqrCard …`):

```tsx
) : provider === "cbmmqr" && (qrImageUrl || qrData) ? (
  (() => {
    const countdown = qrCountdown(qrExpiresAtMs, nowMs);
    if (countdown.expired) {
      // Spec §5.4 / §7.2: the QR is hidden, but polling continues — a payment
      // made just before expiry still turns into SUCCESS. A new QR goes
      // through the create route, which may answer "previous QR still active".
      return (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-6 text-center">
          <p className="text-sm text-amber-800">This QR has expired. If you already paid, we are still confirming it.</p>
          <button type="button" onClick={handleRetry}
            className="mt-3 rounded-lg bg-[#264EA1] px-4 py-2 text-sm font-medium text-white">
            Get a new QR
          </button>
        </div>
      );
    }
    return (
      <>
        <CbMmqrCard qrImageUrl={qrImageUrl} receiverName={receiverName} amount={amount} currency={currency} />
        {countdown.label && (
          <p className="mt-2 text-xs text-gray-600">QR will expire in {countdown.label}</p>
        )}
        <p className="mt-1 text-xs text-gray-500">{studentName}</p>
      </>
    );
  })()
```

The existing "Save QR" button below stays as it is; hide it when the CB QR has expired by changing its condition from `{qrImageUrl && (` to `{qrImageUrl && !(provider === "cbmmqr" && qrCountdown(qrExpiresAtMs, nowMs).expired) && (`.

8. **Stop every poll timer before a retry** (plan review #4). Today `handleRetry` clears only `pollRef`, so the old QR's `slowTimerRef` and `pollTimerRef` survive: the 2-minute one replaces the new QR's poller, and the 10-minute one forces the modal into "QR code has expired" for the new QR. Add one helper and use it everywhere a poller is stopped:

```ts
const stopPolling = useCallback(() => {
  if (pollRef.current) clearInterval(pollRef.current);
  if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
  pollRef.current = null;
  pollTimerRef.current = null;
  slowTimerRef.current = null;
}, []);
```

- `handleRetry`: do **not** stop the old poller up front (remove its `if (pollRef.current) clearInterval(pollRef.current);`). The new QR's `startPolling()` stops it. In `handleRetry`'s failure branches (`!res.ok`, `!interpreted`, catch): for `cbmmqr` leave the old poller running, so a late payment on the old QR still turns into SUCCESS (spec §7.2); for every other provider call `stopPolling()` there. Once the payment is known paid (`paidRef`), an in-flight retry does nothing.
- Generation counter: `startPolling` increments `pollGenRef` after `stopPolling()`; `pollFn` captures its generation and ignores any result once it no longer matches, so a status request from an old poller never touches a new QR.
- Call `stopPolling()` as the first line inside `startPolling`'s callback, before `pollRef.current = setInterval(...)`, so a new poller never runs beside an old one.
- Replace the three-line clears in the `SUCCESS` / `FAILED` branches of `pollFn` and in the unmount cleanup with `stopPolling()`.

This project has no DOM test environment (component tests use `renderToStaticMarkup`, which runs no effects), so this is verified by reading the diff and in UAT (Task 15 Step 3, item 8).

- [ ] **Step 5: Modify the pages, settings and types**

`src/app/(public)/enroll/[slug]/checkout/payment/page.tsx`:

```ts
import { normaliseMmqrProvider, type MmqrProvider } from "@/lib/mmqrProvider";
// :649
const [mmqrProvider, setMmqrProvider] = useState<MmqrProvider>("mmpay");
// :698-701 — replace the ternary
setMmqrProvider(normaliseMmqrProvider(d.mmqr_provider, "mmpay"));
// :814
provider={qrProvider as MmqrProvider | "paypay"}
```

`src/app/(public)/enroll/payment/[ref]/page.tsx:58`: `mmqr_provider?: MmqrProvider;` (import the type). Its `:1587` fallback becomes `normaliseMmqrProvider(enrollment.mmqr_provider, "abank")` (review fix), so an unknown value still falls back to ABank.

`src/app/admin/settings/page.tsx`: the three `"abank" | "mmpay" | "kbzpay"` unions (`:539`, `:607`, `:1399`) become `MmqrProvider`, and after the KBZPay `<option>` add:

```tsx
<option value="cbmmqr">CB Bank (MMQR &mdash; any Myanmar bank app)</option>
```

`src/types/database.ts:131`: `mmqr_provider: "abank" | "mmpay" | "kbzpay" | "cbmmqr";` (it never gained `kbzpay`; fix both). In the `Payment` type, next to `kbzpay_merchant`, add `cbmmqr_merchant: string | null;` and `provider_order_ref: string | null;`.

Then search for anything still listing providers:

```bash
grep -rn '"abank" | "mmpay"' src --include=*.ts --include=*.tsx
```

Expected: no line that lacks `cbmmqr` (or that should use `MmqrProvider`). Fix any found.

- [ ] **Step 6: Run the tests, type-check, lint**

```bash
npx vitest run src/__tests__/payments/cbmmqr-provider-dispatch.test.ts src/__tests__/payments/cbmmqr-modal.test.ts src/__tests__/payments/kbzpay-modal.test.ts
npx tsc --noEmit
npm run lint
```

Expected: all three exit 0. `kbzpay-modal.test.ts` must still pass unchanged.

- [ ] **Step 7: Commit**

```bash
git status
git diff
git add src/lib/mmqrProvider.ts src/components/payments/QRPaymentModal.tsx "src/app/(public)/enroll/[slug]/checkout/payment/page.tsx" "src/app/(public)/enroll/payment/[ref]/page.tsx" src/app/admin/settings/page.tsx src/types/database.ts src/__tests__/payments/cbmmqr-provider-dispatch.test.ts src/__tests__/payments/cbmmqr-modal.test.ts
git commit -m "feat(cbmmqr): offer CB Bank MMQR in settings, checkout and the payment modal"
```

---

### Task 13: Docs, env example, spec alignment, full verification, PR

**Files:**
- Modify: `.env.local.example`
- Modify: `docs/superpowers/specs/2026-10-31-cb-mmqr-integration-design.md`
- Modify: `docs/clients/beatsrun.md` (only if PR #325 is merged into `dev`; otherwise note it in the PR body)

- [ ] **Step 1: Document the variables in `.env.local.example`**

Append, matching the KBZPay block's style:

```bash
# ── CB Bank MMQR (spec docs/superpowers/specs/2026-10-31-cb-mmqr-integration-design.md §6)
# Per deployment:
CBMMQR_MODE=uat                 # "production" required on VERCEL_ENV=production, and only there
CBMMQR_BASE_URL=                # CB's gateway URL for this mode (CB will send it)
CBMMQR_PROXY_URL=               # optional fixed-IP egress; unset for UAT (office IP)
CBMMQR_UTC_OFFSET=+06:30        # zone of CB's timestamps (gate G2)
# Per merchant, <ID> = ^[A-Z][A-Z0-9_]{1,31}$ (BeatsRun: YOUNGMONEY). No fallback between merchants.
CBMMQR_YOUNGMONEY_USER_ID=
CBMMQR_YOUNGMONEY_PASSWORD=     # secret
CBMMQR_YOUNGMONEY_SOURCE_ID=
CBMMQR_YOUNGMONEY_MERCHANT_ID=
CBMMQR_YOUNGMONEY_TERMINAL_ID=
CBMMQR_YOUNGMONEY_API_KEY=      # secret; CB sends it on callbacks
# The callback URL is registered with CB out of band; CB's API takes none per request.
```

- [ ] **Step 2: Re-check the spec against what was built**

The spec was aligned with this plan before implementation. Read §4.3, §5.2–§5.4 and §6 against the code you wrote; if anything differs because a task changed during implementation, update the spec in this commit and say why in the PR body.

- [ ] **Step 3: Client notes**

If `docs/clients/beatsrun.md` on `dev` already has the CB section from PR #325, add under it:

```markdown
  - Code: built to the dev DB only (PR #<this PR>). Env vars `CBMMQR_YOUNGMONEY_*` (see
    `.env.local.example`). The tenant is assigned in `cbmmqr_merchant_assignments`
    (`beatsrun` → `YOUNGMONEY`, seeded by the migration); switching the tenant to CB means
    `tenants.mmqr_provider = 'cbmmqr'` with `payment_mode = 'mmqr'`.
```

If #325 is not merged yet, do not edit the file; say so in the PR body instead.

- [ ] **Step 4: Full verification — judge each by exit code**

Stop `npm run dev` first if it is running.

```bash
npm test
npm run test:db
npx tsc --noEmit
npm run lint
npm run build
```

Expected: every command exits 0. Record each exit code in the PR body. If any fails, fix the cause; do not skip.

- [ ] **Step 5: Commit, push, open the PR to `dev`**

```bash
git status
git diff
git add .env.local.example docs/superpowers/specs/2026-10-31-cb-mmqr-integration-design.md docs/clients/beatsrun.md
git commit -m "docs(cbmmqr): env example and spec aligned with the implementation"
git fetch origin
git rebase origin/dev
git push -u origin feature/cb-mmqr
gh pr create --base dev --title "feat(cbmmqr): CB Bank MMQR for BeatsRun" --body-file <prepared body>
```

The PR body lists: what was built; the verification commands with exit codes; that the migration is **not** applied anywhere yet; gates G1–G6 still open; and the owner steps in Tasks 14–15. Never merge it yourself.

---

### Task 14: Apply the migration to the DEV database (owner approval required)

Staging reads the **dev** database. Applying this migration changes staging's schema too; it adds columns, a table, indexes and functions and alters no existing row.

- [ ] **Step 1: Confirm the CLI is linked to dev, and only dev**

```bash
npx supabase projects list
```

Expected: the linked project (marked) is `fnfvwzwrdsnmwxunciti`. If it is anything else, **stop** — never link to `nhxmumcvgnxlczjsgctz` (production) or `kbiszegobsbelzbyyfvo`.

- [ ] **Step 2: Show the owner exactly what will run**

```bash
npx supabase db push --dry-run
```

Expected: exactly one pending migration, `20261031120000_cbmmqr.sql`. Show the owner that list and the SQL file, and wait for an explicit yes.

- [ ] **Step 3: Apply, after the owner's yes**

```bash
npx supabase db push
```

Expected: exit code 0.

- [ ] **Step 4: Verify on dev (read-only queries)**

```sql
SELECT tenant_id, merchant_id FROM public.cbmmqr_merchant_assignments;
SELECT count(*) FROM public.payments WHERE payment_method = 'cb_mmqr';
SELECT proname FROM pg_proc WHERE proname LIKE '%cbmmqr%' ORDER BY 1;
```

```sql
SELECT has_table_privilege('anon','public.cbmmqr_merchant_assignments','SELECT'),
       has_table_privilege('authenticated','public.cbmmqr_merchant_assignments','SELECT');
```

Expected: one row (`beatsrun` → `YOUNGMONEY`) if the dev DB has a `beatsrun` tenant, otherwise none (the migration logged a NOTICE); `0` CB payments; `bind_cbmmqr_settlement`, `claim_cbmmqr_order_slot`, `complete_cbmmqr_replace`, `protect_payment_cbmmqr_fields`, `store_cbmmqr_qr`; and `false, false` for the privilege check. The local test setup grants every table to `anon` and `authenticated`, so the migration's `REVOKE` on `cbmmqr_merchant_assignments` is only provable on a hosted DB.

Production gets nothing from this plan (spec §10, gate G6).

---

### Task 15: UAT on the office IP behind the tunnel (owner runs, Claude assists)

Blocked until CB sends UAT credentials and the gateway URL, which they do only after receiving the office IP and the tunnel callback URL.

- [ ] **Step 1: Owner prepares**

- Tunnel: a Cloudflare tunnel to `localhost:3005` on a host the owner picks (as `kbz-uat.kuunyi.com` for KBZPay). Pass `--config` explicitly; the default `config.yml` points at another tunnel.
- CB has the office IP and `https://<tunnel host>/api/webhooks/cbmmqr`.
- `.env.local` holds `CBMMQR_MODE=uat`, `CBMMQR_BASE_URL`, and the `CBMMQR_YOUNGMONEY_*` values from CB (set by the owner; never printed).
- A BeatsRun test item of **at least 1,000 MMK** on the dev DB.

- [ ] **Step 2: Point BeatsRun at CB on the dev DB — owner decides**

```sql
UPDATE public.tenants SET payment_mode = 'mmqr', mmqr_provider = 'cbmmqr' WHERE subdomain = 'beatsrun';
```

Staging reads the dev DB, so this also switches BeatsRun's checkout on **staging**. Record the previous values first and restore them after UAT.

- [ ] **Step 3: Check, in this order, and record each answer in `docs/clients/beatsrun.md`**

1. A QR is created; `transCurrency` as the string `"104"` is accepted (if not, change `createDynamicQr` to send the number 104).
2. `qrExpiredDateTime` read with `+06:30` matches the countdown CB's sample shows (G2).
3. Paying with a test wallet produces a callback through the tunnel; the reply `{ qrReferenceNo, returnCode: "0000", message }` is accepted (CB stops retrying).
4. The status-check success response contains `referenceNo`, `merchantId`, `transactionId`, `transCurrency` and `transAmount` as `settleCbmmqrPayment` requires. If any is missing, **stop** and report — do not loosen the wrapper.
5. Payment becomes `verified`, the enrollment `confirmed`, the ticket issued.
6. A QR left unpaid past its expiry: record the exact status-check `returnCode` and `message`. This is the evidence for G1; do **not** add it to `CB_CONFIRMED_DEAD_CODES` until CB confirms in writing that it is final.
7. An amount below 1,000 returns 422 without calling CB.
8. Let a CB QR expire in the modal, press "Get a new QR", and leave the new QR open for over 10 minutes: it must not switch to "QR code has expired" because of the old QR's timers (Task 12 step 8).
9. Compare CB's `qrIssuedDateTime` with our server clock to confirm `CBMMQR_UTC_OFFSET` (`+06:30`) before trusting any expiry (G2). A wrong offset shifts every expiry by hours.
10. Does a new `/auth/token` invalidate earlier tokens? If so, per-instance token caches on Vercel invalidate each other, and each call gets only one `0012`/`0017` retry. Also ask CB (spec §11, question 9).
11. `purposeOfTransaction` is truncated to 25 UTF-16 units. Check CB's limit (characters or bytes) with a Burmese enrollment ref, if refs can contain Burmese.
12. Is the callback's `qrReferenceNo` byte-identical to the one `/dynamicqr` returned? The callback is refused with 403 when it differs (spec §11, question 8).

- [ ] **Step 4: Restore the tenant settings recorded in Step 2.**

---

## Operator notes (for the PR body and whoever runs CB payments)

- **Amount mismatch after bind.** A CB status answer whose amount does not match the payment snapshot is refused *after* `bind_cbmmqr_settlement` has committed `bank_reference`. `complete_cbmmqr_replace` then answers `settling` for that enrollment, so the buyer cannot get a new CB QR until an operator resolves it (refund or manual verify). The only signal is the `[cbmmqr-settle] refused` log line. **Alert on it.**
- **Log prefix.** `settleMmqrPayment` logs with a `[kbzpay-settle]` prefix for CB payments too (shared code, unchanged by design). Do not read those lines as KBZPay-only.
- **Partial-payment remainder (inherited from KBZPay, not changed here).** `computeOrderTotal` adds the platform fee, then the latest payment's `received_amount` is subtracted. With a non-zero fee the remainder may charge the fee again, and the "latest payment" may be a retired attempt with no `received_amount`. The KBZPay route behaves the same. Worth a shared fix and tests, as a separate change.

---

## Done when

- Tasks 1–13 are committed on `feature/cb-mmqr` and the PR to `dev` is open, with `npm test`, `npm run test:db`, `npx tsc --noEmit`, `npm run lint` and `npm run build` all exiting 0.
- No KBZPay, ABank or MMPay behaviour changed: their suites pass unchanged.
- The migration is on the dev DB only after the owner's yes (Task 14). Production has neither the migration nor the code.
- Gates G1–G6 remain open and are listed in the PR. `CB_CONFIRMED_DEAD_CODES` is empty.
