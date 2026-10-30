# KBZPay Per-Tenant Merchants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each KBZPay tenant use its own KBZPay merchant, so Sky Festival's buyers pay into Sky Festival's account and never Brave's.

**Architecture:** Credentials move from one global env-var set to one named set per merchant (`KBZPAY_<ID>_*`). A `service_role`-only table maps tenant → merchant. The order-creation RPCs pin the merchant on each `payments` row, and a trigger makes the pin immutable. Every later call for that order (precreate, queryorder, closeorder, callback signature check) uses the pinned merchant, resolved by one fail-closed function, `getKbzMerchant()`.

**Tech Stack:** Next.js 14 route handlers, TypeScript, Supabase Postgres (plpgsql, RLS), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-30-kbzpay-per-tenant-merchants-design.md` (PR #327). Read it first; section numbers below (§) refer to it.

---

## Ground rules for whoever executes this

- Work on a branch off `origin/dev`: `git fetch origin && git switch -c feature/kbzpay-per-tenant-merchants origin/dev`. Before the first commit, `git config user.email` must print `yehtutaung.yha@gmail.com`; if it doesn't, stop.
- Show `git status` and `git diff` before every commit.
- **Never** run `supabase db push`, `supabase db reset`, or `supabase link` to anything other than `fnfvwzwrdsnmwxunciti` (dev). Task 9 applies the migration to the **dev** DB, and only after the owner says yes. Production is off limits.
- Never print a real `KBZPAY_*` value. Refer to variables by name.
- Judge tests, `tsc` and builds by **exit code**.
- Don't run `npm run build` while `npm run dev` is running; that corrupts `.next`.
- The repo is public. Commit messages describe the behaviour, never an exploit recipe.

## File map

| File | Change | Responsibility |
|---|---|---|
| `supabase/migrations/20261030120000_kbzpay_per_tenant_merchants.sql` | Create | Assignments table, pin column + backfill + CHECK, immutability trigger, both RPCs recreated |
| `src/lib/kbzpay.ts` | Modify | `KbzMerchant`, `getKbzMerchant()`; `call`/`precreate`/`queryOrder`/`closeOrder` take a merchant; global `APPID/MERCH_CODE/APP_KEY` removed |
| `src/server/payments/resolveKbzpayOrder.ts` | Modify | Takes the old order's pinned merchant |
| `src/app/api/public/payments/kbzpay/status/route.ts` | Modify | Filters on method, resolves pinned merchant, `PENDING` on config error |
| `src/app/api/webhooks/kbzmmqr/route.ts` | Modify | Look up first, then verify with the pinned merchant's key + `merch_code` |
| `src/app/api/public/payments/kbzpay/route.ts` | Modify | Resolve merchant after every claim; `503` on `no_merchant` / config error; per-merchant notify origin; `notifyOrigin()` removed |
| `src/types/database.ts` | Modify | `Payment.kbzpay_merchant` |
| `src/__tests__/db/kbzpay-order-slot.db.test.ts` | Modify | RPC suite: assignments, pinned seeds, merchant outcomes, trigger + CHECK |
| `src/__tests__/payments/kbzpay-merchant.test.ts` | Create | `getKbzMerchant` unit tests |
| `src/__tests__/payments/kbzpay-client.test.ts` | Modify | New call signatures; two merchants sign differently |
| `src/__tests__/payments/kbzpay-resolve.test.ts` | Modify | Merchant passed through |
| `src/__tests__/payments/kbzpay-status-route.test.ts` | Modify | Method filter, pinned merchant, config error |
| `src/__tests__/payments/kbzpay-webhook-route.test.ts` | Modify | Wrong-merchant key 403, `merch_code` mismatch 403, config 500 |
| `src/__tests__/payments/kbzpay-create-route.test.ts` | Modify | Notify-origin suite rewritten; `no_merchant`, reuse-with-bad-config, supersede merchant |
| `.env.local.example` | Modify | Document `KBZPAY_<ID>_*`; drop unprefixed vars |
| `docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md` | Modify | §9 points at the new contract |
| `docs/clients/brave.md` | Modify | Env var names for Brave |

---

### Task 1: Migration

**Files:**
- Create: `supabase/migrations/20261030120000_kbzpay_per_tenant_merchants.sql`

The RPC bodies below are the current definitions from `supabase/migrations/20260903090000_payments_platform_fee.sql` (lines 81–281) with only the marked changes. Copy the long explanatory comments from that file into the new one unchanged; they are omitted here for length and marked `-- (comment unchanged from 20260903090000)`.

- [ ] **Step 1: Confirm the tenant key column**

Run: `grep -n "subdomain" supabase/migrations/000_combined_schema.sql | head -3`
Expected: `tenants.subdomain varchar NOT NULL UNIQUE` (line ~51). There is no `slug` column on `tenants`; the app resolves a tenant with `.eq("subdomain", slug)` (`src/lib/api.ts`). Brave's subdomain is `brave`.

- [ ] **Step 2: Write the migration**

```sql
-- ─── KBZPay per-tenant merchants ─────────────────────────────────────────────
-- Spec: docs/superpowers/specs/2026-10-30-kbzpay-per-tenant-merchants-design.md
--
-- Order is load-bearing (§4.2): column → backfill → CHECK → trigger. With the
-- immutability trigger in place first, the backfill (NULL → 'BRAVE') would be
-- rejected and this migration would abort.

-- ── 1. Tenant → merchant mapping (§4.1) ─────────────────────────────────────
-- Not a tenants column: tenant owners can update their own tenant row, and the
-- mapping is the operator's alone.
CREATE TABLE public.kbzpay_merchant_assignments (
  tenant_id   uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE RESTRICT,
  merchant_id text NOT NULL CHECK (merchant_id ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Keeps updated_at truthful when the operator reassigns a tenant (same trigger as tenant_bots).
CREATE TRIGGER kbzpay_merchant_assignments_updated_at
  BEFORE UPDATE ON public.kbzpay_merchant_assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.kbzpay_merchant_assignments ENABLE ROW LEVEL SECURITY;
-- No policies: anon and authenticated can neither read nor write.
REVOKE ALL ON public.kbzpay_merchant_assignments FROM public, anon, authenticated;

INSERT INTO public.kbzpay_merchant_assignments (tenant_id, merchant_id)
SELECT id, 'BRAVE' FROM public.tenants WHERE subdomain = 'brave'
ON CONFLICT (tenant_id) DO NOTHING;

-- ── 2. Pin column, backfill, CHECK (§4.2) ───────────────────────────────────
ALTER TABLE public.payments ADD COLUMN kbzpay_merchant text;

COMMENT ON COLUMN public.payments.kbzpay_merchant IS
  'KBZPay merchant id (KBZPAY_<ID>_*) that created this order. Written once at insert by claim_kbzpay_order_slot / complete_kbzpay_supersede; immutable (trg_protect_payment_kbzpay_merchant). NULL for every other payment method.';

-- Only Brave has ever used KBZPay. Backfill Brave's rows by tenant, not every
-- KBZPay row: if any other tenant had KBZPay rows, the CHECK below fails and
-- the migration aborts, instead of silently attributing them to Brave.
UPDATE public.payments p
   SET kbzpay_merchant = 'BRAVE'
  FROM public.tenants t
 WHERE p.tenant_id = t.id
   AND t.subdomain = 'brave'
   AND p.payment_method = 'kbzpay_mmqr'
   AND p.kbzpay_merchant IS NULL;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_kbzpay_merchant_required
  -- Both directions, null-safe (payment_method is nullable): a KBZPay row must
  -- carry a pin, and no other row may. That also stops a pinned KBZPay row
  -- from being re-labelled as another method while keeping its pin.
  CHECK ((payment_method IS NOT DISTINCT FROM 'kbzpay_mmqr') = (kbzpay_merchant IS NOT NULL));

-- ── 3. Immutability trigger (§4.2) ──────────────────────────────────────────
-- SECURITY INVOKER, like protect_internal_test_fields(). Inside the
-- SECURITY DEFINER RPCs it runs as their owner and can read the assignments
-- table; a direct PostgREST insert carrying a pin fails on the revoked table.
CREATE OR REPLACE FUNCTION public.protect_payment_kbzpay_merchant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_assigned text;
BEGIN
  IF tg_op = 'UPDATE' THEN
    IF new.kbzpay_merchant IS DISTINCT FROM old.kbzpay_merchant THEN
      RAISE EXCEPTION 'payments.kbzpay_merchant is immutable' USING errcode = '42501';
    END IF;
    RETURN new;
  END IF;

  IF new.kbzpay_merchant IS NOT NULL THEN
    SELECT a.merchant_id INTO v_assigned
      FROM public.kbzpay_merchant_assignments a
     WHERE a.tenant_id = new.tenant_id;

    IF v_assigned IS DISTINCT FROM new.kbzpay_merchant THEN
      RAISE EXCEPTION 'kbzpay_merchant does not match the tenant assignment' USING errcode = '42501';
    END IF;
  END IF;

  RETURN new;
END;
$$;

CREATE TRIGGER trg_protect_payment_kbzpay_merchant
  BEFORE INSERT OR UPDATE OF kbzpay_merchant ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.protect_payment_kbzpay_merchant();

-- ── 4. claim_kbzpay_order_slot (§4.3) ───────────────────────────────────────
-- Return type gains `merchant`. CREATE OR REPLACE cannot change a return type,
-- so drop first. Argument list unchanged.
DROP FUNCTION IF EXISTS public.claim_kbzpay_order_slot(uuid, uuid, text, integer, timestamptz, integer);

CREATE FUNCTION public.claim_kbzpay_order_slot(
  p_enrollment_id uuid,
  p_tenant_id     uuid,
  p_payment_ref   text,
  p_amount        integer,
  p_expires_at    timestamptz,
  p_platform_fee  integer DEFAULT 0
)
RETURNS TABLE (outcome text, payment_id uuid, ref text, qr text, merchant text)
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
  -- (comment unchanged from 20260903090000)
  SELECT e.tenant_id INTO v_tenant
    FROM public.enrollments e
   WHERE e.id        = p_enrollment_id
     AND e.tenant_id = p_tenant_id
     AND e.status IN ('pending_payment', 'partial_payment')
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_enrollment'::text, NULL::uuid, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO v_live
    FROM public.payments
   WHERE enrollment_id  = p_enrollment_id
     AND payment_method = 'kbzpay_mmqr'
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
      RETURN QUERY SELECT 'reuse'::text, v_live.id, v_live.payment_ref, v_live.provider_qr, v_live.kbzpay_merchant;
    ELSE
      RETURN QUERY SELECT 'unresolved'::text, v_live.id, v_live.payment_ref, NULL::text, v_live.kbzpay_merchant;
    END IF;
    RETURN;
  END IF;

  -- No assignment → no new order. Checked only on the insert path (§4.3).
  SELECT a.merchant_id INTO v_merchant
    FROM public.kbzpay_merchant_assignments a
   WHERE a.tenant_id = v_tenant;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_merchant'::text, NULL::uuid, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- (comment unchanged from 20260903090000)
  INSERT INTO public.payments (
    enrollment_id, tenant_id, amount, platform_fee, payment_ref, payment_method,
    mmqr_status, status, provider_order_expires_at, kbzpay_merchant
  ) VALUES (
    p_enrollment_id, v_tenant, p_amount, p_platform_fee, p_payment_ref, 'kbzpay_mmqr',
    'PENDING', 'awaiting_payment', p_expires_at, v_merchant
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'created'::text, v_new_id, p_payment_ref, NULL::text, v_merchant;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_kbzpay_order_slot(uuid, uuid, text, integer, timestamptz, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_kbzpay_order_slot(uuid, uuid, text, integer, timestamptz, integer)
  TO service_role;

-- ── 5. complete_kbzpay_supersede (§4.3) ─────────────────────────────────────
DROP FUNCTION IF EXISTS public.complete_kbzpay_supersede(uuid, uuid, text, text, text, integer, timestamptz, integer);

CREATE FUNCTION public.complete_kbzpay_supersede(
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
  IF p_reason NOT IN ('FAILED', 'EXPIRED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'invalid reason: %', p_reason;
  END IF;

  -- (comment unchanged from 20260903090000)
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

  SELECT * INTO v_old
    FROM public.payments
   WHERE enrollment_id  = p_enrollment_id
     AND payment_ref    = p_expected_old_ref
     AND payment_method = 'kbzpay_mmqr'
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- (comment unchanged from 20260903090000)
  IF v_old.status = 'verified' THEN
    RETURN QUERY SELECT 'already_settled'::text, v_old.id, NULL::text;
    RETURN;
  END IF;

  -- (comment unchanged from 20260903090000)
  IF v_old.mmqr_status IS DISTINCT FROM 'PENDING' THEN
    RETURN QUERY SELECT 'not_live'::text, v_old.id, NULL::text;
    RETURN;
  END IF;

  -- (comment unchanged from 20260903090000)
  IF v_enrollment_status NOT IN ('pending_payment', 'partial_payment') THEN
    RETURN QUERY SELECT 'invalid_enrollment'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- Before the write below, so no_merchant changes nothing (§4.3).
  SELECT a.merchant_id INTO v_merchant
    FROM public.kbzpay_merchant_assignments a
   WHERE a.tenant_id = v_tenant;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_merchant'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  UPDATE public.payments
     SET mmqr_status = p_reason
   WHERE id = v_old.id;

  INSERT INTO public.payments (
    enrollment_id, tenant_id, amount, platform_fee, payment_ref, payment_method,
    mmqr_status, status, provider_order_expires_at, kbzpay_merchant
  ) VALUES (
    p_enrollment_id, v_tenant, p_amount, p_platform_fee, p_new_ref, 'kbzpay_mmqr',
    'PENDING', 'awaiting_payment', p_expires_at, v_merchant
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'replaced'::text, v_new_id, v_merchant;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_kbzpay_supersede(uuid, uuid, text, text, text, integer, timestamptz, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_kbzpay_supersede(uuid, uuid, text, text, text, integer, timestamptz, integer)
  TO service_role;
```

- [ ] **Step 3: Check the comments were carried over**

Run: `grep -c "comment unchanged" supabase/migrations/20261030120000_kbzpay_per_tenant_merchants.sql`
Expected: `0`. Every placeholder has been replaced with the real comment from `20260903090000`.

- [ ] **Step 4: Prove it applies, on the LOCAL database only**

`scripts/migration-gate.mjs` is hard-wired to `127.0.0.1:54322`, applies exactly one migration inside a rolled-back transaction, and runs catalog assertions. It cannot reach dev or production.

Run: `npx supabase status` (the local stack must be running; if it isn't, ask the owner before `npx supabase start`), then
`node scripts/migration-gate.mjs supabase/migrations/20261030120000_kbzpay_per_tenant_merchants.sql`
Expected: exit code 0. A parse error, an unknown column (for example `slug`), or a failed CHECK shows up here, not on dev. The gate also runs fixed Stripe catalog assertions (`payments_*_stripe_chk`, exactly one `finalize_stripe_payment_attempt`). A failure naming **those** objects means the local stack is behind `origin/dev`, not that this migration is broken. Bring the local DB up to date (ask before any reset) and re-run.

- [ ] **Step 5: Commit (not applied to any remote database)**

```bash
git status
git add supabase/migrations/20261030120000_kbzpay_per_tenant_merchants.sql
git diff --cached
git commit -m "feat(kbzpay): migration for per-tenant merchants"
```

---

### Task 1b: Update the RPC database tests (local DB)

**Files:**
- Modify: `src/__tests__/db/kbzpay-order-slot.db.test.ts`

This suite exercises exactly the two RPCs Task 1 replaces. It runs with `npm run test:db` against the **local** stack, and `npm test` excludes it. Without these changes:
- its fresh tenants have no assignment, so every `created`/`replaced` becomes `no_merchant`;
- `seedLive` inserts unpinned KBZPay rows, which the new CHECK rejects;
- tenant cleanup hits `ON DELETE RESTRICT`.

The local stack must have Task 1's migration applied, e.g. with `npx supabase migration up --local`. Ask the owner before running anything that resets the local DB.

- [ ] **Step 1: Row types carry the merchant**

```ts
type ClaimRow = {
  outcome: string;
  payment_id: string | null;
  ref: string | null;
  qr: string | null;
  merchant: string | null;
};
type SupersedeRow = { outcome: string; payment_id: string | null; merchant: string | null };
```

- [ ] **Step 2: Every test tenant gets an assignment by default**

Change `makeWorld`'s signature and add the assignment right after the tenant insert:

```ts
async function makeWorld(opts: { enrollmentStatus?: string; merchant?: string | null } = {}) {
  const { enrollmentStatus = "pending_payment", merchant = "TESTMERCHANT" } = opts;
```

```ts
  made.tenants.push(t.id);
  if (merchant) {
    await sql(
      `INSERT INTO kbzpay_merchant_assignments (tenant_id, merchant_id) VALUES ($1,$2)`,
      [t.id, merchant],
    );
  }
```

- [ ] **Step 3: Seeded rows are pinned**

In `seedLive`, add an option and the column:

```ts
  opts: { qr?: string | null; amount?: number; expiresAt?: string; merchant?: string } = {},
) {
  const { qr = "0002010102QR", amount = AMOUNT, expiresAt = future(), merchant = "TESTMERCHANT" } = opts;
  const [p] = await sql<{ id: string }>(
    `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_ref, payment_method,
                           mmqr_status, status, provider_qr, provider_order_expires_at,
                           kbzpay_merchant)
     VALUES ($1,$2,$3,$4,'kbzpay_mmqr','PENDING','awaiting_payment',$5,$6::timestamptz,$7)
     RETURNING id`,
    [enrollmentId, tenantId, amount, ref, qr, expiresAt, merchant],
  );
```

The test connection runs as the local superuser, so the trigger's assignment lookup succeeds. `merchant` must equal the tenant's assignment, or the trigger rejects the insert.

- [ ] **Step 4: Cleanup deletes assignments before tenants**

In `afterEach`, immediately before the `DELETE FROM tenants` line:

```ts
  if (tenants.length) {
    await sql(`DELETE FROM kbzpay_merchant_assignments WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
  }
```

- [ ] **Step 5: Add the merchant cases**

```ts
describe("merchant pinning", () => {
  it("claim pins the tenant's assignment on a created row and returns it", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const [row] = await claim(enrollmentId, tenantId, `KBZ_${uniq()}`);
    expect(row.outcome).toBe("created");
    expect(row.merchant).toBe("TESTMERCHANT");
    const [p] = await sql<{ kbzpay_merchant: string }>(
      `SELECT kbzpay_merchant FROM payments WHERE id=$1`,
      [row.payment_id],
    );
    expect(p.kbzpay_merchant).toBe("TESTMERCHANT");
  });

  it("claim returns no_merchant and inserts nothing for a tenant without an assignment", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ merchant: null });
    const [row] = await claim(enrollmentId, tenantId, `KBZ_${uniq()}`);
    expect(row.outcome).toBe("no_merchant");
    expect(await allKbzRows(enrollmentId)).toEqual([]);
  });

  it("reuse returns the row's pin even after the assignment is removed", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const ref = `KBZ_${uniq()}`;
    await seedLive(enrollmentId, tenantId, ref);
    await sql(`DELETE FROM kbzpay_merchant_assignments WHERE tenant_id=$1`, [tenantId]);
    const [row] = await claim(enrollmentId, tenantId, `KBZ_${uniq()}`);
    expect(row.outcome).toBe("reuse");
    expect(row.merchant).toBe("TESTMERCHANT");
  });

  it("supersede returns no_merchant and leaves the old row PENDING", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const oldRef = `KBZ_${uniq()}`;
    await seedLive(enrollmentId, tenantId, oldRef);
    await sql(`DELETE FROM kbzpay_merchant_assignments WHERE tenant_id=$1`, [tenantId]);
    const [row] = await supersede(enrollmentId, tenantId, oldRef, "EXPIRED", `KBZ_${uniq()}`);
    expect(row.outcome).toBe("no_merchant");
    expect((await liveRows(enrollmentId)).map((r) => r.payment_ref)).toEqual([oldRef]);
  });

  it("supersede pins the CURRENT assignment on the new row", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const oldRef = `KBZ_${uniq()}`;
    await seedLive(enrollmentId, tenantId, oldRef);
    await sql(`UPDATE kbzpay_merchant_assignments SET merchant_id='OTHERMERCHANT' WHERE tenant_id=$1`, [tenantId]);
    const [row] = await supersede(enrollmentId, tenantId, oldRef, "EXPIRED", `KBZ_${uniq()}`);
    expect(row.outcome).toBe("replaced");
    expect(row.merchant).toBe("OTHERMERCHANT");
  });

  it("rejects any change to a pin", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const id = await seedLive(enrollmentId, tenantId, `KBZ_${uniq()}`);
    await expect(
      sql(`UPDATE payments SET kbzpay_merchant='OTHERMERCHANT' WHERE id=$1`, [id]),
    ).rejects.toThrow(/immutable/);
  });

  it("rejects re-labelling a pinned KBZPay row as another method", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const id = await seedLive(enrollmentId, tenantId, `KBZ_${uniq()}`);
    await expect(
      sql(`UPDATE payments SET payment_method='bank_transfer' WHERE id=$1`, [id]),
    ).rejects.toThrow(/payments_kbzpay_merchant_required/);
  });

  it("rejects a pin on a non-KBZPay row", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    // Pin matches the assignment, so only the CHECK can refuse it.
    await expect(
      sql(
        `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_ref, payment_method,
                               status, kbzpay_merchant)
         VALUES ($1,$2,$3,$4,'bank_transfer','awaiting_payment','TESTMERCHANT')`,
        [enrollmentId, tenantId, AMOUNT, `BT_${uniq()}`],
      ),
    ).rejects.toThrow(/payments_kbzpay_merchant_required/);
  });

  it("rejects an insert pinned to a merchant other than the tenant's assignment", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await expect(
      seedLive(enrollmentId, tenantId, `KBZ_${uniq()}`, { merchant: "OTHERMERCHANT" }),
    ).rejects.toThrow(/does not match the tenant assignment/);
  });
});
```

- [ ] **Step 6: Existing assertions on full rows**

Any existing `toEqual` on a whole `ClaimRow`/`SupersedeRow` object now needs `merchant` too. Find them with `grep -n "toEqual({ outcome\|toEqual(\[{ outcome" src/__tests__/db/kbzpay-order-slot.db.test.ts`. Use `expect.objectContaining` or add `merchant: "TESTMERCHANT"` (or `null` for the outcomes the SQL returns with `NULL::text`).

- [ ] **Step 7: Run**

Run: `npm run test:db -- src/__tests__/db/kbzpay-order-slot.db.test.ts`
Expected: exit code 0.

- [ ] **Step 8: Commit**

```bash
git status && git diff
git add src/__tests__/db/kbzpay-order-slot.db.test.ts
git commit -m "test(kbzpay): cover merchant pinning in the order-slot RPC suite"
```

---

### Task 2: `getKbzMerchant()` — fail-closed resolver

**Files:**
- Modify: `src/lib/kbzpay.ts` (add after the `buildMerchOrderId` function, before `// ── Transport`)
- Test: `src/__tests__/payments/kbzpay-merchant.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── getKbzMerchant ─────────────────────────────────────────────────────────
// Spec §2 decision 5 and §5.1: one named credential set per merchant, and no
// fallback between merchants, ever. A silent fallback is exactly how one
// tenant's buyers would pay another tenant's account.

const BRAVE = {
  KBZPAY_BRAVE_APPID: "kptest0000000000000000000000000000",
  KBZPAY_BRAVE_MERCH_CODE: "70000000001",
  KBZPAY_BRAVE_APP_KEY: "testkey0123456789abcdef",
  KBZPAY_BRAVE_NOTIFY_ORIGIN: "https://brave.kuunyi.com",
};

const ALL_KEYS = [
  ...Object.keys(BRAVE),
  "KBZPAY_SKYFEST_APPID",
  "KBZPAY_SKYFEST_MERCH_CODE",
  "KBZPAY_SKYFEST_APP_KEY",
  "KBZPAY_SKYFEST_NOTIFY_ORIGIN",
  "KBZPAY_APPID",
  "KBZPAY_MERCH_CODE",
  "KBZPAY_APP_KEY",
];

beforeEach(() => {
  for (const k of ALL_KEYS) delete process.env[k];
  Object.assign(process.env, BRAVE);
});

afterEach(() => {
  for (const k of ALL_KEYS) delete process.env[k];
});

const { getKbzMerchant } = await import("@/lib/kbzpay");

describe("getKbzMerchant", () => {
  it("returns the named merchant's credentials", () => {
    expect(getKbzMerchant("BRAVE")).toEqual({
      id: "BRAVE",
      appid: BRAVE.KBZPAY_BRAVE_APPID,
      merchCode: BRAVE.KBZPAY_BRAVE_MERCH_CODE,
      appKey: BRAVE.KBZPAY_BRAVE_APP_KEY,
      notifyOrigin: "https://brave.kuunyi.com",
    });
  });

  it.each([null, undefined, "", "brave", "1BRAVE", "B", "BRAVE-X", "A".repeat(33)])(
    "throws on a missing or malformed id (%s)",
    (id) => {
      expect(() => getKbzMerchant(id as string | null | undefined)).toThrow(/merchant id/);
    },
  );

  it.each(["APPID", "MERCH_CODE", "APP_KEY", "NOTIFY_ORIGIN"])(
    "throws, naming the variable, when %s is missing",
    (suffix) => {
      delete process.env[`KBZPAY_BRAVE_${suffix}`];
      expect(() => getKbzMerchant("BRAVE")).toThrow(`KBZPAY_BRAVE_${suffix} is not set`);
    },
  );

  it("treats a whitespace-only value as missing", () => {
    process.env.KBZPAY_BRAVE_APP_KEY = "   ";
    expect(() => getKbzMerchant("BRAVE")).toThrow("KBZPAY_BRAVE_APP_KEY is not set");
  });

  it("never falls back to another merchant or to the retired global vars", () => {
    process.env.KBZPAY_APPID = "global";
    process.env.KBZPAY_MERCH_CODE = "global";
    process.env.KBZPAY_APP_KEY = "global";
    expect(() => getKbzMerchant("SKYFEST")).toThrow("KBZPAY_SKYFEST_APPID is not set");
  });

  it("rejects a non-https notify origin", () => {
    process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN = "http://brave.kuunyi.com";
    expect(() => getKbzMerchant("BRAVE")).toThrow("KBZPAY_BRAVE_NOTIFY_ORIGIN must use https");
  });

  it("rejects a malformed notify origin", () => {
    process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN = "not a url";
    expect(() => getKbzMerchant("BRAVE")).toThrow("KBZPAY_BRAVE_NOTIFY_ORIGIN is not a valid URL");
  });

  it("normalises the notify origin, dropping any path or query", () => {
    // KBZPay rejects a notify_url carrying query parameters.
    process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN = "https://brave.kuunyi.com/some/path?x=1";
    expect(getKbzMerchant("BRAVE").notifyOrigin).toBe("https://brave.kuunyi.com");
  });

  it("never puts a secret value in an error message", () => {
    process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN = "http://brave.kuunyi.com";
    try {
      getKbzMerchant("BRAVE");
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as Error).message).not.toContain(BRAVE.KBZPAY_BRAVE_APP_KEY);
      expect((err as Error).message).not.toContain(BRAVE.KBZPAY_BRAVE_APPID);
    }
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-merchant.test.ts`
Expected: FAIL, `getKbzMerchant` is not a function.

- [ ] **Step 3: Implement**

Add to `src/lib/kbzpay.ts`, immediately before `// ── Transport ───`:

```ts
// ── Merchants ──────────────────────────────────────────────────────────────

/**
 * One KBZPay merchant's credentials, read from `KBZPAY_<ID>_*`.
 *
 * Spec 2026-10-30 §3, §5.1. A tenant's merchant id comes from
 * kbzpay_merchant_assignments and is pinned on each payment row; every call
 * for an order uses the merchant pinned on it.
 */
export type KbzMerchant = {
  id: string;
  appid: string;
  merchCode: string;
  appKey: string;
  /** https origin KBZPay calls back, registered with KBZPay for this merchant. */
  notifyOrigin: string;
};

const MERCHANT_ID_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;

/**
 * Resolves a merchant, failing closed.
 *
 * There is deliberately NO fallback — not to another merchant, not to the
 * retired unprefixed KBZPAY_APPID/MERCH_CODE/APP_KEY. A fallback is exactly
 * how one tenant's buyers would end up paying another tenant's account.
 *
 * Errors name the variable, never its value.
 */
export function getKbzMerchant(id: string | null | undefined): KbzMerchant {
  if (!id || !MERCHANT_ID_PATTERN.test(id)) {
    throw new Error("KBZPay merchant id is missing or malformed");
  }

  const read = (suffix: string): string => {
    const name = `KBZPAY_${id}_${suffix}`;
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };

  return {
    id,
    appid: read("APPID"),
    merchCode: read("MERCH_CODE"),
    appKey: read("APP_KEY"),
    notifyOrigin: parseNotifyOrigin(`KBZPAY_${id}_NOTIFY_ORIGIN`, read("NOTIFY_ORIGIN")),
  };
}

/**
 * https only, normalised to the origin. Unlike the old KBZPAY_NOTIFY_ORIGIN,
 * a bad value is an error rather than a fallback to platformOrigin(): with
 * several merchants, a fallback would send this merchant's callbacks to a
 * host KBZPay has not registered for it.
 */
function parseNotifyOrigin(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${name} must use https`);
  return parsed.origin;
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-merchant.test.ts`
Expected: PASS, exit code 0.

- [ ] **Step 5: Commit**

```bash
git status && git diff
git add src/lib/kbzpay.ts src/__tests__/payments/kbzpay-merchant.test.ts
git commit -m "feat(kbzpay): add fail-closed per-merchant credential resolver"
```

---

### Task 3: Thread the merchant through the KBZPay client

**Files:**
- Modify: `src/lib/kbzpay.ts` (`APPID/MERCH_CODE/APP_KEY` at ~line 111; `call` ~line 289; `precreate` ~line 398; `queryOrder` ~line 453; `closeOrder` ~line 505)
- Test: `src/__tests__/payments/kbzpay-client.test.ts`

- [ ] **Step 1: Update the client test to the new signatures**

In `src/__tests__/payments/kbzpay-client.test.ts`:

1. Replace the `ENV` constant (lines 7–12) with:

```ts
const ENV = { KBZPAY_MODE: "uat" };

const MERCHANT = {
  id: "BRAVE",
  appid: "kptest0000000000000000000000000000",
  merchCode: "70000000001",
  appKey: "testkey0123456789abcdef",
  notifyOrigin: "https://brave.kuunyi.com",
};
```

2. Add the merchant as the **first** argument of every call:
   - `precreate({` → `precreate(MERCHANT, {`
   - `queryOrder(` → `queryOrder(MERCHANT, `
   - `closeOrder(` → `closeOrder(MERCHANT, `
   - In the `endpoint scheme` suite's `urlFor` helper (~line 319): `mod.precreate({` → `mod.precreate(MERCHANT, {`, and `await mod[fn]("KBZ_x");` → `await mod[fn](MERCHANT, "KBZ_x");`

   Put `MERCHANT` on the **same line** as the opening `(`, even where the original call breaks its arguments onto the next line (e.g. `await precreate(` at ~line 496). The check below is line-based.

   Check with `grep -nP "(precreate|queryOrder|closeOrder|mod\[fn\])\((?!MERCHANT)" src/__tests__/payments/kbzpay-client.test.ts`. Expected: no output.
3. Replace any `ENV.KBZPAY_APP_KEY`, `ENV.KBZPAY_APPID`, `ENV.KBZPAY_MERCH_CODE` with `MERCHANT.appKey`, `MERCHANT.appid`, `MERCHANT.merchCode`. Check with `grep -n "ENV.KBZPAY_A\|ENV.KBZPAY_M" src/__tests__/payments/kbzpay-client.test.ts`. Expected: only `KBZPAY_MODE` uses remain, or none.
4. Add this suite at the end of the file:

```ts
describe("per-merchant credentials", () => {
  it("sends the merchant's appid and merch_code and signs with its key", async () => {
    const { queryOrder, sign } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(ok({ result: "SUCCESS", code: "0", trade_status: "WAIT_PAY" }));

    await queryOrder(MERCHANT, "KBZ_x_y");

    const body = requestBody();
    expect(body.biz_content.appid).toBe(MERCHANT.appid);
    expect(body.biz_content.merch_code).toBe(MERCHANT.merchCode);
    const { sign: sent, ...unsigned } = body;
    expect(sent).toBe(sign(unsigned, MERCHANT.appKey));
  });

  it("signs with the key of the merchant it was given, not another's", async () => {
    // Compared on ONE captured payload: two separate calls would differ anyway
    // through nonce_str and timestamp, which would make this pass trivially.
    const { closeOrder, sign } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(ok({ result: "SUCCESS", code: "0" }));
    const other = { ...MERCHANT, id: "SKYFEST", appKey: "otherkey0123456789abcdef" };

    await closeOrder(other, "KBZ_x_y");

    const { sign: sent, ...unsigned } = requestBody();
    expect(sent).toBe(sign(unsigned, other.appKey));
    expect(sent).not.toBe(sign(unsigned, MERCHANT.appKey));
  });
});
```

Note: `sign()` signs over the fields it is given, excluding `sign` itself, per spec §3.3. If `sign(unsigned, …)` doesn't reproduce the sent signature because `nonce_str`/`timestamp` are included, it still will: they are part of `unsigned`. If the assertion fails for another reason, read `buildStringA` in `src/lib/kbzpay.ts:27` before changing the test.

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-client.test.ts`
Expected: FAIL. The functions still take the old arguments, so the merchant object lands where the order id or params should be.

- [ ] **Step 3: Implement**

In `src/lib/kbzpay.ts`:

1. Delete the three lines:

```ts
const APPID = () => process.env.KBZPAY_APPID!;
const MERCH_CODE = () => process.env.KBZPAY_MERCH_CODE!;
const APP_KEY = () => process.env.KBZPAY_APP_KEY!;
```

2. `call` gains a leading `merchant` parameter and signs with its key:

```ts
async function call(
  merchant: KbzMerchant,
  path: string,
  method: string,
  version: string,
  bizContent: Record<string, KbzField>,
  extraCommon: Record<string, KbzField> = {},
  budget?: CallBudget,
): Promise<CallResult> {
```

   and replace `request.sign = sign(request, APP_KEY());` with `request.sign = sign(request, merchant.appKey);`.

3. `precreate`:

```ts
export async function precreate(
  merchant: KbzMerchant,
  p: PrecreateParams,
  budget?: CallBudget,
): Promise<PrecreateResult> {
  const r = await call(
    merchant,
    "precreate",
    "kbz.payment.precreate",
    "1.0",
    {
      appid: merchant.appid,
      merch_code: merchant.merchCode,
```

   The rest of the body is unchanged.

4. `queryOrder`:

```ts
export async function queryOrder(
  merchant: KbzMerchant,
  merchOrderId: string,
  budget?: CallBudget,
): Promise<QueryResult> {
  const r = await call(merchant, "queryorder", "kbz.payment.queryorder", "3.0", {
    appid: merchant.appid,
    merch_code: merchant.merchCode,
    merch_order_id: merchOrderId,
  }, {}, budget);
```

5. `closeOrder`:

```ts
export async function closeOrder(
  merchant: KbzMerchant,
  merchOrderId: string,
  budget?: CallBudget,
): Promise<{ ok: boolean }> {
  const r = await call(merchant, "closeorder", "kbz.payment.closeorder", "3.0", {
    appid: merchant.appid,
    merch_code: merchant.merchCode,
    merch_order_id: merchOrderId,
  }, {}, budget);
```

6. Add `getKbzMerchant` to the default export object at the bottom:

```ts
const kbzpay = { precreate, queryOrder, closeOrder, sign, verifySign, buildMerchOrderId, getKbzMerchant };
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-client.test.ts src/__tests__/payments/kbzpay-merchant.test.ts`
Expected: PASS, exit code 0. `tsc` will fail at this point because callers still use the old signatures; Tasks 4–7 fix them.

- [ ] **Step 5: Commit**

```bash
git status && git diff
git add src/lib/kbzpay.ts src/__tests__/payments/kbzpay-client.test.ts
git commit -m "feat(kbzpay): sign and address every gateway call with a given merchant"
```

---

### Task 4: `resolveKbzpayOrder` uses the old order's pinned merchant

**Files:**
- Modify: `src/server/payments/resolveKbzpayOrder.ts`
- Test: `src/__tests__/payments/kbzpay-resolve.test.ts`

- [ ] **Step 1: Update the test**

In `src/__tests__/payments/kbzpay-resolve.test.ts`:

1. After `const OLD_REF = …` add:

```ts
const MERCHANT = {
  id: "BRAVE",
  appid: "kptest0000000000000000000000000000",
  merchCode: "70000000001",
  appKey: "testkey0123456789abcdef",
  notifyOrigin: "https://brave.kuunyi.com",
};
```

2. Change the helper to `const resolve = () => resolveKbzpayOrder({ oldRef: OLD_REF, merchant: MERCHANT, source: "create" });`. Also add `merchant: MERCHANT` to any other direct `resolveKbzpayOrder({` call in the file (`grep -n "resolveKbzpayOrder({" src/__tests__/payments/kbzpay-resolve.test.ts`).
3. Add this test:

```ts
describe("merchant", () => {
  it("queries and closes with the merchant it was given", async () => {
    mockQueryOrder
      .mockResolvedValueOnce({ ok: true, tradeStatus: "WAIT_PAY" })
      .mockResolvedValueOnce({ ok: true, tradeStatus: "ORDER_CLOSED" });
    mockCloseOrder.mockResolvedValue({ ok: true });

    await resolve();

    for (const call of [...mockQueryOrder.mock.calls, ...mockCloseOrder.mock.calls]) {
      expect(call[0]).toBe(MERCHANT);
      expect(call[1]).toBe(OLD_REF);
    }
  });
});
```

4. Every argument of `queryOrder` and `closeOrder` shifts right by one. Any existing assertion that reads the order ref from `mockQueryOrder.mock.calls[n][0]` or `mockCloseOrder.mock.calls[n][0]` (today `kbzpay-resolve.test.ts:113`) now reads `[n][1]`, and any reading the budget from `[n][1]` now reads `[n][2]`. Any `toHaveBeenCalledWith(OLD_REF, …)` on those mocks becomes `toHaveBeenCalledWith(MERCHANT, OLD_REF, …)`. Find them with `grep -n "mockQueryOrder.mock.calls\|mockCloseOrder.mock.calls\|QueryOrder).toHaveBeenCalledWith\|CloseOrder).toHaveBeenCalledWith" src/__tests__/payments/kbzpay-resolve.test.ts`.

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-resolve.test.ts`
Expected: FAIL. The new test sees the ref as argument 0.

- [ ] **Step 3: Implement**

In `src/server/payments/resolveKbzpayOrder.ts`:

1. Imports become:

```ts
import { queryOrder, closeOrder, type TradeStatus, type KbzMerchant } from "@/lib/kbzpay";
```

2. Add to `ResolveInput`, after `oldRef`:

```ts
  /**
   * The merchant pinned on the OLD row. The old order lives under that
   * merchant at KBZPay, whatever the tenant's assignment is now — querying it
   * under another merchant reads as "not found" and would retire a live order.
   */
  merchant: KbzMerchant;
```

3. Every `queryOrder(oldRef, input.budget)` becomes `queryOrder(input.merchant, oldRef, input.budget)`, and `closeOrder(oldRef, input.budget)` becomes `closeOrder(input.merchant, oldRef, input.budget)`. Check: `grep -n "queryOrder(\|closeOrder(" src/server/payments/resolveKbzpayOrder.ts`. Every hit must start with `input.merchant`.

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-resolve.test.ts src/__tests__/payments/kbzpay-budget-coverage.test.ts`
Expected: PASS, exit code 0.

- [ ] **Step 5: Commit**

```bash
git status && git diff
git add src/server/payments/resolveKbzpayOrder.ts src/__tests__/payments/kbzpay-resolve.test.ts
git commit -m "feat(kbzpay): resolve old orders under their pinned merchant"
```

---

### Task 5: Status route

**Files:**
- Modify: `src/app/api/public/payments/kbzpay/status/route.ts` (~lines 1–10 imports, 69–91 lookup and query)
- Test: `src/__tests__/payments/kbzpay-status-route.test.ts`

- [ ] **Step 1: Update the test**

In `src/__tests__/payments/kbzpay-status-route.test.ts`:

1. After the imports, before the mocks, add:

```ts
process.env.KBZPAY_BRAVE_APPID = "kptest0000000000000000000000000000";
process.env.KBZPAY_BRAVE_MERCH_CODE = "70000000001";
process.env.KBZPAY_BRAVE_APP_KEY = "testkey0123456789abcdef";
process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN = "https://brave.kuunyi.com";
```

2. Add `kbzpay_merchant: "BRAVE"` to the `payment` fixture in `beforeEach`.
3. Replace the `mockFrom` implementation in `beforeEach` so it records the filters and expects two `eq` calls:

```ts
  eqCalls = [];
  mockFrom.mockImplementation(() => ({
    select: () => ({
      eq: (c1: string, v1: unknown) => ({
        eq: (c2: string, v2: unknown) => {
          eqCalls.push([c1, v1], [c2, v2]);
          return { maybeSingle: async () => ({ data: payment, error: null }) };
        },
      }),
    }),
  }));
```

   and declare `let eqCalls: [string, unknown][];` beside `let payment`.
4. Every argument of `queryOrder` shifts right by one: assertions reading the ref from `mockQueryOrder.mock.calls[n][0]` now read `[n][1]`, and any reading the budget from `[n][1]` now read `[n][2]`. Find them with `grep -n "mockQueryOrder.mock.calls\|QueryOrder).toHaveBeenCalledWith" src/__tests__/payments/kbzpay-status-route.test.ts`.
5. In `src/types/database.ts`, add to `export interface Payment` (line ~314), after `platform_fee`:

```ts
  /**
   * KBZPay merchant id (KBZPAY_<ID>_*) that created this order. Set once at
   * insert and immutable; null for every other payment method.
   */
  kbzpay_merchant: string | null;
```

   The new `.select("…, kbzpay_merchant")` calls go through the typed client, so an undeclared column can surface as a type error.
5. Add:

```ts
describe("merchant", () => {
  it("looks up KBZPay rows only", async () => {
    await GET(req());
    expect(eqCalls).toContainEqual(["payment_method", "kbzpay_mmqr"]);
    expect(eqCalls).toContainEqual(["payment_ref", REF]);
  });

  it("queries with the merchant pinned on the row", async () => {
    await GET(req());
    expect(mockQueryOrder.mock.calls[0][0]).toEqual(expect.objectContaining({ id: "BRAVE" }));
    expect(mockQueryOrder.mock.calls[0][1]).toBe(REF);
  });

  it("answers PENDING without calling KBZPay when the pinned merchant is misconfigured", async () => {
    payment = { ...payment!, kbzpay_merchant: "SKYFEST" }; // no KBZPAY_SKYFEST_* set
    const res = await GET(req());
    expect(await body(res)).toEqual({ mmqr_status: "PENDING" });
    expect(mockQueryOrder).not.toHaveBeenCalled();
  });

  it("answers PENDING without calling KBZPay for a non-KBZPay ref", async () => {
    payment = null; // the method filter excludes it
    const res = await GET(req("ABANK_123"));
    expect(await body(res)).toEqual({ mmqr_status: "PENDING" });
    expect(mockQueryOrder).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-status-route.test.ts`
Expected: FAIL. The route calls `eq` once and `queryOrder` with the old arguments.

- [ ] **Step 3: Implement**

In `src/app/api/public/payments/kbzpay/status/route.ts`:

1. Add `getKbzMerchant` and `type KbzMerchant` to the existing `@/lib/kbzpay` import.
2. Replace the payment lookup with:

```ts
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, mmqr_status, status, kbzpay_merchant")
    .eq("payment_ref", paymentRef)
    // KBZPay rows only (spec §5.4): another provider's ref must never reach KBZPay.
    .eq("payment_method", "kbzpay_mmqr")
    .maybeSingle()) as {
    data: {
      id: string;
      enrollment_id: string;
      mmqr_status: string;
      status: string;
      kbzpay_merchant: string | null;
    } | null;
    error: unknown;
  };
```

3. Immediately before `// ── Ask KBZPay`, add:

```ts
  // ── Resolve the merchant pinned on this order ──────────────
  // A config error is not a payment outcome. Keep polling, never terminal.
  let merchant: KbzMerchant;
  try {
    merchant = getKbzMerchant(payment.kbzpay_merchant);
  } catch (err) {
    console.error(
      `[kbzpay-status] merchant config error for ${paymentRef}: ${err instanceof Error ? err.message : err}`,
    );
    return NextResponse.json({ mmqr_status: "PENDING" });
  }
```

4. `const result = await queryOrder(paymentRef, budget);` becomes `const result = await queryOrder(merchant, paymentRef, budget);`.

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-status-route.test.ts src/__tests__/payments/kbzpay-budget-coverage.test.ts`
Expected: PASS, exit code 0.

- [ ] **Step 5: Commit**

```bash
git status && git diff
git add src/app/api/public/payments/kbzpay/status/route.ts src/__tests__/payments/kbzpay-status-route.test.ts src/types/database.ts
git commit -m "feat(kbzpay): status poller uses the pinned merchant, KBZPay rows only"
```

---

### Task 6: Webhook verifies with the pinned merchant

**Files:**
- Modify: `src/app/api/webhooks/kbzmmqr/route.ts` (steps 2–4, ~lines 69–106)
- Test: `src/__tests__/payments/kbzpay-webhook-route.test.ts`

- [ ] **Step 1: Update the test**

In `src/__tests__/payments/kbzpay-webhook-route.test.ts`:

1. Replace lines 12–14 (the three `process.env.KBZPAY_*` lines) with:

```ts
process.env.KBZPAY_BRAVE_APPID = "kptest0000000000000000000000000000";
process.env.KBZPAY_BRAVE_MERCH_CODE = "70000000001";
process.env.KBZPAY_BRAVE_APP_KEY = APP_KEY;
process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN = "https://brave.kuunyi.com";

// A second, fully configured merchant: its key is valid, just not for Brave's orders.
const SKYFEST_KEY = "skyfestkey0123456789abcd";
process.env.KBZPAY_SKYFEST_APPID = "kpsky00000000000000000000000000000";
process.env.KBZPAY_SKYFEST_MERCH_CODE = "70000000002";
process.env.KBZPAY_SKYFEST_APP_KEY = SKYFEST_KEY;
process.env.KBZPAY_SKYFEST_NOTIFY_ORIGIN = "https://skyfest.kuunyi.com";
```

2. Add `kbzpay_merchant: "BRAVE"` to the `payment` fixture in `beforeEach`.
3. Replace the `mockFrom` implementation in `beforeEach` with the two-`eq` version, recording filters (declare `let eqCalls: [string, unknown][];` and reset it in `beforeEach`):

```ts
  eqCalls = [];
  mockFrom.mockImplementation(() => ({
    select: () => ({
      eq: (c1: string, v1: unknown) => ({
        eq: (c2: string, v2: unknown) => {
          eqCalls.push([c1, v1], [c2, v2]);
          return { maybeSingle: async () => ({ data: payment, error: null }) };
        },
      }),
    }),
  }));
```

4. Every argument of `queryOrder` shifts right by one. Existing assertions that read the ref from `mockQueryOrder.mock.calls[n][0]` now read `[n][1]`, **and** those that read the budget from `[n][1]` now read `[n][2]`. Today these are lines ~156 (`calls[0][1]).toMatchObject({ deadlineMs … })` → `[0][2]`), ~166 (`calls[0][0]).toBe(REF)` → `[0][1]`) and ~171 (`calls[0][1]).toBeUndefined()` → `[0][2]`). Re-check with `grep -n "mockQueryOrder.mock.calls\|QueryOrder).toHaveBeenCalledWith" src/__tests__/payments/kbzpay-webhook-route.test.ts`.
5. Add:

```ts
describe("per-merchant verification", () => {
  it("rejects a callback validly signed with ANOTHER merchant's key", async () => {
    const res = await POST(signedRequest({}, SKYFEST_KEY));
    expect(res.status).toBe(403);
    expect(mockQueryOrder).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("rejects a correctly signed callback whose merch_code is not the pinned merchant's", async () => {
    const res = await POST(signedRequest({ merch_code: "70000000002" }));
    expect(res.status).toBe(403);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("verifies with the pinned merchant, not the tenant's current assignment", async () => {
    payment = { ...payment!, kbzpay_merchant: "SKYFEST" };
    const res = await POST(signedRequest({ merch_code: "70000000002" }, SKYFEST_KEY));
    expect(res.status).toBe(200);
    expect(mockQueryOrder.mock.calls[0][0]).toEqual(expect.objectContaining({ id: "SKYFEST" }));
  });

  it("looks up KBZPay rows only", async () => {
    await POST(signedRequest());
    expect(eqCalls).toContainEqual(["payment_method", "kbzpay_mmqr"]);
    expect(eqCalls).toContainEqual(["payment_ref", REF]);
  });

  it("returns 404 for an unknown ref, so KBZPay retries a creation race", async () => {
    payment = null;
    expect((await POST(signedRequest())).status).toBe(404);
  });

  it("returns 500, not 403, when the pinned merchant is misconfigured", async () => {
    payment = { ...payment!, kbzpay_merchant: "NOPE" };
    const res = await POST(signedRequest());
    expect(res.status).toBe(500);
    expect(mockSettle).not.toHaveBeenCalled();
  });
});
```

6. Check the existing "signature verification" tests still make sense: an invalid signature is now detected **after** the lookup, but still returns 403 and never calls `queryOrder` or settlement. Any existing test that expects `mockFrom` not to be called on a bad signature must now expect it to be called. Search with `grep -n "mockFrom).not" src/__tests__/payments/kbzpay-webhook-route.test.ts`.

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-webhook-route.test.ts`
Expected: FAIL. The route still reads `KBZPAY_APP_KEY`, which is unset now.

- [ ] **Step 3: Implement**

In `src/app/api/webhooks/kbzmmqr/route.ts`:

1. The import becomes:

```ts
import {
  verifySign,
  queryOrder,
  getKbzMerchant,
  type KbzField,
  type CallBudget,
  type KbzMerchant,
} from "@/lib/kbzpay";
```

2. Replace everything from `// ── 2. Verify the signature` through the end of `// ── 3. Locate the payment` (up to, not including, `// ── 4. Confirm server-to-server`) with:

```ts
  if (!merchOrderId) {
    return NextResponse.json({ error: "Bad Request" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── 2. Locate the payment ──────────────────────────────────
  // Before authentication, because the key depends on the order (spec
  // 2026-10-30 §5.3). Read-only. KBZPay rows only, and the CHECK on payments
  // guarantees every match carries a pin.
  // 404 rather than success: a genuine race between order creation and this
  // callback resolves on KBZPay's retry.
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, status, kbzpay_merchant")
    .eq("payment_ref", merchOrderId)
    .eq("payment_method", "kbzpay_mmqr")
    .maybeSingle()) as {
    data: { id: string; kbzpay_merchant: string | null } | null;
    error: unknown;
  };

  if (!payment) {
    console.warn(`[kbzpay-webhook] no payment row for ${merchOrderId}`);
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  // ── 3. Resolve the pinned merchant ─────────────────────────
  // Missing config is OUR fault, not the caller's: the callback may be
  // genuine, and a retry after the operator fixes it should settle. So 500,
  // which KBZPay retries, not 403.
  let merchant: KbzMerchant;
  try {
    merchant = getKbzMerchant(payment.kbzpay_merchant);
  } catch (err) {
    console.error(
      `[kbzpay-webhook] merchant config error for ${merchOrderId}: ${err instanceof Error ? err.message : err}`,
    );
    return NextResponse.json({ error: "Configuration Error" }, { status: 500 });
  }

  // ── 4. Verify the signature ────────────────────────────────
  // Against EXACTLY ONE key, the pinned merchant's. Never "try each merchant's
  // key until one verifies": that would make every merchant's key valid for
  // every order. Over whatever keys arrived, never a fixed list, so a future
  // KBZPay field cannot silently break verification.
  if (!verifySign(fields, merchant.appKey) || fields.merch_code !== merchant.merchCode) {
    console.warn(`[kbzpay-webhook] invalid signature or merchant for ${merchOrderId}`);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
```

3. Renumber the following section comments: `// ── 4. Confirm server-to-server` → `// ── 5.`, `// ── 5. Settle` → `// ── 6.`, `// ── 6. Respond per §8` → `// ── 7.`.
4. `const confirmed = await queryOrder(merchOrderId, budget);` becomes `const confirmed = await queryOrder(merchant, merchOrderId, budget);`.
5. Make sure the old `const supabase = createAdminClient();` and the old `if (!merchOrderId)` block further down are gone, so neither is declared twice. `npx tsc --noEmit` in Task 8 will catch a duplicate `const`.

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-webhook-route.test.ts src/__tests__/payments/kbzpay-budget-coverage.test.ts`
Expected: PASS, exit code 0.

- [ ] **Step 5: Commit**

```bash
git status && git diff
git add src/app/api/webhooks/kbzmmqr/route.ts src/__tests__/payments/kbzpay-webhook-route.test.ts
git commit -m "feat(kbzpay): verify callbacks with the pinned merchant's key and merch_code"
```

---

### Task 7: Creation route

**Files:**
- Modify: `src/app/api/public/payments/kbzpay/route.ts`
- Test: `src/__tests__/payments/kbzpay-create-route.test.ts`

- [ ] **Step 1: Update the test**

In `src/__tests__/payments/kbzpay-create-route.test.ts`:

1. After the imports, add:

```ts
process.env.KBZPAY_BRAVE_APPID = "kptest0000000000000000000000000000";
process.env.KBZPAY_BRAVE_MERCH_CODE = "70000000001";
process.env.KBZPAY_BRAVE_APP_KEY = "testkey0123456789abcdef";
process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN = "https://brave.kuunyi.com";
process.env.KBZPAY_SKYFEST_APPID = "kpsky00000000000000000000000000000";
process.env.KBZPAY_SKYFEST_MERCH_CODE = "70000000002";
process.env.KBZPAY_SKYFEST_APP_KEY = "skyfestkey0123456789abcd";
process.env.KBZPAY_SKYFEST_NOTIFY_ORIGIN = "https://skyfest.kuunyi.com";
```

2. In `beforeEach`, the default rows carry a merchant:

```ts
  claimRows = [{ outcome: "created", payment_id: "pay-1", ref: null, qr: null, merchant: "BRAVE" }];
  supersedeRows = [{ outcome: "replaced", payment_id: "pay-2", merchant: "BRAVE" }];
```

   Every other `claimRows = [...]` or `supersedeRows = [...]` literal in the file that represents a successful claim (`created`, `reuse`, `unresolved`) or supersede (`replaced`) also gets `merchant: "BRAVE"`. Find them with `grep -n "claimRows = \|supersedeRows = " src/__tests__/payments/kbzpay-create-route.test.ts`.
3. `precreate` now takes `(merchant, params, budget)`. Every `mockPrecreate.mock.calls[N][0]` that reads the params becomes `mockPrecreate.mock.calls[N][1]`. Check with `grep -n "mockPrecreate.mock.calls\[[0-9]*\]\[0\]" src/__tests__/payments/kbzpay-create-route.test.ts`. Expected after editing: no output.
4. Every `notifyUrl: "https://www.kuunyi.com/api/webhooks/kbzmmqr"` expectation becomes `notifyUrl: "https://brave.kuunyi.com/api/webhooks/kbzmmqr"`.
5. Assertions on `mockResolve` arguments that use exact `toEqual`/`toHaveBeenCalledWith` objects gain `merchant: expect.objectContaining({ id: "BRAVE" })` (`grep -n "mockResolve" src/__tests__/payments/kbzpay-create-route.test.ts`).
6. **Delete** the whole `describe("KBZPAY_NOTIFY_ORIGIN", …)` block (starts ~line 218) and put this in its place:

```ts
// The notify origin is per merchant and operator-set (spec 2026-10-30 §3):
// KBZPay registers a callback host per merchant, never derived from the
// request or the tenant's domain.
describe("merchant", () => {
  it("creates the order under the merchant the claim pinned, with its notify origin", async () => {
    claimRows = [{ outcome: "created", payment_id: "pay-1", ref: null, qr: null, merchant: "SKYFEST" }];

    await POST(req());

    expect(mockPrecreate.mock.calls[0][0]).toEqual(expect.objectContaining({ id: "SKYFEST" }));
    expect(mockPrecreate.mock.calls[0][1]).toEqual(
      expect.objectContaining({ notifyUrl: "https://skyfest.kuunyi.com/api/webhooks/kbzmmqr" }),
    );
  });

  it("returns 503 and calls nothing at KBZPay when the tenant has no merchant", async () => {
    claimRows = [{ outcome: "no_merchant", payment_id: null, ref: null, qr: null, merchant: null }];

    const res = await POST(req());

    expect(res.status).toBe(503);
    expect(mockPrecreate).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("returns 503 and never marks the row FAILED when the pinned merchant is misconfigured", async () => {
    claimRows = [{ outcome: "created", payment_id: "pay-1", ref: null, qr: null, merchant: "NOPE" }];

    const res = await POST(req());

    expect(res.status).toBe(503);
    expect(mockPrecreate).not.toHaveBeenCalled();
    expect(paymentUpdates).toEqual([]);
  });

  it("does NOT re-serve a stored QR when the reused order's merchant is misconfigured", async () => {
    claimRows = [{ outcome: "reuse", payment_id: "pay-1", ref: "KBZ_old", qr: "STORED_QR", merchant: "NOPE" }];

    const res = await POST(req());
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(text).not.toContain("STORED_QR");
  });

  it("resolves the old order under ITS pin and creates the new one under the supersede's", async () => {
    claimRows = [{ outcome: "unresolved", payment_id: "pay-1", ref: "KBZ_old", qr: null, merchant: "BRAVE" }];
    supersedeRows = [{ outcome: "replaced", payment_id: "pay-2", merchant: "SKYFEST" }];
    mockResolve.mockResolvedValue({ kind: "retire", reason: "EXPIRED" });

    await POST(req());

    expect(mockResolve.mock.calls[0][0].merchant).toEqual(expect.objectContaining({ id: "BRAVE" }));
    expect(mockPrecreate.mock.calls[0][0]).toEqual(expect.objectContaining({ id: "SKYFEST" }));
  });

  it("returns 503 without calling KBZPay when the merchant's notify origin is invalid", async () => {
    // Replaces the old suite's fallback cases: a bad origin is now an error, never platformOrigin().
    const saved = process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN;
    process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN = "http://brave.kuunyi.com";
    try {
      const res = await POST(req());
      expect(res.status).toBe(503);
      expect(mockPrecreate).not.toHaveBeenCalled();
    } finally {
      process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN = saved;
    }
  });

  it("returns 503 when the supersede finds no merchant, without creating anything", async () => {
    claimRows = [{ outcome: "unresolved", payment_id: "pay-1", ref: "KBZ_old", qr: null, merchant: "BRAVE" }];
    supersedeRows = [{ outcome: "no_merchant", payment_id: null, merchant: null }];
    mockResolve.mockResolvedValue({ kind: "retire", reason: "EXPIRED" });

    const res = await POST(req());

    expect(res.status).toBe(503);
    expect(mockPrecreate).not.toHaveBeenCalled();
  });
});
```

   Check the `mockRpc` implementation in `beforeEach` (~line 135). It must return `supersedeRows` for `complete_kbzpay_supersede` and `claimRows` for the claim, and must not rebuild the row without `merchant`. If it maps `claimRows` to a new object (for example to fill in `ref` from `args.p_payment_ref`), make it spread the row (`{ ...row, ref: … }`) so `merchant` survives.

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-create-route.test.ts`
Expected: FAIL. `precreate` still gets the old arguments, and there's no 503 path.

- [ ] **Step 3: Implement**

In `src/app/api/public/payments/kbzpay/route.ts`:

1. Imports. Remove `import { platformOrigin } from "@/lib/origin";` and change the kbzpay import to:

```ts
import {
  precreate,
  buildMerchOrderId,
  getKbzMerchant,
  type CallBudget,
  type KbzMerchant,
} from "@/lib/kbzpay";
```

2. Delete the whole `notifyOrigin()` function and its doc comment (~lines 37–85). Check with `grep -n "notifyOrigin()\|platformOrigin\|KBZPAY_NOTIFY_ORIGIN" src/app/api/public/payments/kbzpay/route.ts`. Expected: no output.
3. Row types:

```ts
type ClaimRow = {
  outcome: string;
  payment_id: string | null;
  ref: string | null;
  qr: string | null;
  merchant: string | null;
};
type SupersedeRow = { outcome: string; payment_id: string | null; merchant: string | null };
```

4. After `gatewayError`, add:

```ts
/** Nothing at KBZPay is reachable for this tenant until the operator fixes config. */
const notConfigured = () =>
  fail(503, "Payment is not available for this event yet.", "Service Unavailable");

/**
 * The merchant, or null after logging why. Errors name variables, never values.
 */
function resolveMerchant(id: string | null, context: string): KbzMerchant | null {
  try {
    return getKbzMerchant(id);
  } catch (err) {
    console.error(
      `[kbzpay] merchant config error for ${context}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
```

5. Replace the section from `let { ref: merchOrderId } = claimed;` through the end of the `// ── 6. reuse` block with:

```ts
  if (claimed.outcome === "no_merchant") {
    console.error(`[kbzpay] tenant ${enrollment.tenant_id} has no KBZPay merchant assigned`);
    return notConfigured();
  }

  // ── 5a. Resolve the pinned merchant, before ANY outcome branch ──
  // Including reuse (spec 2026-10-30 §5.2): a merchant whose config was removed
  // or broken must not keep handing out payable QRs whose callbacks and status
  // checks can no longer be verified. The row stays PENDING; never FAILED here.
  let merchant = resolveMerchant(claimed.merchant, claimed.ref ?? enrollment.enrollment_ref);
  if (!merchant) return notConfigured();

  let { ref: merchOrderId } = claimed;

  // ── 6. reuse → hand back the stored QR, no provider call ───
  if (claimed.outcome === "reuse") {
    return NextResponse.json({
      status: "created",
      qr: claimed.qr,
      orderId: claimed.ref,
      amount: totalFee,
    });
  }
```

6. In the `unresolved` branch, `resolveKbzpayOrder({ oldRef, source: "create", budget })` becomes `resolveKbzpayOrder({ oldRef, merchant, source: "create", budget })`. `merchant` here is the OLD row's pin, which is what the claim returned for it.
7. In the supersede handling, immediately before `if (outcome !== "replaced") {`, add:

```ts
    if (outcome === "no_merchant") {
      // Checked before the old row is touched, so nothing changed (§4.3).
      console.error(`[kbzpay] supersede: tenant ${enrollment.tenant_id} has no KBZPay merchant`);
      return notConfigured();
    }
```

   and immediately after `merchOrderId = newRef;`, add:

```ts
    // The new row carries the CURRENT assignment's merchant, which may differ
    // from the old row's.
    const next = resolveMerchant(data[0].merchant, newRef);
    if (!next) return notConfigured();
    merchant = next;
```

8. Replace

```ts
  const notifyUrl = `${notifyOrigin()}/api/webhooks/kbzmmqr`;

  const created = await precreate({
```

with

```ts
  const notifyUrl = `${merchant.notifyOrigin}/api/webhooks/kbzmmqr`;

  const created = await precreate(merchant, {
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-create-route.test.ts src/__tests__/payments/kbzpay-budget-coverage.test.ts`
Expected: PASS, exit code 0.

- [ ] **Step 5: Commit**

```bash
git status && git diff
git add src/app/api/public/payments/kbzpay/route.ts src/__tests__/payments/kbzpay-create-route.test.ts
git commit -m "feat(kbzpay): create orders under the pinned merchant, 503 when unconfigured"
```

---

### Task 8: Docs, env example, full verification

**Files:**
- Modify: `.env.local.example` (~lines 68–87)
- Modify: `docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md` (§9, ~line 677)
- Modify: `docs/clients/brave.md` (~lines 21–27)

- [ ] **Step 1: `.env.local.example`**

Replace the `KBZPAY_APPID`, `KBZPAY_MERCH_CODE`, `KBZPAY_APP_KEY` lines and the `KBZPAY_NOTIFY_ORIGIN` block (with its comment) with:

```
# One credential set PER MERCHANT: KBZPAY_<ID>_*, where <ID> matches
# ^[A-Z][A-Z0-9_]{1,31}$ (e.g. BRAVE, SKYFEST). Which tenant uses which <ID> is
# set by the operator in public.kbzpay_merchant_assignments — never by tenants.
# There is NO fallback: a missing or invalid variable is a configuration error.
# App keys sign every request (SHA256, not HMAC) — never log them, never commit
# them, set them with printf (echo appends a newline and breaks signatures).
KBZPAY_BRAVE_APPID=your-kbzpay-appid
KBZPAY_BRAVE_MERCH_CODE=your-kbzpay-merch-code
KBZPAY_BRAVE_APP_KEY=your-kbzpay-app-key
# https only. MUST match the notify_url registered with KBZPay for THIS merchant
# exactly — the apex 307-redirects and a redirected POST is lost. Locally, UAT
# points at the kbz-uat Cloudflare tunnel.
KBZPAY_BRAVE_NOTIFY_ORIGIN=https://brave.kuunyi.com
```

Keep the `KBZPAY_MODE` and `KBZPAY_PROXY_URL` lines and their comments exactly as they are.

- [ ] **Step 2: Base spec §9**

At the top of §9 in `docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md`, directly under the heading, add:

```
> **Superseded in part (2026-10-30).** Merchant credentials and the notify origin are now per
> merchant (`KBZPAY_<ID>_APPID`, `_MERCH_CODE`, `_APP_KEY`, `_NOTIFY_ORIGIN`) and an invalid
> notify origin is an error, not a fallback. See
> `2026-10-30-kbzpay-per-tenant-merchants-design.md` §3. `KBZPAY_MODE` and `KBZPAY_PROXY_URL`
> below are unchanged.
```

- [ ] **Step 3: `docs/clients/brave.md`**

Replace the line about `KBZPAY_NOTIFY_ORIGIN` matching the registered URL with:

```
- Merchant id `BRAVE` (`kbzpay_merchant_assignments`); credentials are `KBZPAY_BRAVE_*`.
  `KBZPAY_BRAVE_NOTIFY_ORIGIN` must match the registered URL exactly.
```

Keep the rest of that bullet's text (about the apex redirect and the spec link) as it is.

- [ ] **Step 4: Check no reader of the retired vars remains**

Run: `grep -rnE "process\.env\.KBZPAY_(APPID|MERCH_CODE|APP_KEY|NOTIFY_ORIGIN)\b" src scripts e2e --include=*.ts --include=*.tsx --include=*.mjs | grep -v "src/__tests__/"`
Expected: no output. The `\b` matters here: `KBZPAY_BRAVE_APPID` doesn't match. Tests and comments that *name* the retired variables (the no-fallback test, the `getKbzMerchant` doc comment) are expected, and excluded on purpose.

Then: `grep -nE "^KBZPAY_(APPID|MERCH_CODE|APP_KEY|NOTIFY_ORIGIN)=" .env.local.example`
Expected: no output.

- [ ] **Step 5: Full test suite**

Run: `npm test`
Expected: exit code 0. If anything outside `kbzpay-*` fails, check whether it also fails on `origin/dev` before touching it.

- [ ] **Step 6: Check for nested worktrees before typechecking — owner decision**

`tsconfig.json` includes `**/*.ts` and excludes only `node_modules` and `eduenroll`, so any worktree under `.claude/worktrees/` is type-checked too. Its copies of the KBZPay routes resolve `@/lib/kbzpay` to the **root** file, which now has the new signatures, so it reports errors that aren't in real code. `next build` type-checks the same way.

Run: `ls .claude/worktrees/ 2>/dev/null`
If anything is listed (as of 2026-10-30, `optimistic-nobel-050e53`), **stop and ask the owner**. Options:
- remove that worktree properly;
- add `.claude` to the tsconfig `exclude`. That's a config change and needs the owner's yes.

Do not remove it yourself. `git worktree remove --force` deletes *through* a `node_modules` junction into the real one.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit code 0, 0 errors. It was 0 before this work (PR #235) and must stay 0.

- [ ] **Step 8: Build**

Stop any running `npm run dev` first. Then run: `npm run build`
Expected: exit code 0.

- [ ] **Step 9: Commit**

```bash
git status && git diff
git add .env.local.example docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md docs/clients/brave.md
git commit -m "docs(kbzpay): document per-merchant KBZPAY_<ID>_* configuration"
```

---

### Task 9: Apply to the DEV database (owner approval required)

**Not automatic.** This writes to a shared database. Show the owner everything below and wait for an explicit yes.

- [ ] **Step 1: Confirm the CLI target**

Run: `cat supabase/.temp/project-ref`
Expected: `fnfvwzwrdsnmwxunciti`. Anything else → **stop**; do not relink yourself.

- [ ] **Step 2: Pre-check data (read-only), show the SQL first**

```sql
SELECT t.subdomain, count(*) AS kbz_rows
  FROM public.payments p JOIN public.tenants t ON t.id = p.tenant_id
 WHERE p.payment_method = 'kbzpay_mmqr'
 GROUP BY t.subdomain;
```

Expected: only `brave`. Any other subdomain means the migration's CHECK will abort it. Stop and ask.

- [ ] **Step 3: Show the migration diff and get a yes**

Run: `npx supabase@latest migration list --linked`. Expected: `20261030120000` is the **only** local-only migration. `migration up --linked` applies every pending migration, so if any other migration is local-only, **stop and ask**; do not run `migration up`. Show the owner the full migration file and this list, and ask whether to apply it to **dev**.

- [ ] **Step 4: Apply (only after the yes)**

Run: `npx supabase@latest migration up --linked`
Expected: a `Connecting to remote database...` line, then exit code 0. The closing `Local database is up to date.` is printed even after a remote apply; it is not the authoritative line.

- [ ] **Step 5: Verify (read-only), show the SQL first**

```sql
-- each function exists exactly once, service_role only
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('claim_kbzpay_order_slot', 'complete_kbzpay_supersede');

-- assignments: brave → BRAVE, and no table privileges for anon/authenticated
SELECT t.subdomain, a.merchant_id FROM public.kbzpay_merchant_assignments a JOIN public.tenants t ON t.id = a.tenant_id;
SELECT grantee, privilege_type FROM information_schema.role_table_grants
 WHERE table_name = 'kbzpay_merchant_assignments' AND grantee IN ('anon', 'authenticated');

-- every KBZPay row pinned
SELECT count(*) AS unpinned FROM public.payments
 WHERE payment_method = 'kbzpay_mmqr' AND kbzpay_merchant IS NULL;
```

Expected:
- Two function rows, with `service_role = true` and `authenticated = anon = false`.
- One assignment row, `brave | BRAVE`.
- Zero grant rows for `anon`/`authenticated`.
- `unpinned = 0`.

- [ ] **Step 6: Trigger checks, inside a transaction that is rolled back (show first, get a yes)**

```sql
BEGIN;
-- must fail with 42501: pin is immutable, even for the owner role
UPDATE public.payments SET kbzpay_merchant = 'SKYFEST'
 WHERE id = (SELECT id FROM public.payments WHERE payment_method = 'kbzpay_mmqr' LIMIT 1);
ROLLBACK;

BEGIN;
-- must fail with a check violation: a pinned KBZPay row cannot change method
UPDATE public.payments SET payment_method = 'bank_transfer'
 WHERE id = (SELECT id FROM public.payments WHERE payment_method = 'kbzpay_mmqr' LIMIT 1);
ROLLBACK;
```

Expected: the first fails with `ERROR: payments.kbzpay_merchant is immutable`, and the second with a violation of `payments_kbzpay_merchant_required`. A non-KBZPay row carrying a pin can't be produced through the trigger's INSERT path without an assignment match, so the CHECK is the only guard for that direction. That direction is covered by this second test plus the CHECK definition itself. Then check the authenticated-owner path through PostgREST, signed in on the dev app as a test `owner` of a test tenant (the owner provides a test account; never create one on a non-local host). Each of these must return an error:
- select from `kbzpay_merchant_assignments`;
- insert into `kbzpay_merchant_assignments`;
- update `kbzpay_merchant` on one of that tenant's KBZPay rows (42501);
- insert a `kbzpay_mmqr` payment row for that tenant pinned to a merchant other than its assignment (42501 or a check violation).

**Precondition for the UPDATE check:** the test tenant needs an assignment and at least one pinned KBZPay row. Otherwise the UPDATE matches 0 rows, PostgREST answers 200 with an empty body, and that reads as a pass while proving nothing. Before running it, and only after the owner says yes:
1. Insert an assignment for the test tenant (SQL shown first).
2. Create one order through `claim_kbzpay_order_slot` as `service_role`.

A **200 with an empty result is inconclusive, not a pass**. Re-check that the row exists and is visible to that owner.

The local Supabase stack is **not** faithful here, so these have to run against dev. The trigger has no role exemption, so the owner-role UPDATE test above also covers `service_role`. Afterwards, archive the test enrollment with `archive_internal_test_enrollment` and delete the test assignment (SQL shown first).

---

### Task 10: Brave regression on live UAT (owner runs, Claude assists)

Brave keeps working on the new path. This is rollout step 4 in the spec; the unprefixed vars are removed only after it passes.

- [ ] **Step 1:** In `.env.local`, add `KBZPAY_BRAVE_APPID`, `_MERCH_CODE`, `_APP_KEY` with the same values as the current unprefixed vars, and `KBZPAY_BRAVE_NOTIFY_ORIGIN=https://kbz-uat.kuunyi.com`. Keep the old unprefixed vars for now. Never print the values.
- [ ] **Step 2:** Check the office IP is still allowlisted: `curl -4 --max-time 12 http://api-uat.kbzpay.com/` must connect. Start the tunnel: `cloudflared tunnel --config "$env:USERPROFILE\.cloudflared\kbz-uat.yml" run`.
- [ ] **Step 3:** `npm run dev` on port 3005 with `NEXT_PUBLIC_DEV_TENANT=brave`. Create a 100 MMK order, pay it from the KBZPay UAT test wallet, and use a real inbox for the buyer email.
- [ ] **Step 4:** Expected: precreate returns a QR; the signed callback reaches `/api/webhooks/kbzmmqr` with 200; the payment ends `verified`/`SUCCESS` with `kbzpay_merchant = 'BRAVE'`; the enrollment is `confirmed` and the ticket `valid`.
- [ ] **Step 5:** Only after Step 4 passes, remove the unprefixed `KBZPAY_APPID`, `KBZPAY_MERCH_CODE`, `KBZPAY_APP_KEY` and `KBZPAY_NOTIFY_ORIGIN` from `.env.local`. Archive the test enrollment with `public.archive_internal_test_enrollment(enrollment_id, reason)`; an UPDATE won't work.

Sky Festival (spec rollout step 5) waits for KBZ's credentials and the tenant subdomain. It's an operator step with no code: add `KBZPAY_SKYFEST_*`, insert its assignment, set its `mmqr_provider = 'kbzpay'`, and run the same live UAT on it.

---

## Done when

- `npm test`, `npm run test:db` (local), `npx tsc --noEmit` and `npm run build` all exit 0.
- Task 8 Step 4's two greps print nothing.
- Migration applied to **dev** and Task 9's checks pass (after the owner's yes).
- The Brave live UAT regression passes on the new path.
- A PR into `dev` is open, Codex has reviewed it, and the review and the replies are posted on the PR with their attribution footers. The owner merges.
- **Production is not touched.** It needs the base KBZPay migration plus this one, applied by the owner **before** the code ships.
