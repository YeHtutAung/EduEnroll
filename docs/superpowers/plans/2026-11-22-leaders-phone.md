# The Leader's Phone (Mode A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An organiser can mark an event "Account-bound tickets". Its tickets can then be bought only by a signed-in buyer. They are shown only on that buyer's signed-in ticket page, and they work at the gate only as a QR that changes every 15 seconds, signed by a key that never leaves the buyer's phone. Every seat stays with the buyer, called "the leader". Sharing seats is Plan 4.

**Three PRs into `dev`:**
- **Part A (Tasks 1–9):** the migration, the bound token and `k2` QR, the scan path, phone binding, and `/account/tickets`. With Part A alone, nothing changes for anyone: no event can be protected yet, because the toggle comes in Part B, and the scan path behaves as before for every unprotected ticket.
- **Part B (Tasks 10–16):**
  - protected checkout;
  - the admin toggle;
  - closing every other place a QR appears;
  - Edit Email refused for account orders;
  - the "Smartphone required" notice.
- **Part C (Tasks 17–21):**
  - the admin read-only account view;
  - the owner's "Move order to another account" (design 4.7);
  - the device-revoke step for account deletion.

Each part branches from `dev` after the previous one merges.

**Architecture:**
- **The order's buyer.** `enrollments.buyer_id` records who bought an order. The submit RPCs take it from the server-verified session and refuse a protected order without one.
- **Binding a phone.** A buyer binds a phone by sending the public half of a non-extractable WebCrypto P-256 key. One SQL function locks the ticket, checks the buyer, revokes the previous phone and records the new one in `ticket_devices`. The route answers with a "bound token": an Ed25519 ticket token, signed with the existing ticket key, that carries the device public key `dk`.
- **The live QR.** The ticket page signs `k2|<jti>|<ts>` with the phone's key every 15 seconds and shows `k2.<bound token>.<ts>.<devsig>`.
- **Scanning.** `/api/scans` checks the envelope, the signatures and the time window before any database read. It then requires the intake to be protected and `dk` to be the ticket's active device key for the order's buyer. A plain token for a protected ticket is refused.

**Tech Stack:** Next.js 14 App Router, Supabase Postgres (RLS, `SECURITY DEFINER` functions), `@supabase/ssr`, Node `crypto` (Ed25519, ECDSA P-256 `ieee-p1363`), browser WebCrypto plus IndexedDB, `qrcode` (already a dependency), Resend (`src/lib/email.ts`), Vitest (`npm test`, `npm run test:db`).

**Spec:** `docs/superpowers/specs/2026-11-20-account-bound-tickets-design.md` ("the design"). Plan 3 covers sections 3, 4.7, 5, 6.1–6.3, 7, 8.1, 9 and 10. Wherever a section mentions sharing, `holder_buyer_id`, share links or `ticket_holder_events`, that part is Plan 4. Until then, the current holder of every seat is `enrollments.buyer_id`.

---

## Decisions this plan makes (record of what the code found, 2026-11-22)

1. **`enrollments.buyer_id` is created here.** Plan 2 left it to "Plan 4, or #451". Plan 3 can't work without it: checkout, binding, the scan and the order move all read it. #451 has not landed, so this plan creates it in the mobile spec's shape:
   - `uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL`;
   - index `(buyer_id, enrolled_at DESC)`;
   - a `p_buyer_id` parameter on both submit RPCs, with the replay rule: the same idempotency key with a different buyer is a conflict.
2. **Account deletion doesn't exist yet.** There is no deletion route, page, sweep or `requireBuyerForDeletion` anywhere. This plan builds only its part of design section 9:
   - the SQL function `revoke_buyer_ticket_devices(buyer)`;
   - a TypeScript wrapper for it.

   Whoever builds deletion (#451 for the app, or a later web story) calls it before `auth.admin.deleteUser`, and from the sweep. The warning text in design section 9 belongs to that work. Task 21 posts both on #451.
3. **The mobile API doesn't exist yet** (`src/app/api/mobile/` is absent). Design section 8.2 binds whichever of this work and #451 lands second. #451 now inherits those rules; Task 21 posts them on #451.
4. **Edit Email is refused for any order that has a `buyer_id`**, not only protected ones. For an account order the email is the identity, on the web and in the app (mobile spec 4.5). The check is simpler, and it is stricter than design 5.5.
5. **The email rule lives in one helper whose return type changes.** `buildEticketEmailAttachment()` is replaced by `buildTicketEmailParts()`, which returns `{ attachment, accountTickets }` and leaves protected tickets out of the PDF. Every caller must handle the new shape, so the compiler finds a caller that forgot. This is the "one shared helper" of design 8.1.
6. **A revoked phone racing an admission.** The scan checks the active device key, then admits with the existing conditional `UPDATE`. A rebind that lands in the milliseconds between the two lets the old phone in once. This is accepted and recorded in design section 13 (Task 16 adds it). Closing it would mean moving admission into SQL, which is out of scope.
7. **Moving an order whose event has no date** is allowed: there is no known end, so nothing to refuse on. Every other refusal in design 4.7 step 4 is implemented.
8. **Scripts on the same site can bind a phone. Decided 2026-11-23: (a), tags off on the whole host.**
   - The bind route answers a signed-in buyer's own browser. The session cookie covers the whole host.
   - So a tenant's tag script on **any** tracked page of that host could call `/api/me/tickets` and the bind route with a key of its own, as could any script injected into that origin. GTM runs on `/enroll`, `/enroll/<slug>` and `/enroll/<slug>/tickets`, for every event (`src/lib/tagManager.ts:30`).
   - Such a call gets a working QR and revokes the buyer's phone. The only signal is the "new phone" email, and a second move within the same 10-minute email window sends no new email (Task 7).
   - The plan always adds a same-origin check (Task 7). That stops sibling tenant subdomains; it can't stop a script on the same origin.

   The options were:
   - **(a)** switch tenant tag scripts off on the **whole host** while that tenant has a protected event. Switching them off only on the protected event's pages leaves the hole open, because every other tracked page is the same origin. This costs that tenant its ad tracking.
   - **(b)** accept the risk and record it in design section 13.

   **The owner chose (a) on 2026-11-23.** What it means:
   - Task 13 step 4 turns off `TenantTagManager` and `AdClickCapture` on the tenant's host while the tenant has a **live** protected event: an intake with `ticket_protection` that has an event not yet ended, by the same end rule `move_order_buyer` uses (Task 1), or no date at all.
   - Once every protected event has ended, the tags come back. Protection can't be switched off on an event with orders, so without the end rule the tags would stay off for good.
   - If the check can't be read, the tags stay off (fail closed).
   - This covers scripts in the browser only. Server-side conversion sends run no code on the host and are not changed by this decision.
   - The organiser should hear before they protect an event that their ad tracking stops on the whole site until it ends. Task 14's helper text says so.
   - Task 16 records the decision in design section 13.

## Not in this plan

- Seat sharing, `tickets.holder_buyer_id`, share links, `/t/claim` and `ticket_holder_events`: Plan 4.
- The mobile `/api/mobile/v1/*` routes and their protected-event rules: #451 (decision 3).
- Account deletion itself: #451 or a later story (decision 2).
- The kuunyi-scanner changes (send `token`, accept `k2.`): that repo. **They block every gate test** (Task 16, Task 21). The QR size spike in Task 16 can use a phone camera QR reader without them.
- An offline page cache (service worker) for the ticket page: a later improvement (design 6.3).
- Anything on `main` or production. The owner froze releases to `main` on 2026-11-21.

---

## Before you start

- **Work in a fresh worktree off `origin/dev`** for each part:
  ```bash
  git fetch origin
  git worktree add ../EduEnroll-wt-leaders-phone-a -b feat/leaders-phone-a origin/dev
  cd ../EduEnroll-wt-leaders-phone-a
  git config user.email   # must print the personal address; stop otherwise
  npm ci                  # real install; never junction node_modules into a worktree
  ```
  Parts B and C use `feat/leaders-phone-b` and `feat/leaders-phone-c`, branched after the previous part merges.
- **Never run `npm run build` while a dev server is running** from the same folder; it corrupts `.next`.
- **Never print, log or commit secrets:** a key, token, bound token, `k2` string, device signature or sign-in code. Refer to secrets by name only. Log lines are fixed strings plus ids and error codes.
- **The local stack is not faithful to hosted grants.** Use `pg` for database tests, as `src/__tests__/db/*.db.test.ts` do. Model new tests on `src/__tests__/db/buyer-accounts.db.test.ts`. Local results are not evidence about the dev project.
- **Migrations.** The next free timestamp is after `20261122120000`. Each migration gets a rollback in `supabase/rollbacks/<name>.down.sql`. Any hash guard on a function body strips `chr(13)`.
- **Adding a parameter to an existing RPC:** `DROP FUNCTION` the exact old signature, `CREATE` the new one, and restate `REVOKE … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role`. `20261022130000_cart_idempotency.sql:18-46` explains why.
- **Buyer routes** answer errors in the mobile spec's shape, through `buyerError()` in `src/lib/buyers/errors.ts`.
- **Admin routes** keep their existing `{ error, message }` shape.
- **The whole-repo verification commands** (Tasks 9, 16 and 21):
  ```
  npx tsc --noEmit; echo TSC=$?
  npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . --ext .ts,.tsx src; echo LINT=$?
  npm test; echo TEST=$?
  npm run test:db; echo DB=$?     # local stack running, migration applied with `npx supabase migration up`
  npm run build; echo BUILD=$?    # no dev server running from this folder
  ```
  Every value must be 0. Judge by the exit code, not the output text.

## File map

| File | Responsibility |
|---|---|
| **Part A** | |
| `supabase/migrations/20261122130000_leaders_phone.sql` | All Plan 3 schema: scope switch, `buyer_id`, submit RPCs, `ticket_devices`, bind, `order_moves`, move, revoke |
| `supabase/rollbacks/20261122130000_leaders_phone.down.sql` | Exact reverse |
| `src/types/database.ts` (modify) | New columns, tables and functions |
| `src/lib/tickets/sign.ts` (modify) | Shared signer; `signBoundTicket()`; `verifyTicketJwt()` unchanged |
| `src/lib/tickets/k2.ts` | Parse and verify a `k2` QR: bound token, device signature, time window |
| `src/server/buyers/rateLimit.ts` | `consumeRateLimit(key, windowSeconds, limit)` over the Plan 2 RPC |
| `src/app/api/scans/route.ts` (modify) | Protected path |
| `src/app/api/me/tickets/route.ts` | `GET`: this tenant's account tickets for the signed-in buyer |
| `src/app/api/me/tickets/[id]/device/route.ts` | `POST`: bind this phone, return the bound token |
| `src/lib/email.ts` (modify) | `ticketNewPhoneEmail()` |
| `src/lib/tickets/deviceKey.ts` | Browser only: key in IndexedDB, bound token cache, `k2` signing |
| `src/app/(public)/account/tickets/page.tsx` | Ticket list |
| `src/app/(public)/account/tickets/[id]/page.tsx` + `LiveTicket.tsx` | Live QR |
| **Part B** | |
| `src/app/api/public/enroll/route.ts` (modify) | Protected intake → buyer required, buyer email forced, `p_buyer_id` passed |
| `src/server/enrollment/createEnrollment.ts`, `createCartEnrollment.ts` (modify) | Pass `p_buyer_id` |
| `src/server/enrollment/protection.ts` | `protectedClassIds(classIds)`: which classes sit on protected intakes |
| `src/app/api/public/enroll/[slug]/route.ts` (modify) | Expose `ticket_protection` |
| `src/app/api/public/enrollment/[ref]/route.ts` (modify) | Omit protected tickets; PATCH keeps the buyer email |
| `src/app/(public)/account/accountFlow.ts`, `AccountSignIn.tsx` (modify) | `?next=` after sign-in |
| `src/app/(public)/enroll/form/page.tsx`, `[slug]/checkout/**` (modify) | Sign-in gate, read-only email, notice |
| `src/app/api/intakes/[id]/route.ts`, `src/app/admin/intakes/[id]/page.tsx` (modify) | The toggle |
| `src/server/tickets/eticketEmailAttachment.ts` (modify) | `buildTicketEmailParts()` |
| The six email callers (modify) | Use the parts, add "Open My Tickets" |
| `src/server/tickets/qrExport.ts` (modify) | No QR text for protected tickets |
| `src/app/api/admin/enrollments/[id]/email/route.ts`, `src/app/admin/students/page.tsx` (modify) | Edit Email refused / hidden |
| **Part C** | |
| `src/app/api/admin/enrollments/[id]/account/route.ts` | `GET`: read-only buyer, phone and move history |
| `src/app/api/admin/enrollments/[id]/move-buyer/route.ts` | `POST`: owner-only order move |
| `src/lib/maskEmail.ts` | `k***@gmail.com` |
| `src/server/buyers/revokeTicketDevices.ts` | Deletion step wrapper |
| `src/app/admin/students/page.tsx` (modify) | Account section and move form in the order modal |

---

# Part A — data, the live QR and the scan

### Task 1: Migration — every Plan 3 table and function

**Files:**
- Create: `supabase/migrations/20261122130000_leaders_phone.sql`
- Create: `supabase/rollbacks/20261122130000_leaders_phone.down.sql`
- Test: `src/__tests__/migrations/leadersPhone.test.ts` (static), `src/__tests__/db/leaders-phone.db.test.ts` (database)

The migration is one file (design section 10): the RPC changes, the bind function and the move function share the same columns.

- [ ] **Step 1: Write the static test**

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");
const UP = read("supabase", "migrations", "20261122130000_leaders_phone.sql");
const DOWN = read("supabase", "rollbacks", "20261122130000_leaders_phone.down.sql");

const FUNCTIONS = [
  "submit_enrollment(uuid, text, integer, text, uuid)",
  "submit_cart_enrollment(jsonb, uuid, text, text, uuid)",
  "bind_ticket_device(uuid, uuid, uuid, text)",
  "move_order_buyer(uuid, uuid, uuid, uuid, text)",
  "revoke_buyer_ticket_devices(uuid)",
];

describe("leaders_phone migration", () => {
  it.each(FUNCTIONS)("%s is service-role only", (sig) => {
    expect(UP).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
    expect(UP).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
  });

  it.each(["ticket_devices", "order_moves"])("%s has RLS on and no policies", (t) => {
    expect(UP).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
    expect(UP).toContain(`REVOKE ALL ON public.${t} FROM PUBLIC, anon, authenticated;`);
    expect(UP).not.toMatch(new RegExp(`CREATE POLICY[^;]*ON public\\.${t}`));
  });

  it("drops the old submit signatures before creating the new ones", () => {
    expect(UP).toContain("DROP FUNCTION public.submit_enrollment(uuid, text, integer, text);");
    expect(UP).toContain("DROP FUNCTION public.submit_cart_enrollment(jsonb, uuid, text, text);");
  });

  it("fixes the protection to jwt intakes and locks it once ordered", () => {
    expect(UP).toMatch(/CHECK \(NOT ticket_protection OR ticket_qr_format = 'jwt'\)/);
    expect(UP).toContain("ticket_protection_locked");
  });

  it("the rollback restores the old submit signatures and drops everything new", () => {
    for (const s of ["submit_enrollment(uuid, text, integer, text)", "submit_cart_enrollment(jsonb, uuid, text, text)"]) {
      expect(DOWN).toContain(`GRANT EXECUTE ON FUNCTION public.${s} TO service_role;`);
    }
    for (const o of ["ticket_devices", "order_moves"]) expect(DOWN).toContain(`DROP TABLE public.${o}`);
    expect(DOWN).toContain("DROP COLUMN buyer_id");
    expect(DOWN).toContain("DROP COLUMN ticket_protection");
  });
});
```

  Run: `npx vitest run src/__tests__/migrations/leadersPhone.test.ts`. Expected: FAIL (the files don't exist).

- [ ] **Step 2: Write the migration**

  Wrap the migration in `BEGIN; … COMMIT;`. Sections, in order:

  **2a. Scope switch (design 3)**

```sql
ALTER TABLE public.intakes
  ADD COLUMN ticket_protection boolean NOT NULL DEFAULT false;

ALTER TABLE public.intakes
  ADD CONSTRAINT intakes_ticket_protection_needs_jwt
  CHECK (NOT ticket_protection OR ticket_qr_format = 'jwt');

-- The flag can change only while the intake has no orders, single or cart.
-- SECURITY DEFINER: PATCH /api/intakes/[id] updates through the owner's RLS
-- client; the lock must see every order whatever that client can read.
CREATE FUNCTION public.intakes_lock_ticket_protection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.ticket_protection IS DISTINCT FROM OLD.ticket_protection AND (
       EXISTS (SELECT 1 FROM public.enrollments e
                 JOIN public.classes c ON c.id = e.class_id
                WHERE c.intake_id = NEW.id)
    OR EXISTS (SELECT 1 FROM public.enrollment_items ei
                 JOIN public.classes c ON c.id = ei.class_id
                WHERE c.intake_id = NEW.id)
  ) THEN
    RAISE EXCEPTION 'ticket_protection_locked' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER intakes_lock_ticket_protection
  BEFORE UPDATE OF ticket_protection ON public.intakes
  FOR EACH ROW EXECUTE FUNCTION public.intakes_lock_ticket_protection();
```

  **2b. The order's buyer (decision 1)**

```sql
ALTER TABLE public.enrollments
  ADD COLUMN buyer_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX enrollments_buyer_id_enrolled_at_idx
  ON public.enrollments (buyer_id, enrolled_at DESC)
  WHERE buyer_id IS NOT NULL;
```

  **2c. Submit RPCs take `p_buyer_id`.** For each of `submit_enrollment` and `submit_cart_enrollment`:
  1. Copy the **current** body verbatim:
     - `submit_enrollment` from `supabase/migrations/20261022120000_priority_link_single_purchase.sql:82` onwards;
     - `submit_cart_enrollment` from `supabase/migrations/20261022130000_cart_idempotency.sql:38` onwards.
  2. `DROP FUNCTION` the old signature, shown in the static test.
  3. Create the new function with `p_buyer_id uuid DEFAULT NULL` as its **last** parameter.
  4. Add exactly these changes and nothing else.

  **Both functions end in `EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success', false, 'error', 'INTERNAL_ERROR', …)`, so a `RAISE` never reaches the caller.** Report refusals the way the functions already do: `RETURN jsonb_build_object('success', false, 'error', '<CODE>')`.

```sql
-- declarations
  v_protected boolean;
  v_buyer_email text;

-- before the idempotent-replay lookup.
-- Lock first, in its own statement: Postgres refuses FOR SHARE together with
-- an aggregate. The share lock stops an owner switching protection on while a
-- guest order is in flight (the trigger's UPDATE waits for it). Side effect:
-- during an on-sale, an admin edit of the intake waits for in-flight checkouts.
  PERFORM 1
    FROM public.intakes i JOIN public.classes c ON c.intake_id = i.id
   WHERE c.id = p_class_id
     FOR SHARE OF i;

  SELECT coalesce(bool_or(i.ticket_protection), false) INTO v_protected
    FROM public.classes c JOIN public.intakes i ON i.id = c.intake_id
   WHERE c.id = p_class_id;
-- Cart: the same two statements, each with
--   WHERE c.id IN (SELECT x.class_id FROM jsonb_to_recordset(p_items) AS x(class_id uuid))
-- NOT jsonb_array_elements(p_items): the cart migration's fail-closed DO $$
-- block requires exactly one occurrence of that call in the body
-- (20261022130000_cart_idempotency.sql:356-359).

  IF v_protected AND p_buyer_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'BUYER_REQUIRED');
  END IF;

  IF p_buyer_id IS NOT NULL THEN
    SELECT bp.email INTO v_buyer_email
      FROM public.buyer_profiles bp
     WHERE bp.id = p_buyer_id AND bp.deleted_at IS NULL;
    IF v_buyer_email IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'BUYER_REQUIRED');
    END IF;
  END IF;

-- inside the idempotent replay, before returning the existing order
-- (select buyer_id along with the columns the replay already reads)
  IF <existing row>.buyer_id IS DISTINCT FROM p_buyer_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'IDEMPOTENCY_CONFLICT');
  END IF;

-- in the INSERT INTO public.enrollments column list and VALUES
  buyer_id = p_buyer_id,
  email    = coalesce(v_buyer_email, <the value the INSERT writes today, or NULL>)
-- The draft path (checkout/new) posts no form_data, so the RPC is the only
-- place the account email is guaranteed to land on the order.
```

  Then:
  - Restate the grants for the new signatures.
  - Keep the cart migration's fail-closed `DO $$` assertion, and extend it to also require `p_buyer_id` in the body, still with exactly one `jsonb_array_elements(p_items)`.
  - End with `NOTIFY pgrst, 'reload schema';`, as the cart migration does, because the signatures change.
  - Add `BUYER_REQUIRED` and `IDEMPOTENCY_CONFLICT` to the closed `error` unions of `SubmitEnrollmentResult` and `SubmitCartEnrollmentResult` in `src/types/database.ts` (`:55-77`); without that, the new `case` labels fail `tsc` (TS2678).
  - Add both codes to `mapEnrollmentError` in `src/server/enrollment/createEnrollment.ts` and to the cart helper's mapper, in this task. They return codes the route maps in Task 12.

  **2d. `ticket_devices` and the bind function (design 6.1)**

```sql
CREATE TABLE public.ticket_devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  buyer_id    uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  -- raw uncompressed P-256 point, 65 bytes, base64url without padding = 87 chars
  public_key  text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{87}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz NULL,
  revoked_by  text NULL CHECK (revoked_by IN ('rebind', 'holder_changed', 'account_deleted', 'order_moved')),
  CONSTRAINT ticket_devices_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX ticket_devices_one_active ON public.ticket_devices (ticket_id) WHERE revoked_at IS NULL;
CREATE INDEX ticket_devices_active_by_buyer ON public.ticket_devices (buyer_id) WHERE revoked_at IS NULL;
ALTER TABLE public.ticket_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ticket_devices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ticket_devices FROM service_role;   -- Supabase default privileges grant ALL
GRANT SELECT, INSERT, UPDATE ON public.ticket_devices TO service_role;   -- never DELETE: the audit trail

-- 'bound_first' | 'bound_again' | 'unchanged' | 'refused'. One generic refusal.
CREATE FUNCTION public.bind_ticket_device(
  p_ticket_id uuid, p_tenant_id uuid, p_buyer_id uuid, p_public_key text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_t       record;
  v_active  text;
  v_first   boolean;
BEGIN
  IF p_ticket_id IS NULL OR p_tenant_id IS NULL OR p_buyer_id IS NULL
     OR p_public_key IS NULL OR p_public_key !~ '^[A-Za-z0-9_-]{87}$' THEN
    RETURN 'refused';
  END IF;

  -- Same lock order as move_order_buyer (enrollment, then ticket), so a bind
  -- queued behind a move wakes up after it and reads the new buyer.
  PERFORM 1 FROM public.enrollments e
    JOIN public.tickets t ON t.enrollment_id = e.id
   WHERE t.id = p_ticket_id
     FOR SHARE OF e;   -- waits behind a move's FOR UPDATE; doesn't block inserts referencing the order
  PERFORM 1 FROM public.tickets WHERE id = p_ticket_id FOR UPDATE;   -- serialises two binds

  -- A separate statement after the locks: a fresh READ COMMITTED snapshot.
  SELECT t.tenant_id, t.status, e.buyer_id, e.status::text AS order_status, i.ticket_protection
    INTO v_t
    FROM public.tickets t
    JOIN public.enrollments e ON e.id = t.enrollment_id
    JOIN public.intakes i ON i.id = t.intake_id
   WHERE t.id = p_ticket_id;

  IF NOT FOUND
     OR v_t.tenant_id <> p_tenant_id
     OR v_t.status <> 'valid'
     OR v_t.order_status <> 'confirmed'
     OR NOT v_t.ticket_protection
     OR v_t.buyer_id IS DISTINCT FROM p_buyer_id
  THEN
    RETURN 'refused';
  END IF;

  SELECT public_key INTO v_active
    FROM public.ticket_devices
   WHERE ticket_id = p_ticket_id AND revoked_at IS NULL;

  IF v_active = p_public_key THEN
    RETURN 'unchanged';
  END IF;

  v_first := NOT EXISTS (
    SELECT 1 FROM public.ticket_devices WHERE ticket_id = p_ticket_id AND buyer_id = p_buyer_id);

  UPDATE public.ticket_devices
     SET revoked_at = now(), revoked_by = 'rebind'
   WHERE ticket_id = p_ticket_id AND revoked_at IS NULL;

  INSERT INTO public.ticket_devices (ticket_id, buyer_id, public_key)
  VALUES (p_ticket_id, p_buyer_id, p_public_key);

  RETURN CASE WHEN v_first THEN 'bound_first' ELSE 'bound_again' END;
END;
$$;
```

  **2e. Order moves (design 4.7)**

```sql
CREATE TABLE public.order_moves (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id  uuid NOT NULL REFERENCES public.enrollments(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  from_buyer_id  uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  to_buyer_id    uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  moved_by       uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  reason         text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_moves_enrollment_idx ON public.order_moves (enrollment_id, created_at DESC);
ALTER TABLE public.order_moves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_moves FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.order_moves FROM service_role;   -- Supabase default privileges grant ALL
GRANT SELECT, INSERT ON public.order_moves TO service_role;   -- never updated or deleted

-- Returns ('moved', old buyer) or ('refused', NULL). One generic refusal.
CREATE FUNCTION public.move_order_buyer(
  p_enrollment_id uuid, p_tenant_id uuid, p_staff_user_id uuid, p_to_buyer_id uuid, p_reason text)
RETURNS TABLE (result text, from_buyer_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_e     record;
  v_last  date;
BEGIN
  IF p_enrollment_id IS NULL OR p_tenant_id IS NULL OR p_staff_user_id IS NULL OR p_to_buyer_id IS NULL
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid; RETURN;
  END IF;

  SELECT e.id, e.tenant_id, e.status::text AS status, e.buyer_id, e.class_id
    INTO v_e
    FROM public.enrollments e
   WHERE e.id = p_enrollment_id
     FOR UPDATE;

  IF NOT FOUND
     OR v_e.tenant_id <> p_tenant_id
     OR v_e.status <> 'confirmed'
     OR v_e.buyer_id IS NULL
     OR v_e.buyer_id = p_to_buyer_id
     OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_staff_user_id AND u.tenant_id = p_tenant_id)
     OR NOT EXISTS (SELECT 1 FROM public.buyer_profiles bp WHERE bp.id = p_to_buyer_id AND bp.deleted_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_to_buyer_id)
  THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid; RETURN;
  END IF;

  -- Last day across the order's classes (single or cart). end_time is the END DATE.
  SELECT max(greatest(c.event_date, coalesce(c.end_time, c.event_date)))
    INTO v_last
    FROM public.classes c
   WHERE c.id = v_e.class_id
      OR c.id IN (SELECT ei.class_id FROM public.enrollment_items ei WHERE ei.enrollment_id = v_e.id);

  IF v_last IS NOT NULL AND v_last < (now() AT TIME ZONE 'Asia/Yangon')::date THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid; RETURN;
  END IF;

  PERFORM 1 FROM public.tickets t WHERE t.enrollment_id = v_e.id FOR UPDATE;

  UPDATE public.ticket_devices d
     SET revoked_at = now(), revoked_by = 'order_moved'
    FROM public.tickets t
   WHERE t.enrollment_id = v_e.id AND d.ticket_id = t.id AND d.revoked_at IS NULL;

  UPDATE public.enrollments SET buyer_id = p_to_buyer_id WHERE id = v_e.id;

  INSERT INTO public.order_moves (enrollment_id, tenant_id, from_buyer_id, to_buyer_id, moved_by, reason)
  VALUES (v_e.id, p_tenant_id, v_e.buyer_id, p_to_buyer_id, p_staff_user_id, btrim(p_reason));

  RETURN QUERY SELECT 'moved'::text, v_e.buyer_id;
END;
$$;
```

  `classes.end_time` is a DATE (migration 031, confirmed in review 2026-11-22), so `greatest()` is safe. The `'Asia/Yangon'` here and in design 6.4 must equal the app's `TICKET_TZ` default; the database test asserts it (case 13).

  **2f. Deletion step (design 9, decision 2)**

```sql
-- Idempotent. Returns the number of rows revoked.
CREATE FUNCTION public.revoke_buyer_ticket_devices(p_buyer_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE public.ticket_devices
     SET revoked_at = now(), revoked_by = 'account_deleted'
   WHERE buyer_id = p_buyer_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
```

  **2g. Grants:** the `REVOKE ALL … FROM PUBLIC, anon, authenticated` and `GRANT EXECUTE … TO service_role` pair for each of the five signatures in the static test.

- [ ] **Step 3: Write the rollback**

  `supabase/rollbacks/20261122130000_leaders_phone.down.sql` reverses it:
  - drop the three new functions, then `order_moves` and `ticket_devices`;
  - drop the new submit signatures and recreate the old ones, copied from the two source migrations, with their grants;
  - drop the trigger, its function and the constraint;
  - `ALTER TABLE public.enrollments DROP COLUMN buyer_id;` and `ALTER TABLE public.intakes DROP COLUMN ticket_protection;`.

  Run the static test. Expected: PASS.

- [ ] **Step 4: Write the database test**

  `src/__tests__/db/leaders-phone.db.test.ts`, modelled on `buyer-accounts.db.test.ts`: a `pg` pool as the superuser, with fixtures inserted directly in `beforeAll` and removed in `afterAll`. Fixtures:
  - tenants T1 and T2;
  - a protected `jwt` intake and an unprotected intake on T1, each with a class (`event_date` = today + 10 days, Yangon);
  - buyer users B1 and B2 (`auth.users` plus `buyer_profiles`), and staff S1 (`auth.users` plus `users` on T1);
  - a confirmed order on the protected intake with `buyer_id` B1 and two `tickets` rows.

  Cases (one `it` each):
  1. Toggling `ticket_protection` on an intake with an order raises `ticket_protection_locked`. On a fresh intake with no order it succeeds.
  2. `ticket_protection = true` on a `uuid` intake violates `intakes_ticket_protection_needs_jwt` (23514).
  3. `submit_enrollment` on the protected class (the RPCs return jsonb; assert on `->>'error'`):
     - with `p_buyer_id` NULL → `BUYER_REQUIRED`, and no row is created;
     - with B1 → success, `enrollments.buyer_id = B1` and `enrollments.email` = B1's profile email;
     - replay of the same key with B2 → `IDEMPOTENCY_CONFLICT`;
     - replay with B1 → the same order.
  4. `submit_cart_enrollment` with one protected and one unprotected item and no buyer → `BUYER_REQUIRED`.
  4b. **Regression:** an unprotected single order and an unprotected cart order, with no buyer, both succeed exactly as before (`success: true`). This catches any SQL error the `EXCEPTION WHEN OTHERS` handler would turn into `INTERNAL_ERROR`.
  5. `submit_enrollment` with a `p_buyer_id` whose profile has `deleted_at` set → `BUYER_REQUIRED`.
  6. Binding:
     - `bind_ticket_device` by B1 → `bound_first`;
     - the same key → `unchanged`;
     - a second key → `bound_again`, leaving exactly one active row whose key is the second, and the first row revoked with `rebind`;
     - 20 binds in a row, all succeeding, leave one active row.
  7. Bind refused (`refused`) for each of:
     - B2;
     - tenant T2;
     - a `void` ticket;
     - a ticket on the unprotected intake;
     - an order that isn't confirmed;
     - a malformed key (86 chars).
  8. **Two concurrent binds** leave exactly one active row:
     1. Client 1: `BEGIN`, bind key A.
     2. Client 2: start a bind of key B **without awaiting it**; it blocks on the row lock.
     3. Commit client 1, then await client 2's bind and commit.

     Awaiting client 2 before client 1 commits would hang the test.
  8b. **A move racing a bind**, in the same pattern:
     1. Client 1: `BEGIN`, `move_order_buyer` to B2.
     2. Client 2: start B1's bind without awaiting it.
     3. Commit client 1.

     Client 2's bind returns `refused`, and no active row belongs to B1.
  9. Moving the order:
     - `move_order_buyer(order, T1, S1, B2, 'lost mailbox')` → `('moved', B1)`;
     - `enrollments.buyer_id = B2`;
     - every active device row is revoked with `order_moved`;
     - one `order_moves` row is written;
     - afterwards B1's bind is `refused` and B2's is `bound_first`.
  10. Move refused (`refused`, nothing changed) for each of:
      - tenant T2;
      - an unconfirmed order;
      - `buyer_id` NULL;
      - a target that is staff;
      - a target with no live profile;
      - the target being the current buyer;
      - S1 on another tenant;
      - an event that ended yesterday;
      - an empty reason.
  11. `revoke_buyer_ticket_devices(B2)` returns the number of active rows and revokes them with `account_deleted`. A second call returns 0.
  12. As the role `authenticated` (`SET LOCAL ROLE authenticated` inside a rolled-back transaction), each of these fails with `42501`:
      - `SELECT` on `ticket_devices`;
      - `SELECT` on `order_moves`;
      - `EXECUTE` of each of the five functions.

  13. The time zone in `move_order_buyer`'s body equals the app's `TICKET_TZ` default. Read `prosrc` with `replace(prosrc, chr(13), '')`, and compare it with the default exported from `src/lib/tickets/exp.ts`; export it there if it isn't already.
  14. `service_role` has no `DELETE` on `ticket_devices` and no `UPDATE`/`DELETE` on `order_moves` (`has_table_privilege`).

  **Caveat for cases 12 and 14.** `src/__tests__/db/setup.ts` re-grants table DML to `anon` and `authenticated`, and grants `DELETE` on all tables to `service_role` (`:91-92`). If case 12's table `SELECT` or case 14's privilege check fails locally only because of that setup, assert what the setup doesn't touch (the function `EXECUTE` cases, RLS returning zero rows), and leave the table grants to the dev-DB check in Task 9 step 4.2. Do **not** weaken the migration or the setup to make a local test pass.

- [ ] **Step 5: Apply locally and run**

  Run:
  ```
  npx supabase migration up
  npm run test:db -- leaders-phone
  npm run test:db
  ```
  Expected: PASS, and the full database suite still passes (the old submit callers send no `p_buyer_id`).

- [ ] **Step 6: Commit**
```bash
git add supabase/migrations/20261122130000_leaders_phone.sql supabase/rollbacks/20261122130000_leaders_phone.down.sql src/__tests__/migrations/leadersPhone.test.ts src/__tests__/db/leaders-phone.db.test.ts src/server/enrollment/createEnrollment.ts src/server/enrollment/createCartEnrollment.ts src/lib/tickets/exp.ts src/types/database.ts
git commit -m "feat(db): account-bound tickets — buyer on the order, ticket_devices, bind, order move"
```

---

### Task 2: Types

**Files:** Modify `src/types/database.ts`.

- [ ] **Step 1:** Add:
  - `ticket_protection: boolean` to `Intake`;
  - `buyer_id: string | null` to the enrollments row type;
  - `TicketDevice` and `OrderMove` row types, and table entries for both;
  - `Functions` entries for `bind_ticket_device` (returns `"bound_first" | "bound_again" | "unchanged" | "refused"`), `move_order_buyer` (returns `{ result: "moved" | "refused"; from_buyer_id: string | null }[]`) and `revoke_buyer_ticket_devices` (returns `number`).

  While there, bring the two submit entries up to date with every real parameter. They currently lack `p_priority_token_hash` and the cart's `p_idempotency_key`; add those and `p_buyer_id?: string | null`. Don't touch other types.
- [ ] **Step 2:** `npx tsc --noEmit`. Expected: 0. Commit: `chore(types): account-bound ticket tables and functions`.

---

### Task 3: Bound ticket token

**Files:**
- Modify: `src/lib/tickets/sign.ts`
- Test: `src/__tests__/lib/tickets/boundToken.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync } from "crypto";

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  process.env.TICKET_KID = "test-kid";
});

const DK = "B" + "A".repeat(86); // shape only; the token doesn't parse the point

describe("bound ticket token", () => {
  it("carries typ bound and dk, and verifies with the ticket key", async () => {
    const { signBoundTicket, verifyTicketJwt } = await import("@/lib/tickets/sign");
    const t = signBoundTicket({ jti: "t1", eid: "i1", tier: "VIP", admits: 1, exp: 2_000_000_000 }, DK);
    const c = verifyTicketJwt(t) as unknown as Record<string, unknown>;
    expect(c).toMatchObject({ jti: "t1", eid: "i1", typ: "bound", dk: DK });
  });

  it("plain tokens still have no typ", async () => {
    const { signTicketJwt, verifyTicketJwt } = await import("@/lib/tickets/sign");
    const c = verifyTicketJwt(signTicketJwt({ jti: "t1", eid: "i1", tier: "VIP", admits: 1, exp: 1 }));
    expect((c as unknown as Record<string, unknown>).typ).toBeUndefined();
  });
});
```

  Run it. Expected: FAIL (`signBoundTicket` is not exported).

- [ ] **Step 2: Implement.** In `sign.ts`, move the body of `signTicketJwt` into a private `signPayload(payload: object): string`. Then:

```ts
export function signTicketJwt(claims: TicketClaims): string {
  return signPayload(claims);
}

export interface BoundTicketClaims extends TicketClaims {
  typ: "bound";
  /** The device's raw P-256 public key, base64url (87 chars). */
  dk: string;
}

/** Design 6.1: the token a bound phone keeps. Same key and format as a plain ticket token. */
export function signBoundTicket(claims: TicketClaims, dk: string): string {
  const payload: BoundTicketClaims = { ...claims, typ: "bound", dk };
  return signPayload(payload);
}
```

  `verifyTicketJwt` is unchanged; its return type stays `TicketClaims`. Callers that need `typ`/`dk` read them from the parsed object (Task 4).
- [ ] **Step 3:** Run the test, then the existing ticket tests (`npx vitest run src/__tests__/tickets`). Expected: PASS. Commit: `feat(tickets): bound ticket token`.

---

### Task 4: The `k2` QR

**Files:**
- Create: `src/lib/tickets/k2.ts`
- Test: `src/__tests__/lib/tickets/k2.test.ts`

Design 6.2 and 7 steps 1–3. All of it is pure; no database.

- [ ] **Step 1: Write the failing test.** Generate the device key with **WebCrypto** (`globalThis.crypto.subtle`, which Node has), exactly as the browser does. That proves the formats interoperate.

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync } from "crypto";

const subtle = globalThis.crypto.subtle;
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as ArrayBuffer).toString("base64url");

let pair: CryptoKeyPair;
let dk: string;

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  process.env.TICKET_KID = "test-kid";
  pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  dk = b64u(await subtle.exportKey("raw", pair.publicKey));
});

async function qr(jti: string, ts: string, key = pair.privateKey, dkOverride?: string) {
  const { signBoundTicket } = await import("@/lib/tickets/sign");
  const token = signBoundTicket({ jti, eid: "i1", tier: "VIP", admits: 1, exp: 2_000_000_000 }, dkOverride ?? dk);
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`k2|${jti}|${ts}`));
  return `k2.${token}.${ts}.${b64u(sig)}`;
}

describe("verifyK2", () => {
  const NOW = 1_800_000_000;

  it("accepts a fresh QR and returns the claims and dk", async () => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    const r = verifyK2(await qr("t1", String(NOW)), NOW);
    expect(r).toMatchObject({ claims: { jti: "t1", eid: "i1" }, dk });
  });

  it.each([
    ["20 s old", NOW - 20, true],
    ["21 s old", NOW - 21, false],
    ["10 s ahead", NOW + 10, true],
    ["11 s ahead", NOW + 11, false],
  ])("window: %s", async (_n, ts, ok) => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    expect(verifyK2(await qr("t1", String(ts)), NOW) !== null).toBe(ok);
  });

  it.each(["0" + NOW, "+" + NOW, NOW + ".0", ""])("rejects a non-canonical ts %j", async (ts) => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    expect(verifyK2(await qr("t1", ts), NOW)).toBeNull();
  });

  it("rejects a wrong segment count, a plain token and a missing prefix", async () => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    const good = await qr("t1", String(NOW));
    expect(verifyK2(good + ".x", NOW)).toBeNull();
    expect(verifyK2(good.slice(3), NOW)).toBeNull();
    expect(verifyK2(good.split(".").slice(0, 5).join("."), NOW)).toBeNull();
  });

  it("rejects a signature by another key, or over another jti", async () => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    const other = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])) as CryptoKeyPair;
    expect(verifyK2(await qr("t1", String(NOW), other.privateKey), NOW)).toBeNull();
    const a = (await qr("t1", String(NOW))).split(".");
    const b = (await qr("t2", String(NOW))).split(".");
    expect(verifyK2([...a.slice(0, 5), b[5]].join("."), NOW)).toBeNull();
  });

  it("rejects a plain (unbound) ticket token inside the envelope", async () => {
    const { signTicketJwt } = await import("@/lib/tickets/sign");
    const { verifyK2 } = await import("@/lib/tickets/k2");
    const token = signTicketJwt({ jti: "t1", eid: "i1", tier: "VIP", admits: 1, exp: 2_000_000_000 });
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`k2|t1|${NOW}`));
    expect(verifyK2(`k2.${token}.${NOW}.${b64u(sig)}`, NOW)).toBeNull();
  });

  it("rejects a dk that is not a P-256 point", async () => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    expect(verifyK2(await qr("t1", String(NOW), pair.privateKey, "B" + "A".repeat(86)), NOW)).toBeNull();
  });

  it("isK2 tells the envelope apart from a plain token", async () => {
    const { isK2 } = await import("@/lib/tickets/k2");
    expect(isK2("k2.a.b.c.d.e")).toBe(true);
    expect(isK2("eyJ.a.b")).toBe(false);
  });
});
```

  Run it. Expected: FAIL (the module is missing).

- [ ] **Step 2: Implement `src/lib/tickets/k2.ts`**

```ts
import { createPublicKey, verify as nodeVerify } from "crypto";
import { verifyTicketJwt, type TicketClaims } from "./sign";

// Design 6.2 / 7: k2.<bound token (3 segments)>.<ts>.<devsig>. Pure: no I/O.
// Every failure is null, so the caller answers one indistinguishable 404.

export const K2_PAST_SECONDS = 20;
export const K2_FUTURE_SECONDS = 10;
const TS = /^(0|[1-9][0-9]{0,11})$/;          // canonical decimal, no sign, no leading zero
const DK = /^[A-Za-z0-9_-]{87}$/;             // 65-byte raw point, base64url

export const isK2 = (token: string): boolean => token.startsWith("k2.");

/** The text the phone signs. Exported so the browser module can't drift from it. */
export const k2SignedText = (jti: string, ts: string): string => `k2|${jti}|${ts}`;

export interface VerifiedK2 {
  claims: TicketClaims;
  dk: string;
}

function p256Key(dk: string) {
  const raw = Buffer.from(dk, "base64url");
  if (raw.length !== 65 || raw[0] !== 0x04) return null;
  try {
    return createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
  } catch {
    return null; // not a point on the curve
  }
}

export function verifyK2(qr: string, nowSeconds: number): VerifiedK2 | null {
  const parts = qr.split(".");
  if (parts.length !== 6 || parts[0] !== "k2") return null;
  const [, h, p, s, ts, devsig] = parts;

  let claims: TicketClaims & { typ?: unknown; dk?: unknown };
  try {
    claims = verifyTicketJwt(`${h}.${p}.${s}`) as TicketClaims & { typ?: unknown; dk?: unknown };
  } catch {
    return null;
  }
  if (claims.typ !== "bound" || typeof claims.dk !== "string" || !DK.test(claims.dk)) return null;
  if (typeof claims.jti !== "string" || typeof claims.eid !== "string") return null;

  if (!TS.test(ts)) return null;
  const t = Number(ts);
  if (t < nowSeconds - K2_PAST_SECONDS || t > nowSeconds + K2_FUTURE_SECONDS) return null;

  const key = p256Key(claims.dk);
  if (!key) return null;
  let ok = false;
  try {
    ok = nodeVerify(
      "sha256",
      Buffer.from(k2SignedText(claims.jti, ts), "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(devsig, "base64url"),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  const { jti, eid, tier, admits, exp } = claims;
  return { claims: { jti, eid, tier, admits, exp }, dk: claims.dk };
}
```

- [ ] **Step 3:** Run the test. Expected: PASS. Commit: `feat(tickets): k2 QR envelope and device signature check`.

---

### Task 5: The scan's protected path

**Files:**
- Modify: `src/app/api/scans/route.ts`
- Test: extend `src/__tests__/scanner/scans.test.ts`, following its mock setup

Design section 7. The existing route stays as it is for unprotected tickets: one 404 for "not an admission", 500 for a load error, and the unchanged 409.

- [ ] **Step 1: Write the failing tests** in the existing scan test file. Add these cases (use Task 4's helpers to build real `k2` strings; `Date.now` is faked so the window holds):
  1. A protected ticket with a `k2` QR whose `dk` is the active device key and whose device `buyer_id` equals the order's `buyer_id` → 200 `{ ok: true }`. A second scan of the same QR → the existing 409.
  2. A protected ticket with a plain token → 404.
  3. A `k2` QR for a ticket on an unprotected intake → 404.
  4. A bare bound token (3 segments with `typ: "bound"`, no envelope) → 404.
  5. A `k2` QR whose `dk` isn't the active key (a revoked phone) → 404. No active row → 404.
  6. The active row's `buyer_id` differs from the order's `buyer_id` → 404.
  7. A `ticket_devices` load error → 500, not 404.
  8. A stale `ts` (60 s old) → 404, and **no database call was made**. Assert the admin client's `from` was never called.
  9. An unprotected ticket with a plain token → unchanged 200 (regression).

  Run: `npx vitest run src/__tests__/scanner/scans.test.ts`. Expected: the new cases FAIL.

- [ ] **Step 2: Implement.** In the route:
  - Replace the verify block (step 4 of the handler) with:

```ts
  const nowSeconds = Math.floor(Date.now() / 1000);
  const presentedK2 = isK2(token);
  let claims: TicketClaims;
  let deviceKey: string | null = null;

  if (presentedK2) {
    const k2 = verifyK2(token, nowSeconds);
    if (!k2) return notFound();
    claims = k2.claims;
    deviceKey = k2.dk;
  } else {
    try {
      claims = verifyTicketJwt(token);
    } catch {
      return notFound();
    }
    // A bound token outside its envelope is not an admission.
    if ((claims as unknown as { typ?: unknown }).typ !== undefined) return notFound();
  }
```

  - Extend the ticket select to `"id, intake_id, status, exp, first_scan_at, first_scan_gate, classes(event_date, end_time), intakes(ticket_protection), enrollments(buyer_id)"`, and `TicketRow` with `intakes: { ticket_protection: boolean } | null; enrollments: { buyer_id: string | null } | null`.
  - After the existing `!ticket || … → notFound()` check, add:

```ts
  if (!ticket.intakes) return scanUnavailable("intake load", { code: "embed_missing" });
  const isProtected = ticket.intakes.ticket_protection === true;
  // A k2 QR on an unprotected ticket, or a plain token on a protected one: not an admission.
  if (isProtected !== presentedK2) return notFound();

  if (isProtected) {
    const { data: device, error: deviceError } = await supabase
      .from("ticket_devices")
      .select("public_key, buyer_id")
      .eq("ticket_id", jti)
      .is("revoked_at", null)
      .maybeSingle();
    if (deviceError) return scanUnavailable("device load", deviceError);
    const buyerId = ticket.enrollments?.buyer_id ?? null;
    if (!device || device.public_key !== deviceKey || !buyerId || device.buyer_id !== buyerId) {
      return notFound();
    }
  }
```

  Keep every existing comment. Add one near the device check: a rebind between this check and the admission `UPDATE` can admit the old phone once (decision 6).
- [ ] **Step 3:** Run the scan tests. Expected: all PASS. Commit: `feat(scans): protected tickets need a live QR from the bound phone`.

---

### Task 6: Durable rate limit helper

**Files:**
- Create: `src/server/buyers/rateLimit.ts`
- Test: `src/__tests__/server/buyers/rateLimit.test.ts`

The send-email hook keeps its own local helper; changing a security path that isn't needed here is out of scope.

- [ ] **Step 1: Write the failing test.**
  - `consumeRateLimit` calls the `consume_rate_limit` RPC with `{ p_key, p_window_seconds, p_limit }`.
  - It returns `"ok"` for `true` and `"limited"` for `false`.
  - It returns `"unavailable"` for any other data, an RPC error or a throw, and never throws.
  - Mock the admin client the way `src/__tests__/helpers/mockSupabase.ts` does.
- [ ] **Step 2: Implement**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export type RateLimitResult = "ok" | "limited" | "unavailable";

/** The durable per-key counter from Plan 2 (never the in-memory src/lib/rateLimit.ts). */
export async function consumeRateLimit(
  admin: SupabaseClient<Database>,
  key: string,
  windowSeconds: number,
  limit: number,
): Promise<RateLimitResult> {
  try {
    const { data, error } = await admin.rpc("consume_rate_limit" as never, {
      p_key: key,
      p_window_seconds: windowSeconds,
      p_limit: limit,
    } as never);
    if (error) return "unavailable";
    if (data === true) return "ok";
    if (data === false) return "limited";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}
```

- [ ] **Step 3:** Run the new test. Expected: PASS. Commit: `refactor(buyers): shared durable rate-limit helper`.

---

### Task 7: Bind route and the new-phone email

**Files:**
- Create: `src/app/api/me/tickets/[id]/device/route.ts`
- Modify: `src/lib/email.ts` (add `ticketNewPhoneEmail`)
- Modify: `src/app/api/account/profile/route.ts`, so the POST's same-origin check moves into a shared helper `src/lib/auth/sameOrigin.ts`, used by both routes
- Test: `src/__tests__/api/me/ticketDevice.test.ts`

The middleware matcher already covers `/api/:path*` (`src/middleware.ts:273`); no change is needed there.

**The rate limit counts only key changes.** The design says there is no bind limit (2, 6.1): a holder can move phones any number of times. This limit is abuse protection: 30 key changes per buyer per hour, far above any real use. A page reload that re-sends the key already bound for that ticket (`unchanged`) is never counted, so a leader with many seats can't be locked out at the gate. Task 16 records the limit in the design.

- [ ] **Step 1: Write the failing tests** (mock `requireBuyer`, `resolveTenantId`, the admin client and `sendEmail`):
  1. Not signed in → whatever `requireBuyer` returns (401), with no RPC call.
  2. A cross-site request (`sec-fetch-site: cross-site` or `same-site`, or an `Origin` that isn't the request's own origin) → 403 `FORBIDDEN`, with no RPC call. The same rule as `POST /api/account/profile` stops a sibling tenant subdomain from binding with the buyer's cookie.
  3. `params.id` isn't a uuid → 404 `NOT_FOUND`, with no RPC call.
  4. The body's `publicKey` isn't 87 base64url chars, or isn't a P-256 point → 400 `VALIDATION`, with no RPC call.
  5. The posted key equals this buyer's active key for the ticket → no `consumeRateLimit` call, and the RPC returns `unchanged`. Otherwise `consumeRateLimit` is called: `"limited"` → 429 `RATE_LIMITED`; `"unavailable"` → 503 `SERVER`.
  6. The RPC returns `refused` → 404 `NOT_FOUND`, `{ error: { code: "NOT_FOUND", message: "Ticket not found." } }`. Add `NOT_FOUND` to `buyerError`'s code union.
  7. `bound_first` and `unchanged` → 200 `{ token, jti, serverTime }`. `token` verifies with `verifyTicketJwt` and carries `typ: "bound"` and `dk` equal to the posted key. No email is sent.
  8. `bound_again` → 200 and one `sendEmail` to the buyer's email. A second `bound_again` by the same buyer in the same 10-minute window (the counter uses fixed windows) sends no further email, so moving a phone with N seats sends one email, not N. Use the durable counter as a flag: `consumeRateLimit(admin, "bindmail:<buyerId>", 600, 1)`. Send on `"ok"` **and on `"unavailable"`**: this email is the only anti-takeover signal, so a counter outage must not suppress it. Skip only on `"limited"`. A failed send is still a 200, with a fixed-string log.
  9. The RPC is called with the **host's** tenant id and `ctx.buyerId`, never values from the body.
  10. The response has `Cache-Control: no-store`. No log line contains the token or the key.

- [ ] **Step 2: Implement the route**

```ts
import { NextResponse } from "next/server";
import { createPublicKey } from "crypto";
import { requireBuyer, resolveTenantId } from "@/lib/api";
import { buyerError } from "@/lib/buyers/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { consumeRateLimit } from "@/server/buyers/rateLimit";
import { signBoundTicket } from "@/lib/tickets/sign";
import { sendEmail, ticketNewPhoneEmail } from "@/lib/email";
import { isSameOriginRequest } from "@/lib/auth/sameOrigin";

export const dynamic = "force-dynamic";

const DK = /^[A-Za-z0-9_-]{87}$/;
const BIND_LIMIT = { windowSeconds: 3600, limit: 30 };

function isP256Point(dk: string): boolean {
  const raw = Buffer.from(dk, "base64url");
  if (raw.length !== 65 || raw[0] !== 0x04) return false;
  try {
    createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
    return true;
  } catch {
    return false;
  }
}

const noStore = (res: NextResponse) => (res.headers.set("Cache-Control", "no-store"), res);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isSameOriginRequest(request)) return noStore(buyerError(403, "FORBIDDEN", "Not allowed."));
  const ctx = await requireBuyer();
  if (ctx instanceof NextResponse) return noStore(ctx);
  if (!UUID.test(params.id)) return noStore(buyerError(404, "NOT_FOUND", "Ticket not found."));
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return noStore(tenantId);

  let publicKey: unknown;
  try {
    publicKey = ((await request.json()) as { publicKey?: unknown }).publicKey;
  } catch {
    publicKey = undefined;
  }
  if (typeof publicKey !== "string" || !DK.test(publicKey) || !isP256Point(publicKey)) {
    return noStore(buyerError(400, "VALIDATION", "A device key is required."));
  }

  const admin = createAdminClient();

  // Count only key changes: a reload re-sending the bound key is free.
  const { data: active, error: activeError } = await admin
    .from("ticket_devices")
    .select("public_key")
    .eq("ticket_id", params.id)
    .eq("buyer_id", ctx.buyerId)   // a key seen in someone else's QR doesn't skip the limit
    .is("revoked_at", null)
    .maybeSingle();
  if (activeError) return noStore(buyerError(503, "SERVER", "Please try again."));
  if (active?.public_key !== publicKey) {
    const limited = await consumeRateLimit(admin, `bind:${ctx.buyerId}`, BIND_LIMIT.windowSeconds, BIND_LIMIT.limit);
    if (limited === "limited") return noStore(buyerError(429, "RATE_LIMITED", "Too many attempts. Try again later."));
    if (limited === "unavailable") return noStore(buyerError(503, "SERVER", "Please try again."));
  }

  const { data: result, error } = await admin.rpc("bind_ticket_device" as never, {
    p_ticket_id: params.id,
    p_tenant_id: tenantId,
    p_buyer_id: ctx.buyerId,
    p_public_key: publicKey,
  } as never);
  if (error) {
    console.error("[me/tickets/device] bind failed", (error as { code?: string }).code ?? "");
    return noStore(buyerError(503, "SERVER", "Please try again."));
  }
  if (result === "refused" || typeof result !== "string") {
    return noStore(buyerError(404, "NOT_FOUND", "Ticket not found."));
  }

  const { data: t, error: loadError } = await admin
    .from("tickets")
    .select("id, intake_id, tier, admits, exp")
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .single();
  if (loadError || !t) return noStore(buyerError(503, "SERVER", "Please try again."));

  const token = signBoundTicket(
    { jti: t.id, eid: t.intake_id, tier: t.tier, admits: t.admits, exp: Math.floor(Date.parse(t.exp) / 1000) },
    publicKey,
  );

  // One email per phone move, not one per seat (10-minute window per buyer).
  if (result === "bound_again" && (await consumeRateLimit(admin, `bindmail:${ctx.buyerId}`, 600, 1)) !== "limited") {
    const mail = ticketNewPhoneEmail({ tier: t.tier });
    const sent = await sendEmail({ to: ctx.email, subject: mail.subject, html: mail.html }).catch(() => false);
    if (!sent) console.error("[me/tickets/device] new-phone email not sent");
  }

  return noStore(NextResponse.json({ token, jti: t.id, serverTime: Math.floor(Date.now() / 1000) }));
}
```

  Use the repo's real admin-client import path; check how `src/app/api/account/profile/route.ts` gets it. Give `ticketNewPhoneEmail({ tier, tenantName?, logoUrl? })` a bilingual body built on `baseLayout`, modelled on `interestConfirmationEmail`:
  - English: "Your ticket was opened on a new phone. If this wasn't you, sign in and open your ticket again to move it back."
  - Myanmar: the same sentence, marked for native review in the PR.

- [ ] **Step 3:** Run the tests. Expected: PASS. Commit: `feat(account): bind a phone to an account-bound ticket`.

---

### Task 8: Ticket list API, the browser key module, and the ticket pages

**Files:**
- Create: `src/app/api/me/tickets/route.ts`
- Create: `src/lib/tickets/deviceKey.ts`
- Create: `src/app/(public)/account/tickets/page.tsx`, `src/app/(public)/account/tickets/[id]/page.tsx`, `src/app/(public)/account/tickets/[id]/LiveTicket.tsx`
- Modify: `src/app/(public)/account/AccountSignIn.tsx`, to add a "My tickets" link in the signed-in view
- Modify: `src/app/api/account/profile/route.ts` (GET returns `buyerId`)
- Test: `src/__tests__/api/me/tickets.test.ts`, `src/__tests__/tickets/deviceKey.test.ts`, view tests for the two pages

- [ ] **Step 1: List route tests, then the route.** `GET /api/me/tickets`:
  - Uses `requireBuyer()` and `resolveTenantId()`.
  - Returns **only the current tenant's** tickets (design 4.5) on protected intakes, from confirmed orders whose `buyer_id` is the buyer.
  - Each ticket: `{ id, status: "valid" | "void", eventName, tier, seatNo, attendeeName | null, eventDate | null, endDate | null, bound: boolean }`, grouped client-side by event.
  - `bound` means the ticket has an active `ticket_devices` row. Read it with one query, `select ticket_id … in(ids) is(revoked_at,null)`.
  - Never returns a token, a QR or a key.

  Tests:
  - another tenant's order isn't listed;
  - another buyer's order isn't listed;
  - an unconfirmed order isn't listed;
  - an unprotected order isn't listed;
  - a void ticket is listed as `void`;
  - the response has no `jwt`/`qr`/`token` keys at any depth;
  - `no-store` is set.

- [ ] **Step 2: Write `deviceKey.ts` (browser only; `"use client"` consumers import it).**

```ts
// Design 6.1–6.3. One non-extractable P-256 key per (browser, buyer), kept in IndexedDB.
// The private key never leaves this browser; IndexedDB stores the CryptoKey object itself.
import { k2SignedText } from "./k2Text";

const DB = "kuunyi-tickets";
const STORE = "keys";
const TOKENS = "tokens";

// offset = serverTime - phone time, seconds; publicKey = the key this token was bound to
export interface StoredToken { token: string; jti: string; offset: number; publicKey: string }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
      req.result.createObjectStore(TOKENS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get<T>(store: string, key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

async function put(store: string, key: string, value: unknown): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const b64u = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The buyer's key on this browser, created on first use. Returns the public key, base64url. */
export async function deviceKey(buyerId: string): Promise<{ pair: CryptoKeyPair; publicKey: string }> {
  let pair = await get<CryptoKeyPair>(STORE, buyerId);
  if (!pair) {
    pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    await put(STORE, buyerId, pair);
  }
  return { pair, publicKey: b64u(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

// Keyed by buyer and ticket: two accounts on one browser never share a token.
export const loadToken = (buyerId: string, ticketId: string) => get<StoredToken>(TOKENS, `${buyerId}:${ticketId}`);
export const saveToken = (buyerId: string, ticketId: string, t: StoredToken) => put(TOKENS, `${buyerId}:${ticketId}`, t);

/** The QR text for "now": k2.<token>.<ts>.<devsig> (design 6.2). */
export async function k2Text(pair: CryptoKeyPair, t: StoredToken, phoneNowSeconds: number): Promise<string> {
  const ts = String(Math.floor(phoneNowSeconds + t.offset));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(k2SignedText(t.jti, ts)),
  );
  return `k2.${t.token}.${ts}.${b64u(sig)}`;
}
```

  `k2.ts` imports Node `crypto`, so the browser can't import it. Move `k2SignedText` into a tiny `src/lib/tickets/k2Text.ts` with no imports. Have `k2.ts` re-export it from there, so both sides use one definition.

  `deviceKey.test.ts` uses `fake-indexeddb` **only if it is already a devDependency**; check `package.json` first. If it isn't, don't add a dependency. Test only `k2Text`, by stubbing a pair from `globalThis.crypto.subtle`, and assert that `verifyK2` (Task 4) accepts its output at the matching time. That round-trip is the test that matters.

- [ ] **Step 3: Pages.** Both are client pages under the existing `(public)` layout, which already keeps GTM off `/account/*` because `isTrackedPath` is an allowlist. Confirm that with a unit test on `isTrackedPath("/account/tickets/x") === false`.
  - **`/account/tickets`:**
    - Fetches `/api/me/tickets`. A 401 shows a "Sign in" button to `/account?next=/account/tickets`; that parameter takes effect after Task 11.
    - Lists tickets grouped by event, each linking to `/account/tickets/<id>`. A void ticket shows "Cancelled" with no link.
    - The empty state reads "No account tickets for this event site."
    - Bilingual, like the `/account` page.
  - **`/account/tickets/[id]` (`LiveTicket.tsx`):**
    1. Get the buyer from `GET /api/account/profile`. **Add `buyerId` to that GET's response** (`src/app/api/account/profile/route.ts:44` returns only `{ email, name, locale }` today) and to its test. A 401 means sign in, with `next` set to this page.
    2. Call `deviceKey(buyerId)`.
    3. **Bind on every page load**, so a rebind elsewhere and a server time update are both picked up. `POST /api/me/tickets/<id>/device` with `{ publicKey }`; re-sending the bound key costs nothing against the rate limit (Task 7). On 200, save `{ token, jti, offset: serverTime - now, publicKey }` with `saveToken(buyerId, id, …)`.
       - On a 404, show "This ticket isn't available on this account" and clear the stored token.
       - On a 429, a 503 or a network error, fall back to `loadToken(buyerId, id)` **if its `publicKey` equals this key**, and show a small "Couldn't refresh; showing your saved ticket" note. Otherwise show a retry message.
       - Reloading the page with no signal fails at step 1. That is accepted in design 6.3, and the page says "Open this page before you arrive and keep it open."
    4. Every 15 s (with a visible countdown), render `QRCode.toDataURL(await k2Text(pair, stored, Date.now()/1000), { width: 300, margin: 1, errorCorrectionLevel: "L" })` into an `<img>` at least 240 px wide. Never log the text.
    5. Show the event, tier, seat, attendee name, the account email and the notice "Open this page before you arrive and keep it open." in Myanmar and English.
    6. On iOS Safari not in standalone mode (`navigator.standalone !== true`), show "Add to Home Screen so this ticket stays on your phone" (design 6.3).
  - `errorCorrectionLevel: "L"` keeps a ~400-character QR scannable. Task 16's QR size spike is the real check.

  **Testing the pages.** The repo has no React Testing Library, and vitest runs in `node`; component tests use `renderToStaticMarkup` (see `src/__tests__/enrollment/termsConsent.test.tsx`). Put each page's rendering in a pure view component that takes its state as props (`signedOut | loading | list | error`, and for the ticket `qrDataUrl`, `secondsLeft`, `notice`, `showHomeScreenHint`), and test those views with `renderToStaticMarkup`. The effects (fetch, IndexedDB, the 15 s timer) stay thin and untested in unit tests; the staging phone test covers them.

- [ ] **Step 4:** Run the new tests, then `npx tsc --noEmit`. Expected: PASS. Commit: `feat(account): account ticket list and live QR page`.

---

### Task 9: Part A verification, PR and owner steps

- [ ] **Step 1:** Run the five whole-repo commands from "Before you start". Every exit code must be 0. Report the counts.
- [ ] **Step 2:** Run `codex review --base origin/dev` and save its output in the scratch folder. Fix what it finds, re-run until clean, and post each round on the PR signed "Reviewed by Codex". Sign replies "Addressed by Claude Code".
- [ ] **Step 3:** Open a PR into `dev`, titled `feat: account-bound tickets part A — bound phone, live QR, protected scan`. The body has:
  - what Part A changes, including the line "no event can be protected until Part B";
  - the check results;
  - the three-part status (Claude Code / Codex / Human).

  Never merge it yourself.
- [ ] **Step 4: Owner steps, in order** (each **Required** in the PR body):
  1. Apply migration `20261122130000_leaders_phone` to the **dev DB** **before merging**. Staging reads the dev DB, and Part A's scan route selects `intakes.ticket_protection` and `ticket_devices`; without the migration, every scan on staging fails with a 500.
  2. Verify on the dev DB, using the read-only SQL in the PR:
     - the history row;
     - RLS on `ticket_devices` and `order_moves`;
     - `anon`/`authenticated` have no SELECT on either and no EXECUTE on the five functions;
     - `service_role` has no DELETE on `ticket_devices` and no UPDATE or DELETE on `order_moves`.
  3. Merge into `dev`.
  4. Promote to `staging` with the normal promotion PR.
  5. Production: nothing while the freeze holds. Later, the migration goes on production **before** the code.

---

# Part B — protected checkout, the toggle, and closing the other QR surfaces

Branch `feat/leaders-phone-b` from `origin/dev` after Part A merges.

### Task 10: Which classes are protected

**Files:**
- Create: `src/server/enrollment/protection.ts`
- Test: `src/__tests__/server/enrollment/protection.test.ts`

- [ ] **Step 1: Write the failing test.**
  - `protectedClassIds(admin, classIds)` returns the subset of ids whose class sits on an intake with `ticket_protection = true`, as a `Set<string>`.
  - An empty input returns an empty set with no query.
  - A query error returns `null`. Callers treat `null` as "unavailable" (503), never as "not protected": fail closed.
- [ ] **Step 2: Implement it** with one query: `classes` `select("id, intakes!inner(ticket_protection)").in("id", ids)`. Check the embed name against the `classes.intake_id` FK.
- [ ] **Step 3:** Test passes. Commit: `feat(enroll): find protected classes`.

---

### Task 11: Sign-in returns to where the buyer was (`?next=`)

**Files:**
- Modify: `src/app/(public)/account/accountFlow.ts`, `src/app/(public)/account/AccountSignIn.tsx`
- Test: the existing `src/__tests__/**/accountFlow*.test.ts`

- [ ] **Step 1: Write failing tests.**
  - `/account?next=/enroll/form?slug=x` ends, after a successful code sign-in, by navigating to that path.
  - Google's `redirectTo` carries `next=<that path>` (today it is hard-coded to `/account`, `accountFlow.ts:254`).
  - A `next` that `safeNext()` rejects (`//evil.example`, `https://…`, `/\x`) falls back to `/account`.
- [ ] **Step 2: Implement.**
  - Read `next` once from `useSearchParams` and pass it through `safeNext()` (`src/lib/auth/safeNext.ts`).
  - Hand it to the reducer as a boot parameter.
  - On `signedIn`, call `router.replace(next)` when it isn't `/account`.
  - Use it in the Google `redirectTo`.

  Nothing else changes.
- [ ] **Step 3:** Tests pass. Commit: `feat(account): return to the page that asked for sign-in`.

---

### Task 12: Protected checkout on the server (design 5.2–5.3)

**Files:**
- Modify: `src/app/api/public/enroll/route.ts`, `src/server/enrollment/createEnrollment.ts`, `src/server/enrollment/createCartEnrollment.ts`
- Modify: `src/app/api/public/enrollment/[ref]/route.ts` (PATCH)
- Modify: `src/app/api/public/enroll/[slug]/route.ts` (GET exposes the flag)
- Test: extend the route tests for each

- [ ] **Step 1: Write the failing tests.**
  - **POST `/api/public/enroll`:**
    1. A protected class (single or in a cart) with no buyer session → 401 `{ error: "Unauthorized", message: "Sign in to buy tickets for this event." }`, with no RPC call.
    2. A protected class with a buyer session → the RPC receives `p_buyer_id = ctx.buyerId`, and the order email written by `buildEnrollmentUpdatePayload` is `ctx.email`, **whatever `form_data.email` said**.
    3. An unprotected class → no `requireBuyer` call and no `p_buyer_id`: guest checkout is unchanged.
    4. `protectedClassIds` returning `null` → 503.
    5. The RPC returning `{ success: false, error: "BUYER_REQUIRED" }` → 401 with the same message; `IDEMPOTENCY_CONFLICT` → 409. These arrive through `mapEnrollmentError` (Task 1), not as thrown errors.
    6. A staff session (`requireBuyer` → 403) on a protected class → 403 `{ error: "Forbidden", message: "Staff accounts can't buy account-bound tickets. Use another email." }`.
    7. A protected **draft** order (the trusted-official `checkout/new` path, no `form_data`) is stored with the buyer's email. The RPC writes it (Task 1), so `fd` being null doesn't leave the email empty.
  - **PATCH `/api/public/enrollment/[ref]`:** for a draft order with `buyer_id` set, an `email` in the body is ignored and the stored email stays the buyer's; other fields update as before.
  - **GET `/api/public/enroll/[slug]`:** the response's `intake` has `ticket_protection`.
- [ ] **Step 2: Implement.**
  - **POST `/api/public/enroll`.**
    1. Collect the class ids (`class_id`, or `items[].class_id`) and call `protectedClassIds`.
    2. If any id is protected, call `requireBuyer()`. Map 401 → the 401 above, 403 → the staff 403, 503 → 503.
    3. Then set `fd.email = ctx.email` before the blocked-email check and before `resolveEmailFromFormData`, so every later step (payload, confirmation email) uses it.
    4. Pass `buyerId` into `createEnrollment` / `createCartEnrollment`, which forward it as `p_buyer_id`. Map the two codes Task 1 added to their mappers. When `fd` is null (a draft), skip the `fd.email` step: the RPC already stored the account email.

     Keep the route's response shape for these errors (the existing `{ error, message }`), because the enroll pages already read it.
  - **PATCH `/api/public/enrollment/[ref]`:** select `buyer_id`. When it is set, replace the body's email with the email of the order's buyer profile (`buyer_profiles.email`). Don't trust or require a session there; the draft's buyer is already fixed by the POST.
  - **GET `/api/public/enroll/[slug]`:** add `ticket_protection` to the select (`:132`), the `Pick` (`:56`, `:149-153`) and the response.
- [ ] **Step 3:** Tests pass, and the existing enroll tests still pass. Commit: `feat(enroll): protected events need a signed-in buyer; the order email is the account email`.

---

### Task 13: Protected checkout in the browser (design 5.1–5.2, 5.6)

**Files:** Modify `src/app/(public)/enroll/form/page.tsx`, `src/app/(public)/enroll/[slug]/page.tsx`, `src/app/(public)/enroll/[slug]/tickets/page.tsx`, `src/app/(public)/enroll/[slug]/checkout/new/page.tsx`, `src/app/(public)/enroll/[slug]/checkout/page.tsx`, `src/app/(public)/layout.tsx`. Create `src/components/enroll/ProtectedNotice.tsx`, `src/server/tickets/liveProtectedEvent.ts`, `src/__tests__/tracking/liveProtectedEvent.test.ts`.

The server (Task 12) is the control; this task is the experience.

- [ ] **Step 1: `ProtectedNotice`**, a small bilingual block:
  - English: "Smartphone required. Open your ticket before you arrive."
  - Myanmar: "စမတ်ဖုန်း လိုအပ်ပါသည်။ မရောက်မီ သင့်လက်မှတ်ကို ဖွင့်ထားပါ။" (marked for native review in the PR).

  Render it on the event page, the tickets page, the form and the checkout whenever `intake.ticket_protection` is true.
- [ ] **Step 2: Gate.** Where the intake is protected:
  1. The form page and `checkout/new` call `GET /api/account/profile` before showing any field or creating a draft.
  2. A 401 replaces the form with "Sign in to continue" and a button to `/account?next=<current path and query>`.
  3. A 403 (staff) shows the staff message from Task 12.
  4. A 200 continues. The email field is set to the profile email, `readOnly`, with the note "Tickets are sent to your account." In the standard flow that field is on `form/page.tsx`; in the trusted-official flow it is on `[slug]/checkout/page.tsx` (the page that PATCHes the draft), not `checkout/new`.
- [ ] **Step 3: Component tests.** The repo has no React Testing Library and vitest runs in `node`. Put the gate in a pure view component, `ProtectedGate` (props: `state: "signedOut" | "staff" | "signedIn"`, `email`, `next`), and test it with `renderToStaticMarkup`, as `src/__tests__/enrollment/termsConsent.test.tsx` does:
  - a protected intake without a session shows the sign-in button with the right `next`;
  - with a session, the email input is read-only and holds the profile email;
  - an unprotected intake renders as before.
- [ ] **Step 4: Tags off on the host (decision 8).**
  1. Create `src/server/tickets/liveProtectedEvent.ts` with `tenantHasLiveProtectedEvent(admin, tenantSlug, now)`. It reads the tenant's intakes with `ticket_protection = true` and their classes' dates, and returns `true` when any of them has an event that hasn't ended by the end rule in `move_order_buyer` (Task 1), or has no date. A read error returns `true`.
  2. Keep the date decision in a pure function, `isLiveProtected(rows, now)`, so it can be tested without a database.
  3. In `src/app/(public)/layout.tsx`, compute `gtmAllowed` as today **and** `!(await tenantHasLiveProtectedEvent(...))`. Both `TenantTagManager` and `AdClickCapture` already take `gtmAllowed`, so neither component changes.
  4. Tests in `src/__tests__/tracking/liveProtectedEvent.test.ts`:
     - no protected intake → `false`;
     - a protected intake whose event ends tomorrow → `true`;
     - a protected intake whose events have all ended → `false`;
     - a protected intake with no date → `true`;
     - an unprotected intake with a future event → `false`;
     - a read error → `true`.
- [ ] **Step 5:** Tests pass, and `npx tsc --noEmit` passes. Commit: `feat(enroll): sign-in gate, smartphone notice and tags off on protected events`.

---

### Task 14: The "Account-bound tickets" toggle (design 3, 9)

**Files:**
- Modify: `src/app/api/intakes/[id]/route.ts`, `src/app/admin/intakes/[id]/page.tsx`
- Test: extend the intake route tests

- [ ] **Step 1: Write the failing tests** for `PATCH /api/intakes/[id]`:
  - `ticket_protection` must be a boolean when present (400 otherwise);
  - an owner can set it;
  - the DB error `ticket_protection_locked` → 409 `{ error: "Conflict", message: "This event already has orders, so account-bound tickets can't be switched." }`;
  - a check violation `23514` on `intakes_ticket_protection_needs_jwt` → 409 `{ error: "Conflict", message: "Account-bound tickets need the signed QR format." }`;
  - a non-owner stays 403 (unchanged).

  `GET /api/intakes/[id]` returns `has_orders: boolean`, computed from one `enrollments` count and one `enrollment_items` count on the intake's classes.
- [ ] **Step 2: Implement** with the route's existing per-field pattern (`"ticket_protection" in body`, `typeof === "boolean"`). In the edit modal, add a checkbox "Account-bound tickets (stop resale)". It is disabled when `has_orders`, with the helper text:
  - "Buyers sign in to buy, and tickets work only on the buyer's phone as a live QR. Can't be changed once the event has orders."
  - "While this event is on sale or upcoming, ad tracking (Google Tag Manager) is off on your whole site." (decision 8)
- [ ] **Step 3:** Tests pass. Commit: `feat(admin): account-bound tickets switch on an event`.

---

### Task 15: Close every other place a QR appears (design 8.1)

**Files:**
- Modify: `src/server/tickets/eticketEmailAttachment.ts`
- Modify the callers: `src/server/payments/notifyEnrollmentConfirmed.ts`, `src/server/notifications/dispatchPaymentApproved.ts`, `src/app/api/webhooks/mmpay/route.ts`, `src/app/api/webhooks/abank/route.ts`, `src/app/api/public/payments/abank/status/route.ts`, `src/app/api/admin/enrollments/[id]/resend-email/route.ts`
- Modify the templates these callers use, in `src/lib/email.ts`
- Modify: `src/app/api/public/enrollment/[ref]/route.ts` (GET)
- Modify: `src/app/(public)/enroll/[slug]/checkout/success/page.tsx`, `src/app/(public)/enroll/payment/[ref]/page.tsx`
- Modify: `src/server/tickets/qrExport.ts`, `scripts/export-ticket-qr.ts`, `scripts/resend-etickets.ts`
- Tests: extend each one's tests

- [ ] **Step 1: Write the failing tests.**
  1. `buildTicketEmailParts(enrollmentId)`:
     - an order whose tickets are all protected → `{ attachment: null, accountTickets: true }`;
     - a mixed cart → a PDF of only the unprotected tickets, with `accountTickets: true`;
     - an unprotected order → the same PDF as today, with `accountTickets: false`.
  2. For each of the six callers, an order with protected tickets sends an email that has no attachment and whose HTML contains a link to `https://<tenant host>/account/tickets`. An unprotected order's email is byte-identical to today's, apart from the refactor.
  3. `GET /api/public/enrollment/[ref]`:
     - protected tickets are **absent** from `tickets[]` (no `jwt` or `qr` for them anywhere in the body);
     - `account_ticket_count` equals their number;
     - unprotected tickets are unchanged.
  4. The success and payment pages show an "Open My Tickets" button to `/account/tickets` when `account_ticket_count > 0`, and render no QR or PDF download for those tickets.
     - An order whose tickets are **all** protected (`tickets: []`, `account_ticket_count > 0`) is **not** treated as "tickets missing". Today `payment/[ref]/page.tsx:882-886` errors on an empty list, and `checkout/success/page.tsx:433` falls back to receipt mode. Both must count `tickets.length + account_ticket_count`.
     - Test with view components and `renderToStaticMarkup`; the repo has no React Testing Library.
  5. `qrExportCsv` writes an empty `qr_text` for tickets on protected intakes, while keeping `ticket_id`.
- [ ] **Step 2: Implement.**
  - Rename `buildEticketEmailAttachment` to `buildTicketEmailParts` and return `{ attachment: EmailAttachment | null; accountTickets: boolean }`. Load `ticket_protection` with the intake (it already loads the intake), then split the tickets. Delete the old export, so any caller that wasn't updated fails to compile.
  - **The protection answer must survive a PDF failure.** Callers today write `.catch(() => null)`, which would lose `accountTickets` and drop the "Open My Tickets" button from a protected order's email. Inside `buildTicketEmailParts`, catch the PDF rendering separately: a render error gives `attachment: null` with `accountTickets` still correct. Only a failure to load the tickets or intakes throws. In that case callers fall back to `{ attachment: null, accountTickets: false }`, the same as today's behaviour.
  - `scripts/resend-etickets.ts:16,157` imports the old name, and `tsconfig.json` includes it. Change it to `(await buildTicketEmailParts(id)).attachment`; its `uuid`-only check stays.
  - Each email template the callers use gains an optional `myTicketsUrl?: string`. When it is set, the template renders a bilingual button ("Open My Tickets" / Myanmar text marked for review) and the lines "Your ticket is on your account. Sign in on this site to open it." and "Open it again on your phone before the event day, and keep the page open at the gate." (design 6.3). Callers build the URL on the **tenant's** host.
    - Where `statusUrl` is already on the tenant host, use `new URL("/account/tickets", statusUrl)`.
    - `src/app/api/webhooks/mmpay/route.ts:122` and `src/app/api/webhooks/abank/route.ts:158` build `statusUrl` from `NEXT_PUBLIC_APP_URL` (the platform root, where there is no tenant or session). There, select the tenant's `subdomain` and build the link with `tenantLinkOrigin(subdomain)`.
    - Test both webhooks for the tenant host.
- [ ] **Step 3:** Grep for `buildEticketEmailAttachment`, `signTicketJwt(` and `ticketQrPayload(`. List every hit in the commit message body and confirm that each is now unprotected-only or goes through the new helper.
- [ ] **Step 4:** Tests pass. Commit: `feat(tickets): no QR outside the account for account-bound tickets`.

---

### Task 16: Edit Email refused for account orders, design note, Part B verification and PR

**Files:**
- Modify: `src/app/api/admin/enrollments/[id]/email/route.ts`, `src/app/admin/students/page.tsx`
- Modify: the design, section 13 (decision 6)
- Test: extend the email route tests

- [ ] **Step 1:**
  1. Write the failing test: PATCH on an enrollment with `buyer_id` set → 409 `{ error: "Conflict", message: "This order belongs to a buyer account; its email is the account's email." }`, and `change_enrollment_email` is never called.
  2. Implement it: select `buyer_id` before the RPC.
  3. Hide the `EditOrderEmail` button when `buyer_id` is set. The students GET already returns `*`.
- [ ] **Step 2: Design notes.** Add to the design:
  - section 13: "**A rebind racing an admission:** the scan checks the active phone, then admits; a rebind landing between the two lets the old phone in once (Plan 3, decision 6). Accepted.";
  - section 6.1, after "No bind limit": "Abuse protection only: at most 30 phone *changes* per buyer per hour; re-opening a ticket on the bound phone is never counted (Plan 3, Task 7).";
  - section 13: "**Tag scripts on the same site:** a script on the tenant's host runs as the signed-in buyer and could bind its own phone. Tenant tag scripts are off on the whole host while the tenant has a live protected event (owner decision 2026-11-23, Plan 3 decision 8)."

  Commit: `feat(admin): no Edit Email on account orders; design notes from Plan 3`.
- [ ] **Step 3 (owner-assisted, before this PR merges): QR size spike (design 6.2).**
  1. Run Part B on its Vercel preview, which reads the dev DB, or locally.
  2. Protect a **new test** intake that has no orders (on the dev DB the owner runs the SQL, shown first).
  3. Buy as a test buyer, bind a phone and open `/account/tickets/<id>`.
  4. Read the QR with a phone camera QR reader, and with kuunyi-scanner if its `k2` support exists by then.
  5. Record the QR text length, and whether it read at normal brightness, in the Findings section.

  **If it doesn't read reliably, stop:** shorten `dk` or the claims before merging. The test intake stays as test data; it is never a real event.
- [ ] **Step 4:** Run the five whole-repo commands; every exit code must be 0. Run Codex review as in Task 9. Open the PR `feat: account-bound tickets part B — protected checkout and closed QR surfaces` into `dev`, with the owner steps:
  1. **Required:** Part A's migration is already on the dev DB (Part B has no migration).
  2. **Required:** merge into `dev`, then promote to `staging`.
  3. **Required: staging test.**
     1. Protect a **new test event**, then try to buy without signing in, then with a staff email, then signed in as a buyer.
     2. The confirmation email has no PDF, and its link opens `/account/tickets`.
     3. The payment page shows no QR.
     4. Bind a phone and check that the live QR changes every 15 s.
     5. If kuunyi-scanner supports `k2` by then: scan it; a screenshot scanned after 60 s fails; binding phone B makes A's QR fail.
     6. On a real iPhone: add the page to the Home Screen and record whether the key survives (design 6.3).
  4. **Required:** a native speaker reviews the Myanmar text.
  5. Production: nothing (freeze).

---

# Part C — the organiser's view and the order move

Branch `feat/leaders-phone-c` from `origin/dev` after Part B merges.

### Task 17: `maskEmail`

**Files:**
- Create: `src/lib/maskEmail.ts`
- Test: `src/__tests__/lib/maskEmail.test.ts`

- [ ] **Step 1:**
  1. Write the test: `maskEmail("kyaw@gmail.com") === "k***@gmail.com"`, `maskEmail("a@x.io") === "a***@x.io"`, and `maskEmail("not-an-email") === "***"`.
  2. Implement it in a few lines.
  3. Commit: `feat(lib): mask an email for staff views`.

---

### Task 18: Admin read-only account view (design 9)

**Files:**
- Create: `src/app/api/admin/enrollments/[id]/account/route.ts`
- Modify: `src/app/admin/students/page.tsx` (`StudentDetailModal`)
- Test: `src/__tests__/api/admin/enrollmentAccount.test.ts`

- [ ] **Step 1: Write the failing tests** for `GET /api/admin/enrollments/[id]/account`:
  - Gate: `requireAuth`, with the enrollment scoped to `ctx.tenantId`. Another tenant's order → 404. An agent session (`ctx.isAgent`) → 403, as the Edit Email route does.
  - The response is `{ buyer: { email: "k***@gmail.com" } | null, tickets: [{ id, tier, seatNo, status, bound, lastBoundAt }], moves: [{ createdAt, from, to, reason, movedBy }] }`.
  - Emails are masked and `movedBy` is the staff `full_name` or "Staff".
  - `bound` and `lastBoundAt` come from `ticket_devices`: the active row, and the latest `created_at` per ticket.
  - No public key and no token ever appear in the response.
  - An order with no `buyer_id` and no moves → `{ buyer: null, tickets: [...], moves: [] }`.
- [ ] **Step 2: Implement** with the admin client, scoped by tenant. In `StudentDetailModal`, add an "Account" section, shown only when the response has a buyer or moves: the masked buyer email, a table of tickets with phone status, and the move history. It is read-only; there is no Reset phone (design 2).
- [ ] **Step 3:** Tests pass. Commit: `feat(admin): read-only account, phone and move history on an order`.

---

### Task 19: Move order to another account (design 4.7)

**Files:**
- Create: `src/app/api/admin/enrollments/[id]/move-buyer/route.ts`
- Modify: `src/lib/email.ts` (`orderMovedAwayEmail`, `orderMovedInEmail`)
- Modify: `src/app/admin/students/page.tsx`
- Test: `src/__tests__/api/admin/moveBuyer.test.ts`

- [ ] **Step 1: Write the failing tests:**
  1. Not an owner (`requireOwner` → 403) → 403. An owner without a password session gets Plan 1's 403 from `requireOwner`; test that the route uses `requireOwner`, not `requireAuth`.
  2. Body validation: `email` is a string that looks like an email; `reason` is 1–500 chars after trimming. Otherwise → 400.
  3. A target email with no live `buyer_profiles` row → 409 `{ error: "Conflict", message: "This order can't be moved to that account." }`, with no RPC call.
  4. The RPC returns `refused` → the same 409. One message for every refusal (design 4.7 step 4).
  5. `moved`:
     - 200 `{ ok: true }`;
     - the RPC got `ctx.tenantId`, `ctx.user.id` and the target's buyer id, never values from the body;
     - `orderMovedAwayEmail` goes to the old buyer's profile email (skipped if that profile no longer exists);
     - `orderMovedInEmail` goes to the new buyer.

     Both carry the order reference and the tenant name. A failed send still answers 200, with a fixed-string log.
  6. An agent session (`ctx.isAgent`) → 403, as the Edit Email route does.
- [ ] **Step 2: Implement** the route. Look up the target with `buyer_profiles` `.eq("email", email.trim().toLowerCase()).is("deleted_at", null).maybeSingle()`. Write the emails bilingual on `baseLayout`:
  - away: "Order <ref> was moved to another account by <organiser>. If you didn't ask for this, contact <organiser>.";
  - in: "Order <ref> was added to your account. Sign in on <site> to open your tickets."

  Mark the Myanmar text for review.
- [ ] **Step 3: UI.** In the modal's Account section, show a "Move order to another account" button when the order has a buyer. Clicking it opens a form with:
  - the new account's email;
  - a required reason;
  - the checks list from design 4.7 step 2: "Check the order reference, the payment proof or payer details, and the contact phone on the order before moving."

  Confirming shows a final "Move" button. A 409 shows the server message; success refreshes the section.
- [ ] **Step 4:** Tests pass. Commit: `feat(admin): owner can move an order to the buyer's new account`.

---

### Task 20: Deletion step wrapper (design 9, decision 2)

**Files:**
- Create: `src/server/buyers/revokeTicketDevices.ts`
- Test: `src/__tests__/server/buyers/revokeTicketDevices.test.ts`

- [ ] **Step 1:**
  1. Write the test: `revokeBuyerTicketDevices(admin, buyerId)` calls `revoke_buyer_ticket_devices` with `{ p_buyer_id }` and returns `{ ok: true, revoked: n }`. An error returns `{ ok: false }` and never throws.
  2. Implement it. The doc comment says: "Account deletion (mobile spec 11.1 step 1a, design 9) calls this after `deleted_at` is set and before `auth.admin.deleteUser`, and the deletion sweep calls it again. It is idempotent."
  3. Commit: `feat(buyers): deletion step revokes bound phones`.

---

### Task 21: Part C verification, PR, and the #451 hand-over

- [ ] **Step 1:** Run the five whole-repo commands; every exit code must be 0. Run Codex review as in Task 9.
- [ ] **Step 2:** Open the PR `feat: account-bound tickets part C — order move and admin account view` into `dev`. Owner steps, each **Required**:
  1. Merge, then promote to `staging`.
  2. Staging test of a move:
     1. Buyer A buys on the protected test event and binds a phone.
     2. The owner moves the order to buyer B's account.
     3. A's QR fails, and the order disappears from A's `/account/tickets`.
     4. B sees the order and binds.
     5. Both emails arrive.
     6. A non-owner staff account can't move.
  3. Production: nothing (freeze).
- [ ] **Step 3: #451 hand-over.** Post a "Backend → app sync" comment on EduEnroll #451. It covers:
  - `enrollments.buyer_id` exists, with the `p_buyer_id` replay rule;
  - the design 8.2 rules that #451 must now implement;
  - the deletion step: call `revokeBuyerTicketDevices` before `deleteUser` and in the sweep;
  - the section 9 warning text;
  - a moved order appears in the new account's `/me/orders` through `buyer_id`.

  Don't put exploit detail or client figures in it.
- [ ] **Step 4:** Update the plan series table in `docs/superpowers/plans/2026-11-21-buyer-accounts.md`: Plan 2 done, Plan 3 done with the three PRs. Commit: `docs(plan): Plan 3 done`.

---

## Findings (filled in during the work)

| Question | Result | Consequence |
|---|---|---|
| `k2` QR length, and whether a phone reads it at 240 px (Task 16 step 3) | | stop and shorten if it doesn't read |
| iPhone: does the key survive in a Home Screen web app (Task 16 step 4, staging test) | | design 6.3 notice wording |
| `classes.end_time` type at the time of Task 1 | DATE (migration 031), confirmed in plan review 2026-11-22 | `greatest()` is safe |
