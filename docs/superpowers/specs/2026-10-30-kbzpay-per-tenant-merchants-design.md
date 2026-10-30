# KBZPay MMQR — Per-Tenant Merchants — Design

- **Date:** 2026-10-30
- **Status:** Draft — awaiting owner review
- **Builds on:** `docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md`
  (revision 7, "the base spec"). Everything there stands unless this document says otherwise.
- **Driver:** a second KBZPay tenant, Sky Festival (`<slug>.kuunyi.com`, slug TBC), with its
  own KBZPay merchant account.

---

## 1. Context

The KBZPay integration was built for one tenant, `brave` (Louder Myanmar). The provider is
chosen per tenant (`tenants.mmqr_provider = 'kbzpay'`), but **every merchant-specific value
is platform-wide**:

| Value | Read at |
|---|---|
| `KBZPAY_APPID`, `KBZPAY_MERCH_CODE`, `KBZPAY_APP_KEY` | `src/lib/kbzpay.ts` (`APPID()`, `MERCH_CODE()`, `APP_KEY()`) |
| `KBZPAY_APP_KEY` (callback signature) | `src/app/api/webhooks/kbzmmqr/route.ts` |
| `KBZPAY_NOTIFY_ORIGIN` | `src/app/api/public/payments/kbzpay/route.ts` (`notifyOrigin()`) |

So switching a second tenant to `kbzpay` today would create its orders under **Brave's
merchant**, and the buyers' money would settle to Brave. This design makes the merchant a
per-tenant property without weakening any invariant of the base spec.

## 2. Decisions taken during brainstorming

1. **Sky Festival has its own KBZPay merchant.** Sharing Brave's merchant was rejected.
2. **Only the platform operator sets or rotates credentials.** No tenant-admin UI, no
   superadmin UI. Tenant admins never see or influence which merchant they use.
3. **Credentials stay in environment variables**, one named set per merchant. An encrypted
   DB table (the `tenant_bots` AES-256-GCM precedent) was considered and rejected for now: it
   puts the app key in the database and needs an insertion tool, which is not worth it for
   2–3 merchants. Supabase Vault was not considered further — nothing in the repo uses it.
4. **The notify origin stays operator-set** (base spec §7, §9), now per merchant instead of
   per deployment. It is still never derived from the request `Host` or the tenant's domain.
5. **No fallback between merchants, ever.** A tenant with no merchant, or a merchant with a
   missing variable, fails closed. A silent fallback is exactly how one tenant's buyers would
   pay another tenant's account.

## 3. Configuration

Per merchant, where `<ID>` matches `^[A-Z][A-Z0-9_]{1,31}$`:

```
KBZPAY_<ID>_APPID=          # 32-char application id
KBZPAY_<ID>_MERCH_CODE=     # merchant short code
KBZPAY_<ID>_APP_KEY=        # signing key — secret
KBZPAY_<ID>_NOTIFY_ORIGIN=  # e.g. https://brave.kuunyi.com — the host registered with KBZPay for this merchant
```

Examples: `KBZPAY_BRAVE_*`, `KBZPAY_SKYFEST_*`.

Unchanged and still **platform-wide**: `KBZPAY_MODE` (with its fail-closed rules, including
"only `production` on `VERCEL_ENV=production`"), `KBZPAY_PROXY_URL`, the call timeout, and the
IPv4-pinned agent. Mode is a property of the deployment, not of a merchant — mixing UAT and
production merchants in one deployment is not supported.

**Retired:** the unprefixed `KBZPAY_APPID`, `KBZPAY_MERCH_CODE`, `KBZPAY_APP_KEY`,
`KBZPAY_NOTIFY_ORIGIN`. They are not read as a fallback. Their values move into
`KBZPAY_BRAVE_*`.

`KBZPAY_<ID>_NOTIFY_ORIGIN` keeps every validation rule of base spec §9 (https only,
normalised to the origin, malformed rejected) with one change: **an unset or invalid value is
now a configuration error, not a fallback to `platformOrigin()`.** With several merchants,
falling back would send a merchant's callbacks to a host KBZPay has not registered for it.
Locally it can still point at the `kbz-uat.kuunyi.com` tunnel.

Values go into `.env.local` for dev and Vercel env vars for deployed environments, set with
`printf`, never `echo`. `.env.local.example` and base spec §9 are updated to say the same thing
— when a contract changes, every place it is stated changes with it.

## 4. Data model

### 4.1 `public.kbzpay_merchant_assignments` (new)

```sql
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
-- No policies: authenticated and anon can neither read nor write.
REVOKE ALL ON public.kbzpay_merchant_assignments FROM anon, authenticated;
```

**Why a separate table and not a `tenants` column.** The `tenants_update` RLS policy
(`015_staff_policies.sql`) lets an `owner` UPDATE *any* column of their own tenant, and the
admin settings page already writes `payment_mode` and `mmqr_provider` directly from the
browser. A `tenants.kbzpay_merchant` column would therefore be tenant-writable, and an owner
could point their tenant at another organiser's merchant. Decision 2 says the mapping is the
operator's alone, so it lives where only `service_role` can reach it.

One merchant per tenant (`tenant_id` is the primary key). Several tenants *may* share a
merchant; nothing here forbids it, but it is never the default.

Operator changes are plain SQL against the target database, shown before running, per the
project's database rules.

### 4.2 `payments.kbzpay_merchant` (new column)

```sql
ALTER TABLE public.payments ADD COLUMN kbzpay_merchant text;
```

Written once, when a KBZPay order row is inserted, and never changed. It **pins the order to
the merchant that created it**: every later call for that order — `queryorder`, `closeorder`,
the callback signature check — uses this value, not the tenant's current assignment. So
reassigning a tenant mid-sale cannot strand open orders or verify their callbacks with the
wrong key.

A KBZPay row is one with `payment_method = 'kbzpay_mmqr'` — the predicate both RPCs and the
base spec's unique index already use.

Backfill in the same migration: existing KBZPay rows get `'BRAVE'` (only Brave has ever used
KBZPay). Then
`CHECK (payment_method <> 'kbzpay_mmqr' OR kbzpay_merchant IS NOT NULL)` makes the pin
mandatory for KBZPay rows going forward.

**The pin is enforced in the database, not by convention.** The pin decides which
merchant's credentials an order is queried, closed and verified with, so it must not depend
on every writer to `payments` behaving correctly — the same reasoning that keeps the mapping
out of `tenants` (§4.1). If a pin changed after creation, the callback, status poller and
supersede path would query the order under the wrong merchant, get "order not found", and
retire a live or paid order as `FAILED` — the over-collection base spec R5/R13 exist to
prevent. A column-level REVOKE is not a reliable guard, because a table-level UPDATE grant
covers every column. So a `BEFORE INSERT OR UPDATE` trigger,
`protect_payment_kbzpay_merchant()` (same pattern as `protect_internal_test_fields()`):

- **UPDATE:** rejects any change to `kbzpay_merchant` (`IS DISTINCT FROM OLD`) for every
  caller. Written once means written once.
- **INSERT:** a non-null `kbzpay_merchant` must equal the current
  `kbzpay_merchant_assignments.merchant_id` for `NEW.tenant_id`. The lookup runs only when
  the pin is non-null, so other providers' inserts never touch the table. The CHECK above
  already rejects a KBZPay row with no pin.

The function is `SECURITY INVOKER`, like `protect_internal_test_fields()`. Inside the RPCs
it runs as their owner and can read the assignments table. A staff INSERT through PostgREST
that carries a pin fails on the revoked table with `42501` before the comparison. That is
still a refusal, so tests assert an error, not a particular message.

**Migration order is fixed:** add the column → backfill `'BRAVE'` → add the CHECK → create
the trigger. With the trigger in place first, the backfill (a NULL → `'BRAVE'` change) would
be rejected and the migration would abort.

If the operator reassigns a tenant at the same moment an RPC is inserting, the trigger can
see the new assignment and reject the insert, and the route answers `502`. That fails
closed and needs no handling.

### 4.3 RPC changes

`claim_kbzpay_order_slot` and `complete_kbzpay_supersede` (latest definitions in
`20260903090000_payments_platform_fee.sql`) insert the payment rows. Both change so that,
**inside the same transaction**:

1. They read `kbzpay_merchant_assignments` for `p_tenant_id`.
2. No row → return a new outcome `no_merchant`. Where this check sits:
   - **`claim`:** only on the insert path. The `reuse` and `unresolved` branches return the
     existing row with **its pinned merchant**, so removing an assignment never strands an
     order that is already live; it only stops new ones.
   - **`supersede`:** before the `UPDATE ... SET mmqr_status = p_reason` on the old row, so a
     `no_merchant` result changes nothing, like the existing `invalid_enrollment` guard.
3. Otherwise they write `kbzpay_merchant` on the inserted row.
4. They return the merchant as an extra `merchant` column.

The merchant is derived in the database, not passed in by the route, so there is one source
of truth and no window between reading the assignment and pinning it. The argument lists do
not change.

Adding a return column is a change PostgreSQL will not make in place
(`CREATE OR REPLACE` fails with "cannot change return type of existing function"), so the
migration `DROP`s each function and recreates it. Grants are re-applied exactly as now:
`service_role` only, `SECURITY DEFINER` with a pinned `search_path`.

## 5. Code

### 5.1 `src/lib/kbzpay.ts`

- New `getKbzMerchant(id: string): KbzMerchant` returning
  `{ id, appid, merchCode, appKey, notifyOrigin }`. Throws on an id that fails the pattern,
  or on any missing or invalid variable. The error names the variable, never its value.
- `APPID()`, `MERCH_CODE()`, `APP_KEY()` are removed.
- `precreate`, `queryOrder`, `closeOrder` take a `KbzMerchant` as an argument and sign with
  its key. `call()` is otherwise unchanged.
- Like the URL in `resolveMode()`, the merchant is resolved **outside** `call()`'s
  try block, so an operator error throws rather than being laundered into `{ ok: false }`
  (which callers read as "gateway unreachable").

### 5.2 Creation route — `POST /api/public/payments/kbzpay`

- Uses the `merchant` returned by the claim / supersede RPC for `precreate`, and that
  merchant's `notifyOrigin` for the `notify_url`. `notifyOrigin()` with its global env var
  goes away.
- `no_merchant` → `503` with a neutral message ("Payment is not available for this event
  yet"), logged as a configuration error with the tenant id. No KBZPay call is made.
- `getKbzMerchant` throws → `503`, same message, before any KBZPay call. The claimed row stays
  `PENDING` and is resolved on the next request as in base spec R13; it is never marked
  `FAILED` on a config error.
- When superseding, `resolveKbzpayOrder` queries and closes the **old** order with the old
  row's pinned merchant, which is what the claim returns for it.

### 5.3 Callback — `POST /api/webhooks/kbzmmqr`

The order of steps changes, because the key now depends on the order:

| Step | Before | After |
|---|---|---|
| 1 | Parse | Parse |
| 2 | Verify signature with the global key | Look up the payment by `merch_order_id` **and** `payment_method = 'kbzpay_mmqr'` (read-only), selecting `kbzpay_merchant`. The filter means a ref from another provider is "unknown", and the CHECK in §4.2 means every match has a pin |
| 3 | Look up payment | Unknown ref → `404` (unchanged meaning: lets KBZPay's retry resolve a creation race) |
| 4 | `queryorder` | Resolve the pinned merchant; verify the signature with **its** key; also require the callback's `merch_code` to equal the merchant's. Either fails → `403` |
| 5 | Settle | `queryorder` with the pinned merchant, then settle — unchanged |

Rules:

- The signature is checked against **exactly one** key, the pinned merchant's. Never "try
  each merchant's key until one verifies" — that turns every merchant's key into a valid key
  for every order.
- A pinned merchant whose variables are missing → `500` and a loud log, not `403`: the
  callback may be genuine, and a retry after the operator fixes the config should settle it.
- `queryorder` remains the settlement authority (base spec §7). This change only decides
  *which* merchant is asked.

Known trade-off: the lookup now happens before authentication, so an unauthenticated caller
can tell a known `merch_order_id` (403) from an unknown one (404). Order refs carry no
personal data and the response reveals nothing else; keeping 404 for the creation-race retry
is worth more.

### 5.4 Status route and `resolveKbzpayOrder`

`GET /api/public/payments/kbzpay/status` already loads the payment row by ref. It also
selects `kbzpay_merchant` and passes the resolved merchant to `queryOrder`. If the merchant
cannot be resolved (config error), it logs and answers `{ mmqr_status: "PENDING" }`, the
route's existing convention for anything it cannot resolve — never an unhandled 500 to the
poller, and never a terminal status.

`resolveKbzpayOrder` takes the merchant as input and uses it for every query and close.

### 5.5 Unchanged

Settlement (`settleMmqrPayment`), amount and currency checks, the callback response
contract (base spec §8), polling cadence, the QR card, and the KBZPay mark on it.

## 6. Rollout

The order matters in every environment. Each step is safe on its own.

1. **Env vars:** add `KBZPAY_BRAVE_*` with Brave's current values. Leave the old unprefixed
   variables in place until step 4.
2. **Migration:** create the assignments table, add and backfill `payments.kbzpay_merchant`,
   replace both RPCs, and insert the assignment `brave → BRAVE`.
3. **Code:** deploy. Brave now runs through the per-merchant path.
4. **Verify, then clean up:** one live UAT order on Brave (precreate → pay → signed
   callback → queryorder → ticket). Only then remove the unprefixed variables.
5. **Sky Festival:** add `KBZPAY_SKYFEST_*` once KBZPay issues them, insert the assignment
   for its tenant, set its `mmqr_provider` to `kbzpay`, and run a live UAT order on it.

**Production:** has neither the base KBZPay migration nor its code yet, so it takes the base
migration and this one together, **before** the code. As with every migration here, no CI
step applies it — the owner applies it deliberately. Local and dev runs are not evidence
about production.

**Rollback:** a code revert needs **no** migration. The RPC argument lists are unchanged,
the old route reads only `outcome`/`payment_id`/`ref`/`qr` and ignores the extra `merchant`
column, and the new RPCs keep pinning Brave's rows. The old code only needs the unprefixed
variables, which step 4 deliberately keeps until the new path is proven. Do **not** restore
the previous RPC definitions: their INSERTs omit `kbzpay_merchant`, so with the §4.2 CHECK in
place every new KBZPay order would fail.

## 7. Testing

Unit (`src/__tests__/payments/`):

- `getKbzMerchant`: valid set; unknown id; malformed id; each of the four variables missing;
  a non-https or malformed notify origin; the error message never contains a secret value.
- No cross-merchant fallback: with only `BRAVE` configured, resolving `SKYFEST` throws, and
  never returns Brave's credentials.
- Client: `precreate` / `queryOrder` / `closeOrder` sign with the merchant passed in; two
  merchants produce two different signatures for the same payload.
- Creation route: `no_merchant` → 503 with no gateway call; config error → 503, row stays
  `PENDING`; `notify_url` comes from the merchant.
- Callback: a valid signature from the **other** merchant's key → 403; a `merch_code`
  mismatch → 403; the pinned merchant is used even after the tenant's assignment changes;
  unknown ref → 404; missing config for the pinned merchant → 500.
- Status route and supersede use the pinned merchant.
- Status route: config error for the pinned merchant → `PENDING`, no gateway call.
- Existing tests that pin the old globals are rewritten, not deleted:
  `kbzpay-create-route.test.ts` (the `KBZPAY_NOTIFY_ORIGIN` suite — its "falls back to
  `platformOrigin()`" cases become configuration-error cases), `kbzpay-webhook-route.test.ts`
  and `kbzpay-client.test.ts` (global env setup), and `kbzpay-resolve.test.ts`
  (`resolveKbzpayOrder` input). `kbzpay-budget-coverage.test.ts` must keep passing with the
  merchant argument placed before `budget`.
- All KBZPay tests pass; `tsc --noEmit` stays at 0 errors.

Database (dev DB, after the migration):

- Both RPCs exist exactly once; `service_role` can execute them; `anon` and
  `authenticated` cannot.
- An `authenticated` owner cannot select, insert or update `kbzpay_merchant_assignments`.
  Note: the local Supabase stack is not faithful to production here (every public table
  returns 42501 through PostgREST locally), so this check runs against the dev project.
- An `authenticated` owner cannot change `kbzpay_merchant` on their own tenant's payment
  row, and cannot insert a KBZPay row pinned to a merchant other than their assignment
  (trigger, §4.2).
- `service_role` cannot change a pinned `kbzpay_merchant` either.
- Every existing KBZPay payment row has `kbzpay_merchant = 'BRAVE'`.

Live UAT:

- Brave regression (rollout step 4), on-us.
- Sky Festival on its own UAT credentials, on-us, and off-us from another bank's app if KBZ
  can arrange it, as was done for Brave on 2026-09-01.

## 8. Gates and open questions

| Gate | Owner | Status |
|---|---|---|
| Sky Festival tenant slug | Owner | Open |
| Sky Festival UAT `appid`, `merch_code`, app key (and test wallet if different) | KBZPay | Open |
| Is KBZPay's UAT IP allowlist per merchant? If so, register the office IP for Sky Festival | KBZPay | Open |
| Register `https://<slug>.kuunyi.com/api/webhooks/kbzmmqr` (production) and the UAT callback host for Sky Festival's merchant | KBZPay | Open |
| Office IP unchanged since 2026-09-14 (`curl -4 --max-time 12 http://api-uat.kbzpay.com/` connects) | Owner | Check before each UAT run |
| Production: base KBZPay migration + this migration, before the code | Owner | Open — production has neither |

## 9. Out of scope

- Superadmin or tenant-admin UI for KBZPay credentials (decision 2).
- Moving ABank, MMPay, HitPay or PayPay credentials to per-tenant. They stay platform-wide.
- More than one KBZPay merchant per tenant (e.g. per event).
- Refunds — still unsupported, as in the base spec.
