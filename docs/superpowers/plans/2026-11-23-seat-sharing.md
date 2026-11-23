# Seat Sharing (Mode B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On an "Account-bound tickets" event, the leader who bought the order can share one seat at a time with a friend by link. The friend claims it on their own account and phone, and can give it back. Every move is recorded for the organiser, and all sharing closes 24 hours before the event.

**Two PRs into `dev`:**
- **Part A (Tasks 1–10): data and server.**
  - The migration.
  - The holder rule in bind and scan.
  - The share, cancel, claim, preview and give-back routes, and the two emails.
  - The void path and the deletion step.

  On its own, Part A changes nothing anyone can see. Nobody can get a share link without the Part B pages, and every seat's holder is still the leader.
- **Part B (Tasks 11–16): pages and admin.**
  - Sharing on `/account/tickets` and the ticket page.
  - `/t/claim`.
  - The holder history in the admin order view.
  - The "share until" line in the confirmation email.

Part B branches from `dev` after Part A merges.

**Architecture:**
- **The current holder.** `tickets.holder_buyer_id` records a friend who claimed a seat. NULL means the seat is with the order's buyer, so the current holder everywhere is `coalesce(tickets.holder_buyer_id, enrollments.buyer_id)`.
- **Links and the record.**
  - A share link is 32 random bytes held only in the link's URL fragment. The database stores its SHA-256 in `ticket_share_links`.
  - Every change of holder is written to `ticket_holder_events`, which is never updated or deleted.
- **One function per move.** Each move (create, cancel, claim, give back, void) is a single `SECURITY DEFINER` SQL function. It takes the same locks as Plan 3's bind and move, in the same order (enrollment, then ticket), so it can't deadlock with them and a racing bind can't leave the previous holder's phone active.
- **Routes.** They pass only session and host values to those functions, and give one generic refusal for every refused case.

**Tech Stack:** Next.js 14 App Router, Supabase Postgres (RLS, `SECURITY DEFINER` functions), Node `crypto` (`randomBytes`, SHA-256), Resend (`src/lib/email.ts`), Vitest (`npm test`, `npm run test:db`).

**Spec:** `docs/superpowers/specs/2026-11-20-account-bound-tickets-design.md` ("the design"). Plan 4 covers:
- section 6.4, all of it;
- the holder parts of 6.1 (bind) and 7 (scan);
- the Plan 4 items in 4.7 step 5 (link cancelling and `order_moved` events on a move);
- the sharing and history parts of section 9;
- Plan 4's row in section 10;
- the sharing tests in section 11.

---

## Decisions this plan makes (record of what the code found, 2026-11-23)

1. **`voidTicketsForEnrollment` has no caller.** `src/server/tickets/issueTickets.ts:254` exists, but nothing in `src/` calls it. The only code that ever voided tickets is the one-off archive migration `20260723120000`. Refunds and cancellations today change the order's status and leave its tickets alone. `/api/me/tickets` already lists only confirmed orders, and the scan refuses a ticket that isn't valid.
   - This plan adds the SQL function `void_enrollment_tickets(enrollment)` and points `voidTicketsForEnrollment` at it, so any future caller voids, cancels open links and logs `voided` under one lock (design 6.4, "Voided seats").
   - It does **not** add a caller. Wiring refunds to void tickets is a separate change with its own owner decision.
2. **The staff actor gets its own column.** Design 4.7 step 5 logs `order_moved` "with the staff user as actor". `actor_buyer_id` points at `auth.users`, but the mover is a `public.users` row. So `ticket_holder_events` gets `actor_staff_id uuid NULL REFERENCES public.users(id) ON DELETE SET NULL`. A check allows at most one of the two actor columns.
3. **A "first bind" counts from the latest holder change, not from the start of time.** Design 6.1: the first bind per (ticket, holder) sends nothing, "so a friend's first bind after claiming, or the leader's after a give-back, is silent". Plan 3's `bind_ticket_device` asks whether the buyer *ever* had a device row on the ticket. A leader who bound before sharing would then get the new-phone email on their first bind after a give-back.
   - The updated function treats a bind as first when the buyer has no device row created after the ticket's latest `claimed`, `given_back`, `order_moved` or `holder_deleted` event.
   - Both sides of that comparison use `clock_timestamp()`, not `now()`. `now()` is the transaction start: a bind that started before a claim, then waited on the ticket lock, would get an earlier `created_at` than the claim's event. The holder's next phone change would then read as a first bind and send no new-phone email, which is the only takeover signal. `ticket_holder_events.created_at` defaults to `clock_timestamp()`, and the bind inserts its device row with `created_at = clock_timestamp()`. Both are written under the ticket lock, so the order is exact.
4. **A claim preview is its own SQL function.** Design 9 has `/t/claim` show the event and tier before "Claim this seat".
   - `preview_share_link(token_hash, tenant, claimer)` applies exactly the checks the claim applies, without locks, and returns the event name, tier, seat and event date, or no row.
   - The preview route gives the same 404 as the claim and shares its per-IP limit (decision 12), so it can't be used to probe links any more than the claim can.
   - The claim function stays the authority.
5. **The cutoff appears in TypeScript only for display.** `shareCutoffAt(eventDate)` in `src/lib/tickets/exp.ts` uses `DEFAULT_TICKET_TZ` (never `TICKET_TZ`), because the SQL hard-codes `Asia/Yangon`. A database test compares the two for a fixed date. Every decision is made in SQL, under the lock.
6. **Hashing the claim IP.** The claim's per-IP limit key is `claimip:` plus the first 22 characters of the base64url SHA-256 of `clientIpFrom(headers)`. A raw IP never goes into `rate_limit_counters`.
7. **Replacing a link logs only `link_created`.** Design 6.4 says create "cancels any open link, inserts the new one, logs `link_created`". The replaced link has `cancelled_at` set, and its replacement is visible as a second `link_created`. `link_cancelled` is logged only by an explicit cancel, a void, a move or a deletion.
8. **Deletion stays one call.** `revoke_buyer_ticket_devices(buyer)` keeps its name, signature and return value, so the wrapper and the #451 hand-over stay valid. It now also:
   - logs `holder_deleted` for seats the buyer holds as a friend, once per (ticket, buyer), so a retried or swept deletion doesn't log twice;
   - cancels the buyer's open links and logs `link_cancelled`.

   Design 9's "seat returns to the leader" happens later, when `auth.admin.deleteUser` sets `holder_buyer_id` NULL through the FK.

   It must run in its own transaction, **after** the `deleted_at` update has committed, as the wrapper calls it today. A future deletion RPC that did both in one transaction would hold the profile row's exclusive lock while taking ticket locks, and could deadlock with a bind or claim.
9. **The link points at the tenant's public host.** The share route builds `tenantLinkOrigin(subdomain) + "/t/claim#" + token`, the same origin the confirmation emails use. A leader on the kuunyi subdomain therefore sends a link to the custom domain when there is one. The friend signs in on that host.
10. **`/t/claim` lives in the `(public)` group**, as `src/app/(public)/t/claim/`, so it gets the tenant branding.
    - `isTrackedPath` is an allowlist of `/enroll` paths, so tags already never load on `/t/claim`. Task 12 adds a test that pins this.
    - `/t/:path*` is added to the middleware matcher. That gives the page the sanitized tenant headers and the session refresh that `/account` gets.
11. **Moving an order to a friend who holds one of its seats is allowed.** `move_order_buyer` doesn't refuse it. The friend becomes the leader of the whole order and stays the holder of that seat (`holder_buyer_id` = their own id). The seat behaves as theirs: they can bind it and give it back to themselves, which only clears `holder_buyer_id`. Nothing breaks, and a recovery request like that is rare, so no extra refusal is added.
12. **The claim preview has its own limit.** `limitPreview` (`claimpreview:<buyer>`, 900 s, 30) is separate from the claim's `claim:<buyer>` (10). So a page reload after sign-in doesn't spend the claim attempts. The per-IP key is shared by both (30 per 15 minutes), which still caps link guessing from one address.

## Not in this plan

- Wiring refunds or cancellations to void tickets (decision 1).
- Account deletion itself, and its warning text: #451 or a later web story. Plan 4 only extends the step deletion calls (decision 8).
- The mobile app: protected events stay out of the app (design 8.2).
- A reminder message before the cutoff. There is no reminder system. The confirmation email and the ticket page say when sharing closes.
- The kuunyi-scanner changes. **They block every gate test**, as in Plan 3.
- Anything on `main` or production (owner's freeze, 2026-11-21).

---

## Before you start

- **Work in a fresh worktree off `origin/dev`** for each part:
  ```bash
  git fetch origin
  git worktree add .claude/worktrees/seat-sharing-a -b feat/seat-sharing-a origin/dev
  cd .claude/worktrees/seat-sharing-a
  git config user.email   # must print the personal address; stop otherwise
  npm ci                  # real install; never junction node_modules into a worktree
  ```
  For `npm run test:db`, copy `.env.test.local` from the main checkout into the worktree (it is gitignored). Part B uses `feat/seat-sharing-b`, branched after Part A merges.
- **Never run `npm run build` while a dev server is running** from the same folder; it corrupts `.next`.
- **Never print, log or commit a secret or a link token.** That covers a key, a bound token, a `k2` string, a share-link token or its hash, a sign-in code, and a full email address.
  - Log lines are fixed strings plus error codes.
  - A test asserts that no share route logs the token.
- **The local stack is not faithful to hosted grants.** Use `pg` for database tests, as `src/__tests__/db/leaders-phone.db.test.ts` does, and copy its fixture helpers. Local results are not evidence about the dev project.
- **Migrations:**
  - The next free timestamp is after `20261122130000`.
  - Each migration gets a rollback in `supabase/rollbacks/<name>.down.sql`.
  - Any hash or body guard strips `chr(13)`.
  - `CREATE OR REPLACE` keeps a function's ACL, but restate `REVOKE … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role` anyway. The migration's guard block checks the ACLs.
- **Lock order** in every new or changed function: the enrollment row(s) `FOR SHARE`, then the ticket row(s) `FOR UPDATE`, then any `buyer_profiles` row `FOR SHARE`. That is `bind_ticket_device`'s order. Several rows of one kind are locked `ORDER BY id`. A function that locks in another order can deadlock with them.
  - `move_order_buyer` is the one exception: enrollment `FOR UPDATE`, then the target's profile, then the tickets. That is safe only because its enrollment `FOR UPDATE` makes every other function on that order wait for it first. Don't copy its order.
- **Buyer routes** answer errors through `buyerError()` (`src/lib/buyers/errors.ts`), set `Cache-Control: no-store`, and check `isSameOriginRequest` before anything else on `POST` and `DELETE`, as the bind route does.
- **Admin routes** keep their `{ error, message }` shape.
- **The whole-repo verification commands** (Tasks 10 and 16):
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
| `supabase/migrations/20261123120000_seat_sharing.sql` | `holder_buyer_id`, both tables, cutoff helper, five sharing functions, the void function, and the updated bind, move and revoke |
| `supabase/rollbacks/20261123120000_seat_sharing.down.sql` | Exact reverse: restores Plan 3's three function bodies |
| `src/types/database.ts` (modify) | New column, tables and functions |
| `src/lib/tickets/exp.ts` (modify) | `shareCutoffAt(eventDate)` for display |
| `src/server/tickets/shareLinks.ts` | `newShareToken()`, `hashShareToken()`, `isShareToken()`, `shareLinkUrl()` |
| `src/server/tickets/issueTickets.ts` (modify) | `voidTicketsForEnrollment` calls `void_enrollment_tickets` |
| `src/app/api/scans/route.ts` (modify) | The active phone must belong to the current holder |
| `src/app/api/me/tickets/route.ts` (modify) | Seats the buyer holds, plus the leader's shared seats, with share state |
| `src/app/api/me/tickets/[id]/share/route.ts` | `POST` create or replace, `DELETE` cancel |
| `src/app/api/me/tickets/[id]/give-back/route.ts` | `POST` |
| `src/app/api/me/tickets/claim/route.ts` | `POST { token }` |
| `src/app/api/me/tickets/claim/preview/route.ts` | `POST { token }`: event, tier, seat, date |
| `src/server/tickets/sharingLimits.ts` | The rate-limit keys and values, shared by the four routes |
| `src/lib/email.ts` (modify) | `seatClaimedEmail()`, `seatGivenBackEmail()` |
| **Part B** | |
| `src/app/(public)/account/tickets/TicketList.tsx` (modify) | Shared seats' status; no QR link for a seat shared away |
| `src/app/(public)/account/tickets/[id]/SeatSharing.tsx` | Share, copy, cancel; give back |
| `src/app/(public)/account/tickets/[id]/LiveTicket.tsx` (modify) | Mounts `SeatSharing` |
| `src/app/(public)/t/claim/page.tsx`, `ClaimSeat.tsx`, `claimFlow.ts`, `stripFragment.ts` | The claim page |
| `src/middleware.ts` (modify) | `/t/:path*` in the matcher |
| `src/app/api/admin/enrollments/[id]/account/route.ts` (modify) | Holder, link status and history per seat |
| `src/app/admin/students/page.tsx` (modify) | Shows them in the Account section |
| `src/lib/email.ts` (modify) | The "share until" line in `myTicketsSection` |

---

# Part A — data and server

### Task 1: Migration

**Files:**
- Create: `supabase/migrations/20261123120000_seat_sharing.sql`
- Create: `supabase/rollbacks/20261123120000_seat_sharing.down.sql`
- Test: `src/__tests__/db/seat-sharing.db.test.ts`

- [ ] **Step 1: Write the database tests first.** Copy the fixture helpers from `src/__tests__/db/leaders-phone.db.test.ts` (`createTenant`, `createIntake`, `createClass`, `newBuyer`, `newStaff`, `createOrder`, `bind`, `move`, `devices`, `activeDevices`, `waitForLock`). Add:
  ```ts
  const hash = () => randomBytes(32).toString("hex");   // stands in for sha256(token) as hex
  const call = async <T>(q: string, p: unknown[]) => (await sql<T>(q, p))[0];
  const create = (t: string, ten: string, leader: string, h: string) =>
    call<{ result: string; expires_at: Date | null }>(`SELECT * FROM public.create_share_link($1,$2,$3,$4)`, [t, ten, leader, h]);
  const cancel = (t: string, ten: string, leader: string) =>
    call<{ r: string }>(`SELECT public.cancel_share_link($1,$2,$3) AS r`, [t, ten, leader]);
  const claim = (h: string, ten: string, who: string) =>
    call<{ result: string; ticket_id: string | null; leader_id: string | null }>(`SELECT * FROM public.claim_share_link($1,$2,$3)`, [h, ten, who]);
  const giveBack = (t: string, ten: string, who: string) =>
    call<{ result: string; leader_id: string | null }>(`SELECT * FROM public.give_back_seat($1,$2,$3)`, [t, ten, who]);
  const events = (t: string) =>
    sql<{ event: string; actor_buyer_id: string | null; actor_staff_id: string | null; from_buyer_id: string | null; to_buyer_id: string | null }>(
      `SELECT event, actor_buyer_id, actor_staff_id, from_buyer_id, to_buyer_id FROM public.ticket_holder_events WHERE ticket_id = $1 ORDER BY created_at, id`, [t]);
  const holder = async (t: string) => (await call<{ h: string | null }>(`SELECT holder_buyer_id AS h FROM tickets WHERE id = $1`, [t])).h;
  ```
  `createClass(tenantId, intakeId, days)` sets `event_date` to Yangon today plus `days`, so `days = 10` is well before the cutoff and `days = 0` is past it.

  Tests, numbered so failures are easy to find:
  1. **create:**
     - the leader creates a link on a protected, valid, unadmitted seat → `created`, `expires_at` equals the cutoff, one open link, one `link_created` event;
     - a second create replaces it: still one open link, and the first has `cancelled_at`.
  2. **create refused** for each of these, with no link written:
     - another buyer, or a friend who holds the seat;
     - a seat already claimed;
     - another tenant;
     - an unprotected intake;
     - a void ticket;
     - `first_scan_at` set;
     - an unconfirmed order;
     - `days = 0`, `days = 1` (the cutoff is the start of today in Yangon), and a class with `event_date` NULL;
     - a malformed hash;
     - a leader whose profile is deleted.
  3. **cancel:** → `cancelled` and a `link_cancelled` event; a second call → `none`. It works after the cutoff and on a void seat. Another buyer or another tenant → `refused`.
  4. **claim:**
     - B2 claims → `claimed`, `ticket_id` and `leader_id` B1;
     - `holder_buyer_id = B2`, the link has `claimed_by` and `claimed_at`;
     - B1's active device on that seat is revoked with `holder_changed`;
     - one `claimed` event (actor B2, from B1, to B2).
  5. **claim refused**, all giving `refused` with nothing changed:
     - the leader claiming their own link;
     - a claimed, cancelled or replaced link, and an unknown hash;
     - a link from tenant T1 claimed with tenant T2;
     - past the cutoff, which is recomputed: create on `days = 10`, then `UPDATE classes SET event_date = <Yangon today>`, then claim;
     - a staff account (`newStaff` with a profile), and a deleted profile;
     - a void seat, and an admitted seat.
  6. **Concurrent claims of one link** from two buyers, on two connections, the second waiting on the lock (`waitForLock`): exactly one `claimed`, one holder.
  7. **A bind racing a claim:**
     - B1 holds the ticket row's lock through an open transaction that ran `bind_ticket_device` and hasn't committed;
     - B2's claim waits on the lock, then commits;
     - afterwards B1's key is revoked, and B1's new bind is `refused`;
     - B2's bind → `bound_first`.
  8. **give back:**
     - B2 gives back → `given_back`, `leader_id` B1;
     - holder NULL; B2's device revoked with `holder_changed`; one `given_back` event;
     - B1's next bind → `bound_first`, not `bound_again` (decision 3);
     - the seat can be shared again.
  9. **give back refused:**
     - by B1 (not the holder), or by another buyer;
     - another tenant; past the cutoff; an admitted seat;
     - an order whose `buyer_id` is NULL: `UPDATE enrollments SET buyer_id = NULL` stands in for the leader's deletion;
     - a leader whose profile is soft-deleted (`deleted_at` set, `buyer_id` still set): a deletion that has started but hasn't reached `deleteUser`.
  10. **bind and the holder:**
      - after a claim, B2's bind → `bound_first` and B1's → `refused`;
      - after a give-back, the reverse;
      - B2 binding a second key → `bound_again`.
  11. **void:**
      - `void_enrollment_tickets(order)` on an order with one open link and one claimed seat;
      - both tickets `void`, the link `cancelled_at` set, one `voided` event per ticket, the holder kept;
      - a second call voids 0 and logs nothing more.
  12. **A claim racing a void** (void holds the lock first): the claim is `refused` and the link is cancelled. The other order: the void wins after the claim, so the seat is claimed, void, and has no open link.
  13. **move:**
      - an order with seat 1 bound by B1 and an open link, and seat 2 claimed and bound by B2;
      - `move_order_buyer` to B3 revokes seat 1's device (`order_moved`), cancels the link, and logs one `order_moved` event with `actor_staff_id` = the staff id, from B1 to B3;
      - seat 2's holder and active device are unchanged;
      - B3's bind on seat 1 → `bound_first`.
  14. **revoke_buyer_ticket_devices:**
      - for a friend: revokes their device (`account_deleted`), logs `holder_deleted` once, and returns the revoked count;
      - a second call logs nothing more and returns 0.

      For a leader: cancels their open link and logs `link_cancelled`. Then `DELETE FROM auth.users WHERE id = <friend>`; the seat's holder is NULL and B1's bind → `bound_first`.

      **14b. No deadlock with a claim.** A claim of the leader's link holds the ticket lock in an open transaction. `revoke_buyer_ticket_devices(<leader>)` waits on it (`waitForLock`). The claim commits, the revoke finishes, and neither errors (no `40P01`). Assert that there is no `link_cancelled` event for the claimed link. Don't count locked rows: the revoke may still lock that ticket and then find nothing to cancel.
  14c. **A bind racing a holder change keeps the new-phone email (decision 3).**
      - B2 starts a transaction and runs `give_back_seat`, uncommitted.
      - B1's bind starts on a second connection and waits on the lock.
      - B2 commits; B1's bind → `bound_first`.
      - B1 binds a second key → `bound_again`, not `bound_first`.
  15. **The cutoff helper:**
      - `share_cutoff('2026-12-05')` equals `2026-12-03 17:30:00+00` (Yangon is UTC+6:30);
      - `share_cutoff(NULL)` is NULL;
      - assert `DEFAULT_TICKET_TZ === "Asia/Yangon"` beside it, as Plan 3's test 13 does;
      - **one second either side:** in a transaction, `seat_open_for_sharing` is true when the class's cutoff is one second after `now()`, and false one second before it. Set it with `UPDATE classes SET event_date = …` for a date whose cutoff is near `now()`, or test `now() < share_cutoff(d)` directly against computed timestamps.
  16. **Authenticated sessions get nothing:**
      - `SET ROLE authenticated` can't `SELECT` either new table, and can't execute any of the eleven functions in the grants list (`has_function_privilege` false);
      - `service_role` has `SELECT, INSERT, UPDATE` on `ticket_share_links`, `SELECT, INSERT` on `ticket_holder_events`, and nothing else.
  17. **preview:** returns one row (event name, tier, seat, event date) for an open link and the right claimer. It returns no row for every case in test 5.

- [ ] **Step 2: Run them and watch them fail.**
  Run: `npx vitest run --config vitest.db.config.ts src/__tests__/db/seat-sharing.db.test.ts`
  Expected: FAIL, `function public.create_share_link(...) does not exist`.

- [ ] **Step 3: Write the migration.**

```sql
-- Seat sharing (mode B): design section 6.4, Plan 4.
-- Every new object is service-role only. Lock order everywhere: enrollment(s)
-- FOR SHARE, then ticket(s) FOR UPDATE, then buyer_profiles FOR SHARE, several
-- rows ORDER BY id — bind_ticket_device's order. move_order_buyer differs
-- (enrollment FOR UPDATE, profile, tickets) and is safe only because its
-- FOR UPDATE makes everything else on that order wait first.

BEGIN;

-- ── 1. The current holder ───────────────────────────────────────────────────
ALTER TABLE public.tickets
  ADD COLUMN holder_buyer_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX tickets_holder_buyer_id_idx ON public.tickets (holder_buyer_id) WHERE holder_buyer_id IS NOT NULL;

-- ── 2. Share links ──────────────────────────────────────────────────────────
CREATE TABLE public.ticket_share_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by    uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NULL,   -- display only; every function recomputes the cutoff
  claimed_by    uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  claimed_at    timestamptz NULL,
  cancelled_at  timestamptz NULL,
  CONSTRAINT ticket_share_links_one_end CHECK (claimed_at IS NULL OR cancelled_at IS NULL)
);
CREATE UNIQUE INDEX ticket_share_links_one_open ON public.ticket_share_links (ticket_id)
  WHERE claimed_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX ticket_share_links_open_by_creator ON public.ticket_share_links (created_by)
  WHERE claimed_at IS NULL AND cancelled_at IS NULL;
ALTER TABLE public.ticket_share_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ticket_share_links FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ticket_share_links FROM service_role;   -- Supabase default privileges grant ALL
GRANT SELECT, INSERT, UPDATE ON public.ticket_share_links TO service_role;

-- ── 3. Holder history ───────────────────────────────────────────────────────
CREATE TABLE public.ticket_holder_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  event           text NOT NULL CHECK (event IN ('link_created', 'link_cancelled', 'claimed', 'given_back',
                                                 'holder_deleted', 'voided', 'order_moved')),
  actor_buyer_id  uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_staff_id  uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,   -- plan decision 2
  from_buyer_id   uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  to_buyer_id     uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),   -- plan decision 3
  CONSTRAINT ticket_holder_events_one_actor CHECK (actor_buyer_id IS NULL OR actor_staff_id IS NULL)
);
CREATE INDEX ticket_holder_events_ticket_idx ON public.ticket_holder_events (ticket_id, created_at);
ALTER TABLE public.ticket_holder_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ticket_holder_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ticket_holder_events FROM service_role;
GRANT SELECT, INSERT ON public.ticket_holder_events TO service_role;   -- never updated or deleted

-- ── 4. The cutoff ───────────────────────────────────────────────────────────
-- Start of the event's first day in Asia/Yangon, minus 24 hours. NULL when
-- there is no date (no sharing: fails closed). The zone must equal the app's
-- DEFAULT_TICKET_TZ (src/lib/tickets/exp.ts); a database test compares them.
CREATE FUNCTION public.share_cutoff(p_event_date date)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p_event_date IS NULL THEN NULL
              ELSE (p_event_date::timestamp AT TIME ZONE 'Asia/Yangon') - interval '24 hours' END
$$;

-- ── 5. Seat checks shared by create, claim, preview and give-back ───────────
-- Reads the seat fresh (call it after the locks). True only for a valid,
-- unadmitted seat of this tenant on a protected intake, on a confirmed order,
-- before the cutoff of the ticket's own class.
CREATE FUNCTION public.seat_open_for_sharing(p_ticket_id uuid, p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.tickets t
      JOIN public.enrollments e ON e.id = t.enrollment_id
      JOIN public.intakes i ON i.id = t.intake_id
      JOIN public.classes c ON c.id = t.class_id
     WHERE t.id = p_ticket_id
       AND t.tenant_id = p_tenant_id
       AND t.status = 'valid'
       AND t.first_scan_at IS NULL
       AND e.status::text = 'confirmed'
       AND i.ticket_protection
       AND c.event_date IS NOT NULL
       AND now() < public.share_cutoff(c.event_date))
$$;

-- ── 6. create_share_link ────────────────────────────────────────────────────
CREATE FUNCTION public.create_share_link(
  p_ticket_id uuid, p_tenant_id uuid, p_leader_id uuid, p_token_hash text)
RETURNS TABLE (result text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_t record;
BEGIN
  IF p_ticket_id IS NULL OR p_tenant_id IS NULL OR p_leader_id IS NULL
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'refused'::text, NULL::timestamptz; RETURN;
  END IF;

  PERFORM 1 FROM public.enrollments e JOIN public.tickets t ON t.enrollment_id = e.id
   WHERE t.id = p_ticket_id FOR SHARE OF e;
  PERFORM 1 FROM public.tickets WHERE id = p_ticket_id FOR UPDATE;
  PERFORM 1 FROM public.buyer_profiles WHERE id = p_leader_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'refused'::text, NULL::timestamptz; RETURN;
  END IF;

  SELECT t.holder_buyer_id, e.buyer_id, c.event_date
    INTO v_t
    FROM public.tickets t
    JOIN public.enrollments e ON e.id = t.enrollment_id
    JOIN public.classes c ON c.id = t.class_id
   WHERE t.id = p_ticket_id;

  IF NOT FOUND
     OR NOT public.seat_open_for_sharing(p_ticket_id, p_tenant_id)
     OR v_t.buyer_id IS DISTINCT FROM p_leader_id
     OR v_t.holder_buyer_id IS NOT NULL
  THEN
    RETURN QUERY SELECT 'refused'::text, NULL::timestamptz; RETURN;
  END IF;

  UPDATE public.ticket_share_links
     SET cancelled_at = now()
   WHERE ticket_id = p_ticket_id AND claimed_at IS NULL AND cancelled_at IS NULL;

  INSERT INTO public.ticket_share_links (ticket_id, token_hash, created_by, expires_at)
  VALUES (p_ticket_id, p_token_hash, p_leader_id, public.share_cutoff(v_t.event_date));

  INSERT INTO public.ticket_holder_events (ticket_id, event, actor_buyer_id, from_buyer_id)
  VALUES (p_ticket_id, 'link_created', p_leader_id, p_leader_id);

  RETURN QUERY SELECT 'created'::text, public.share_cutoff(v_t.event_date);
END;
$$;

-- ── 7. cancel_share_link ────────────────────────────────────────────────────
-- 'cancelled' | 'none' | 'refused'. Checks only the tenant and the leader, so
-- it also works after the cutoff and on a void or admitted seat.
CREATE FUNCTION public.cancel_share_link(p_ticket_id uuid, p_tenant_id uuid, p_leader_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ok boolean;
  v_n  integer;
BEGIN
  IF p_ticket_id IS NULL OR p_tenant_id IS NULL OR p_leader_id IS NULL THEN RETURN 'refused'; END IF;

  PERFORM 1 FROM public.enrollments e JOIN public.tickets t ON t.enrollment_id = e.id
   WHERE t.id = p_ticket_id FOR SHARE OF e;
  PERFORM 1 FROM public.tickets WHERE id = p_ticket_id FOR UPDATE;

  SELECT (t.tenant_id = p_tenant_id AND e.buyer_id = p_leader_id)
    INTO v_ok
    FROM public.tickets t JOIN public.enrollments e ON e.id = t.enrollment_id
   WHERE t.id = p_ticket_id;
  IF v_ok IS NOT TRUE THEN RETURN 'refused'; END IF;

  UPDATE public.ticket_share_links
     SET cancelled_at = now()
   WHERE ticket_id = p_ticket_id AND claimed_at IS NULL AND cancelled_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN 'none'; END IF;

  INSERT INTO public.ticket_holder_events (ticket_id, event, actor_buyer_id, from_buyer_id)
  VALUES (p_ticket_id, 'link_cancelled', p_leader_id, p_leader_id);
  RETURN 'cancelled';
END;
$$;

-- ── 8. preview_share_link (plan decision 4) ─────────────────────────────────
-- The claim's checks without locks; display only. One row or none.
CREATE FUNCTION public.preview_share_link(p_token_hash text, p_tenant_id uuid, p_claimer_id uuid)
RETURNS TABLE (event_name text, tier text, seat_no integer, event_date date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT i.name, t.tier, t.seat_no, c.event_date
    FROM public.ticket_share_links l
    JOIN public.tickets t ON t.id = l.ticket_id
    JOIN public.enrollments e ON e.id = t.enrollment_id
    JOIN public.intakes i ON i.id = t.intake_id
    JOIN public.classes c ON c.id = t.class_id
   WHERE p_token_hash ~ '^[0-9a-f]{64}$'
     AND l.token_hash = p_token_hash
     AND l.claimed_at IS NULL AND l.cancelled_at IS NULL
     AND t.holder_buyer_id IS NULL
     AND e.buyer_id IS NOT NULL
     AND e.buyer_id <> p_claimer_id
     AND public.seat_open_for_sharing(t.id, p_tenant_id)
     AND EXISTS (SELECT 1 FROM public.buyer_profiles bp WHERE bp.id = p_claimer_id AND bp.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_claimer_id)
$$;

-- ── 9. claim_share_link ─────────────────────────────────────────────────────
CREATE FUNCTION public.claim_share_link(p_token_hash text, p_tenant_id uuid, p_claimer_id uuid)
RETURNS TABLE (result text, ticket_id uuid, leader_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ticket  uuid;
  v_link    record;
  v_seat    record;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_tenant_id IS NULL OR p_claimer_id IS NULL THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  -- Find the seat without locking, then lock it and re-read everything.
  SELECT l.ticket_id INTO v_ticket FROM public.ticket_share_links l WHERE l.token_hash = p_token_hash;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  PERFORM 1 FROM public.enrollments e JOIN public.tickets t ON t.enrollment_id = e.id
   WHERE t.id = v_ticket FOR SHARE OF e;
  PERFORM 1 FROM public.tickets WHERE id = v_ticket FOR UPDATE;
  PERFORM 1 FROM public.buyer_profiles WHERE id = p_claimer_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_claimer_id) THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  SELECT l.id, l.claimed_at, l.cancelled_at INTO v_link
    FROM public.ticket_share_links l WHERE l.token_hash = p_token_hash;
  SELECT t.holder_buyer_id, e.buyer_id INTO v_seat
    FROM public.tickets t JOIN public.enrollments e ON e.id = t.enrollment_id
   WHERE t.id = v_ticket;

  IF v_link.claimed_at IS NOT NULL OR v_link.cancelled_at IS NOT NULL
     OR v_seat.holder_buyer_id IS NOT NULL
     OR v_seat.buyer_id IS NULL
     OR v_seat.buyer_id = p_claimer_id
     OR NOT public.seat_open_for_sharing(v_ticket, p_tenant_id)
  THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  UPDATE public.tickets SET holder_buyer_id = p_claimer_id WHERE id = v_ticket;
  UPDATE public.ticket_share_links SET claimed_by = p_claimer_id, claimed_at = now() WHERE id = v_link.id;
  -- Aliased: `ticket_id` is also an OUT column of this function, and an
  -- unqualified reference is "ambiguous" under the default variable_conflict.
  UPDATE public.ticket_devices d SET revoked_at = now(), revoked_by = 'holder_changed'
   WHERE d.ticket_id = v_ticket AND d.revoked_at IS NULL;
  INSERT INTO public.ticket_holder_events (ticket_id, event, actor_buyer_id, from_buyer_id, to_buyer_id)
  VALUES (v_ticket, 'claimed', p_claimer_id, v_seat.buyer_id, p_claimer_id);

  RETURN QUERY SELECT 'claimed'::text, v_ticket, v_seat.buyer_id;
END;
$$;

-- ── 10. give_back_seat ──────────────────────────────────────────────────────
CREATE FUNCTION public.give_back_seat(p_ticket_id uuid, p_tenant_id uuid, p_holder_id uuid)
RETURNS TABLE (result text, leader_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seat record;
BEGIN
  IF p_ticket_id IS NULL OR p_tenant_id IS NULL OR p_holder_id IS NULL THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid; RETURN;
  END IF;

  PERFORM 1 FROM public.enrollments e JOIN public.tickets t ON t.enrollment_id = e.id
   WHERE t.id = p_ticket_id FOR SHARE OF e;
  PERFORM 1 FROM public.tickets WHERE id = p_ticket_id FOR UPDATE;

  SELECT t.holder_buyer_id, e.buyer_id INTO v_seat
    FROM public.tickets t JOIN public.enrollments e ON e.id = t.enrollment_id
   WHERE t.id = p_ticket_id;

  -- After the leader's account is deleted (buyer_id NULL) a give-back would
  -- leave the seat with no one: refused (design 6.4).
  IF NOT FOUND
     OR v_seat.holder_buyer_id IS DISTINCT FROM p_holder_id
     OR v_seat.buyer_id IS NULL
     OR NOT public.seat_open_for_sharing(p_ticket_id, p_tenant_id)
  THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid; RETURN;
  END IF;

  -- A leader whose deletion has started (deleted_at set, deleteUser not yet
  -- run) must not get the seat back either: it would die with the account.
  -- The share lock makes a give-back and a deletion take turns, as in bind.
  PERFORM 1 FROM public.buyer_profiles WHERE id = v_seat.buyer_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid; RETURN;
  END IF;

  UPDATE public.tickets SET holder_buyer_id = NULL WHERE id = p_ticket_id;
  UPDATE public.ticket_devices SET revoked_at = now(), revoked_by = 'holder_changed'
   WHERE ticket_id = p_ticket_id AND revoked_at IS NULL;
  INSERT INTO public.ticket_holder_events (ticket_id, event, actor_buyer_id, from_buyer_id, to_buyer_id)
  VALUES (p_ticket_id, 'given_back', p_holder_id, p_holder_id, v_seat.buyer_id);

  RETURN QUERY SELECT 'given_back'::text, v_seat.buyer_id;
END;
$$;

-- ── 11. void_enrollment_tickets (plan decision 1) ───────────────────────────
-- Voids the order's valid tickets, cancels their open links and logs `voided`,
-- under the ticket locks. Returns how many tickets it voided. The holder is kept.
CREATE FUNCTION public.void_enrollment_tickets(p_enrollment_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  PERFORM 1 FROM public.enrollments WHERE id = p_enrollment_id FOR SHARE;
  PERFORM 1 FROM public.tickets WHERE enrollment_id = p_enrollment_id ORDER BY id FOR UPDATE;

  WITH v AS (
    UPDATE public.tickets SET status = 'void'
     WHERE enrollment_id = p_enrollment_id AND status = 'valid'
    RETURNING id)
  SELECT coalesce(array_agg(id), '{}') INTO v_ids FROM v;

  UPDATE public.ticket_share_links SET cancelled_at = now()
   WHERE ticket_id = ANY (v_ids) AND claimed_at IS NULL AND cancelled_at IS NULL;

  INSERT INTO public.ticket_holder_events (ticket_id, event)
  SELECT unnest(v_ids), 'voided';

  RETURN cardinality(v_ids);
END;
$$;
```

  Then, in the same file:
  - **`bind_ticket_device`:** `CREATE OR REPLACE` with Plan 3's body (`supabase/migrations/20261122130000_leaders_phone.sql:681-757`) and two changes:
    1. The holder test `OR v_t.buyer_id IS DISTINCT FROM p_buyer_id` becomes `OR coalesce(v_t.holder_buyer_id, v_t.buyer_id) IS DISTINCT FROM p_buyer_id`. Add `t.holder_buyer_id` to its `SELECT`.
    2. `v_first` follows decision 3:
       ```sql
       v_first := NOT EXISTS (
         SELECT 1 FROM public.ticket_devices d
          WHERE d.ticket_id = p_ticket_id AND d.buyer_id = p_buyer_id
            AND d.created_at > coalesce(
              (SELECT max(h.created_at) FROM public.ticket_holder_events h
                WHERE h.ticket_id = p_ticket_id
                  AND h.event IN ('claimed', 'given_back', 'order_moved', 'holder_deleted')),
              '-infinity'::timestamptz));
       ```
    3. The device insert sets `created_at = clock_timestamp()` explicitly (decision 3): `INSERT INTO public.ticket_devices (ticket_id, buyer_id, public_key, created_at) VALUES (p_ticket_id, p_buyer_id, p_public_key, clock_timestamp());`
  - **`move_order_buyer`:** `CREATE OR REPLACE` with Plan 3's body (`:778-852`). Replace the device revoke after `PERFORM 1 FROM public.tickets … FOR UPDATE` with:
    ```sql
    -- Only seats still with the leader move; seats a friend claimed stay with them.
    UPDATE public.ticket_devices d
       SET revoked_at = now(), revoked_by = 'order_moved'
      FROM public.tickets t
     WHERE t.enrollment_id = v_e.id AND t.holder_buyer_id IS NULL
       AND d.ticket_id = t.id AND d.revoked_at IS NULL;

    UPDATE public.ticket_share_links l
       SET cancelled_at = now()
      FROM public.tickets t
     WHERE t.enrollment_id = v_e.id AND l.ticket_id = t.id
       AND l.claimed_at IS NULL AND l.cancelled_at IS NULL;

    INSERT INTO public.ticket_holder_events (ticket_id, event, actor_staff_id, from_buyer_id, to_buyer_id)
    SELECT t.id, 'order_moved', p_staff_user_id, v_e.buyer_id, p_to_buyer_id
      FROM public.tickets t
     WHERE t.enrollment_id = v_e.id AND t.holder_buyer_id IS NULL;
    ```
    The rest of the body is unchanged: the refusal checks, the target lock, the end date, the `buyer_id` update and the `order_moves` row.
  - **`revoke_buyer_ticket_devices`:** `CREATE OR REPLACE`, same signature and return value (decision 8):
    ```sql
    DECLARE v_n integer;
    BEGIN
      -- Take the sharing functions' locks first, in their order, so this step
      -- can't deadlock with a claim, cancel, move or void on the same seat:
      -- every affected order FOR SHARE (by id), then every affected ticket
      -- FOR UPDATE (by id). Affected = seats the buyer holds as a friend, plus
      -- seats with an open link the buyer made. Nothing can join that set once
      -- deleted_at is set: claim and create both require a live profile.
      PERFORM 1 FROM public.enrollments e
       WHERE e.id IN (SELECT t.enrollment_id FROM public.tickets t
                       WHERE t.holder_buyer_id = p_buyer_id
                          OR t.id IN (SELECT l.ticket_id FROM public.ticket_share_links l
                                       WHERE l.created_by = p_buyer_id
                                         AND l.claimed_at IS NULL AND l.cancelled_at IS NULL))
       ORDER BY e.id FOR SHARE;
      PERFORM 1 FROM public.tickets t
       WHERE t.holder_buyer_id = p_buyer_id
          OR t.id IN (SELECT l.ticket_id FROM public.ticket_share_links l
                       WHERE l.created_by = p_buyer_id
                         AND l.claimed_at IS NULL AND l.cancelled_at IS NULL)
       ORDER BY t.id FOR UPDATE;

      INSERT INTO public.ticket_holder_events (ticket_id, event, actor_buyer_id, from_buyer_id)
      SELECT t.id, 'holder_deleted', p_buyer_id, p_buyer_id
        FROM public.tickets t
       WHERE t.holder_buyer_id = p_buyer_id
         AND NOT EXISTS (SELECT 1 FROM public.ticket_holder_events h
                          WHERE h.ticket_id = t.id AND h.event = 'holder_deleted' AND h.from_buyer_id = p_buyer_id);

      WITH c AS (
        UPDATE public.ticket_share_links SET cancelled_at = now()
         WHERE created_by = p_buyer_id AND claimed_at IS NULL AND cancelled_at IS NULL
        RETURNING ticket_id)
      INSERT INTO public.ticket_holder_events (ticket_id, event, actor_buyer_id, from_buyer_id)
      SELECT ticket_id, 'link_cancelled', p_buyer_id, p_buyer_id FROM c;

      UPDATE public.ticket_devices
         SET revoked_at = now(), revoked_by = 'account_deleted'
       WHERE buyer_id = p_buyer_id AND revoked_at IS NULL;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      RETURN v_n;
    END;
    ```
  - **Grants:** for each of `share_cutoff(date)`, `seat_open_for_sharing(uuid,uuid)`, `create_share_link(uuid,uuid,uuid,text)`, `cancel_share_link(uuid,uuid,uuid)`, `preview_share_link(text,uuid,uuid)`, `claim_share_link(text,uuid,uuid)`, `give_back_seat(uuid,uuid,uuid)`, `void_enrollment_tickets(uuid)`, `bind_ticket_device(uuid,uuid,uuid,text)`, `move_order_buyer(uuid,uuid,uuid,uuid,text)` and `revoke_buyer_ticket_devices(uuid)`:
    ```sql
    REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION … TO service_role;
    ```
  - **The guard block.** Copy section 9 of the Plan 3 migration, with the function list above. Body checks, each on `replace(prosrc, chr(13), '')`:
    - `bind_ticket_device` contains `holder_buyer_id` and `ticket_holder_events`;
    - `move_order_buyer` contains `ticket_share_links` and `order_moved`;
    - `revoke_buyer_ticket_devices` contains `holder_deleted`.
  - End with `NOTIFY pgrst, 'reload schema';` and `COMMIT;`.

- [ ] **Step 4: Write the rollback.** In one transaction:
  1. Restore Plan 3's three bodies: copy them exactly from `20261122130000_leaders_phone.sql` and restate the grants.
  2. Drop the eight new functions.
  3. Drop both tables, the index and the column.

  A rollback after links were claimed returns every claimed seat to its leader. Say so in a comment at the top.

- [ ] **Step 5: Apply locally and run the tests.**
  Run: `npx supabase migration up` then the command from step 2.
  Expected: PASS, every test. Then run all of `npm run test:db` and expect exit 0, so `leaders-phone.db.test.ts` still passes against the new bodies.

- [ ] **Step 6: Commit.**
  ```bash
  git add supabase/migrations/20261123120000_seat_sharing.sql supabase/rollbacks/20261123120000_seat_sharing.down.sql src/__tests__/db/seat-sharing.db.test.ts
  git commit -m "feat(db): seat sharing — holder, share links, holder history and their functions"
  ```

### Task 2: Types and the display cutoff

**Files:**
- Modify: `src/types/database.ts` (beside `ticket_devices` at `:604` and `revoke_buyer_ticket_devices` at `:693`)
- Modify: `src/lib/tickets/exp.ts`
- Test: `src/__tests__/lib/tickets/shareCutoff.test.ts`

- [ ] **Step 1: Failing test.**
  ```ts
  import { describe, it, expect } from "vitest";
  import { shareCutoffAt } from "@/lib/tickets/exp";

  describe("shareCutoffAt", () => {
    it("is the start of the event day in Yangon minus 24 hours", () => {
      expect(shareCutoffAt("2026-12-05")).toBe(Date.parse("2026-12-03T17:30:00Z") / 1000);
    });
    it("is null without a date", () => {
      expect(shareCutoffAt(null)).toBeNull();
    });
  });
  ```
- [ ] **Step 2:** Run `npx vitest run src/__tests__/lib/tickets/shareCutoff.test.ts`. Expected: FAIL, not exported.
- [ ] **Step 3: Implement** in `exp.ts`, reusing the private `getOffsetMs`:
  ```ts
  // Display only (plan 4 decision 5): the share cutoff, in Unix seconds. SQL's
  // share_cutoff() decides; it hard-codes Asia/Yangon, so this uses the default
  // zone and never TICKET_TZ.
  export function shareCutoffAt(eventDate: string | null): number | null {
    if (!eventDate) return null;
    const [y, m, d] = eventDate.split("-").map(Number);
    const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
    const startOfDay = guess - getOffsetMs(new Date(guess), DEFAULT_TICKET_TZ);
    return Math.floor(startOfDay / 1000) - 24 * 3600;
  }
  ```
  Add the column, both tables and the eight functions to `src/types/database.ts`, in the shape the Plan 3 entries use.
- [ ] **Step 4:** Run the test (PASS) and `npx tsc --noEmit` (exit 0).
- [ ] **Step 5: Commit** `feat(tickets): share cutoff for display, seat-sharing types`.

### Task 3: Share token helpers

**Files:**
- Create: `src/server/tickets/shareLinks.ts`
- Test: `src/__tests__/server/tickets/shareLinks.test.ts`

- [ ] **Step 1: Failing tests:**
  - `newShareToken()` is 43 base64url characters, and two calls differ;
  - `hashShareToken(t)` is 64 lowercase hex characters and equals `createHash("sha256").update(t, "utf8").digest("hex")`;
  - `isShareToken` accepts a fresh token and rejects `""`, 42 or 44 characters, `+`, `/` and `=`;
  - `shareLinkUrl("https://skyfestivalmm.com", t)` is `https://skyfestivalmm.com/t/claim#<t>`.
- [ ] **Step 2:** Run them and watch them fail.
- [ ] **Step 3: Implement:**
  ```ts
  import { createHash, randomBytes } from "crypto";

  // A share link's secret lives only in the link's fragment (design 6.4).
  // The database keeps its SHA-256. Never log a token or a hash.
  const TOKEN = /^[A-Za-z0-9_-]{43}$/;

  export const newShareToken = (): string => randomBytes(32).toString("base64url");
  export const isShareToken = (t: unknown): t is string => typeof t === "string" && TOKEN.test(t);
  export const hashShareToken = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");
  export const shareLinkUrl = (origin: string, token: string): string => `${origin}/t/claim#${token}`;
  ```
- [ ] **Step 4:** Run them (PASS).
- [ ] **Step 5: Commit** `feat(tickets): share-link token helpers`.

### Task 4: The scan checks the current holder

**Files:**
- Modify: `src/app/api/scans/route.ts:176` and `:199-232`
- Test: `src/__tests__/scanner/scans.test.ts`

- [ ] **Step 1: Failing tests** in that file, with its mocks:
  - a ticket with `holder_buyer_id = F` and an active device of buyer F → admitted;
  - the same ticket with an active device of the leader → 404;
  - `holder_buyer_id` NULL and the leader's device → admitted, as before.
- [ ] **Step 2:** Run them; the first fails.
- [ ] **Step 3: Implement.**
  - Add `holder_buyer_id` to the ticket `select` and to `TicketRow`.
  - Compute `const holderId = ticket.holder_buyer_id ?? ticket.enrollments?.buyer_id ?? null;`.
  - Compare `deviceBuyerId` with `holderId`, keeping the rule that two missing ids aren't a match.
  - Update the comment to "the current holder (design 7 step 5)".
- [ ] **Step 4:** Run the file (PASS) and every scan test.
- [ ] **Step 5: Commit** `feat(scans): a bound phone must belong to the seat's current holder`.

### Task 5: The void path

**Files:**
- Modify: `src/server/tickets/issueTickets.ts:254-260`
- Test: `src/__tests__/server/tickets/voidTickets.test.ts`

- [ ] **Step 1: Failing tests:**
  - `voidTicketsForEnrollment("e1")` calls `rpc("void_enrollment_tickets", { p_enrollment_id: "e1" })` once;
  - an RPC error makes it throw `Error("void failed")`. Today it silently ignores errors, and a void that didn't happen must not look done.
- [ ] **Step 2:** Run them and watch them fail.
- [ ] **Step 3: Implement:**
  ```ts
  /**
   * Voids the order's tickets, cancels their open share links and logs `voided`,
   * under the ticket locks (design 6.4). No caller yet (plan 4 decision 1).
   */
  export async function voidTicketsForEnrollment(enrollmentId: string): Promise<void> {
    const supabase = createAdminClient();
    const { error } = await supabase.rpc("void_enrollment_tickets" as never, { p_enrollment_id: enrollmentId } as never);
    if (error) {
      console.error("[voidTicketsForEnrollment] void failed", (error as { code?: string }).code ?? "");
      throw new Error("void failed");
    }
  }
  ```
- [ ] **Step 4:** Run them (PASS).
- [ ] **Step 5: Commit** `feat(tickets): voiding cancels share links and logs it in one SQL call`.

### Task 6: Rate limits shared by the sharing routes

**Files:**
- Create: `src/server/tickets/sharingLimits.ts`
- Test: `src/__tests__/server/tickets/sharingLimits.test.ts`

- [ ] **Step 1: Failing tests.** The calls are checked against a mocked `consumeRateLimit`:
  - `limitShare(admin, buyer)` → key `share:<buyer>`, 3600 s, 20;
  - `limitGiveBack` → `giveback:<buyer>`, 3600 s, 10;
  - `limitClaim(admin, buyer, headers)` makes two calls: `claim:<buyer>` (900 s, 10), then `claimip:<hash>` (900 s, 30). It returns the first result that isn't `ok`.
  - `limitPreview(admin, buyer, headers)` is the same with `claimpreview:<buyer>` (900 s, 30) in place of the buyer key, and the same IP key (decision 12).
  - The IP key never contains the IP: for `x-forwarded-for: 203.0.113.9`, the key doesn't include `203.0.113.9` and is 30 characters long (`claimip:` plus 22).
- [ ] **Step 2:** Run them and watch them fail.
- [ ] **Step 3: Implement:**
  ```ts
  import { createHash } from "crypto";
  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { Database } from "@/types/database";
  import { clientIpFrom } from "@/lib/rateLimit";
  import { consumeRateLimit, type RateLimitResult } from "@/server/buyers/rateLimit";

  // Design 6.4 starting values. Durable counters only (Plan 2's RPC).
  type Admin = SupabaseClient<Database>;
  const ipKey = (headers: Headers) =>
    `claimip:${createHash("sha256").update(clientIpFrom(headers)).digest("base64url").slice(0, 22)}`;

  export const limitShare = (admin: Admin, buyerId: string) => consumeRateLimit(admin, `share:${buyerId}`, 3600, 20);
  export const limitGiveBack = (admin: Admin, buyerId: string) => consumeRateLimit(admin, `giveback:${buyerId}`, 3600, 10);
  async function buyerThenIp(admin: Admin, buyerKey: string, buyerLimit: number, headers: Headers): Promise<RateLimitResult> {
    const byBuyer = await consumeRateLimit(admin, buyerKey, 900, buyerLimit);
    if (byBuyer !== "ok") return byBuyer;
    return consumeRateLimit(admin, ipKey(headers), 900, 30);
  }
  export const limitClaim = (admin: Admin, buyerId: string, headers: Headers) =>
    buyerThenIp(admin, `claim:${buyerId}`, 10, headers);
  export const limitPreview = (admin: Admin, buyerId: string, headers: Headers) =>
    buyerThenIp(admin, `claimpreview:${buyerId}`, 30, headers);
  ```
- [ ] **Step 4:** Run them (PASS).
- [ ] **Step 5: Commit** `feat(tickets): durable rate limits for sharing`.

### Task 7: Seat emails

**Files:**
- Modify: `src/lib/email.ts` (next to `ticketNewPhoneEmail`, `:774`)
- Test: `src/__tests__/lib/seatEmails.test.ts`

- [ ] **Step 1: Failing tests:**
  - `seatClaimedEmail({ tier, claimedBy: "k***@gmail.com", tenantName })`: the subject has the tier; the body has the masked email and a Myanmar line.
  - `seatGivenBackEmail({ tier, tenantName })`: the same, without an email.
  - Both escape `<b>` in `tier` and `tenantName`.
  - Neither contains `@` except in `claimedBy`.
- [ ] **Step 2:** Run them and watch them fail.
- [ ] **Step 3: Implement** both with `baseLayout` and `escapeEmailText`, in the style of `orderMovedAwayEmail`. Mark the Myanmar lines `// NEEDS NATIVE REVIEW`. English text:
  - **claimed:** subject "Your <tier> seat was claimed"; body "Your seat was claimed by <masked email>. Only their phone can show its QR now."
  - **given back:** subject "A <tier> seat was given back to you"; body "A seat you shared was given back to you. Open it in My Tickets to show its QR."
- [ ] **Step 4:** Run them (PASS).
- [ ] **Step 5: Commit** `feat(email): seat claimed and given back`.

### Task 8: Share, cancel and give-back routes

**Files:**
- Create: `src/app/api/me/tickets/[id]/share/route.ts`
- Create: `src/app/api/me/tickets/[id]/give-back/route.ts`
- Test: `src/__tests__/api/me/shareSeat.test.ts`, `src/__tests__/api/me/giveBack.test.ts`

Model both on `src/app/api/me/tickets/[id]/device/route.ts`: same mocks, `noStore`, the same-origin check before `requireBuyer`, UUID check → 404, `resolveTenantId()`, fixed log strings.

- [ ] **Step 1: Failing tests for `share`:**
  - **cross-site:** 403, and no Auth call;
  - **signed out:** 401;
  - **malformed id:** 404;
  - **POST:**
    - calls `create_share_link` with the host tenant, the session buyer and a 64-hex hash, and with nothing from the body;
    - answers 200 `{ url, expiresAt }`;
    - `url` is `tenantLinkOrigin(subdomain) + "/t/claim#" + token`, and `hashShareToken(token)` equals the hash sent;
  - **POST refused:** `refused` → 404 "Seat not available to share.";
  - **POST errors:** an RPC error → 503;
  - **POST rate limit:** limited → 429 and no RPC; the limiter unavailable → 503 and no RPC;
  - **DELETE:** `cancelled` → 200 `{ cancelled: true }`; `none` → 200 `{ cancelled: false }`; `refused` → 404. It uses `limitShare` too;
  - **logging:** `console.error` and `console.log` are spied on, and no call's arguments contain the token or the hash.
- [ ] **Step 2: Failing tests for `give-back`:**
  - **refusals:** cross-site → 403; signed out → 401;
  - **`given_back`:**
    - 200 `{ ok: true }`;
    - the leader's profile email is read and `seatGivenBackEmail` is sent to it;
    - a failed send still answers 200, with a fixed log line;
  - **`refused`:** 404;
  - **limits:** limited → 429.
- [ ] **Step 3:** Run them and watch them fail.
- [ ] **Step 4: Implement `share/route.ts`.**
  - **POST:**
    1. Load the tenant's `subdomain` (`tenants.select("subdomain").eq("id", tenantId)`). On an error → 503.
    2. `const token = newShareToken();`
    3. `rpc("create_share_link", { p_ticket_id, p_tenant_id, p_leader_id: ctx.buyerId, p_token_hash: hashShareToken(token) })`.
    4. On `[{ result: "created", expires_at }]`, answer `{ url: shareLinkUrl(tenantLinkOrigin(subdomain), token), expiresAt }`.

    Never put the token in a log line, an error or a header.
  - **DELETE:** `rpc("cancel_share_link", …)`.
  - **Body:** neither method reads one.
- [ ] **Step 5: Implement `give-back/route.ts`.**
  1. Call `rpc("give_back_seat", …)`.
  2. On `given_back`, read `buyer_profiles.email` for `leader_id` where `deleted_at` is null, plus the ticket's `tier` and the tenant's `name, logo_url`.
  3. Await `sendEmail(seatGivenBackEmail(...))` with `.catch(() => false)` (memory: always await on Vercel).
- [ ] **Step 6:** Run both files (PASS).
- [ ] **Step 7: Commit** `feat(me): share a seat by link, cancel the link, give a seat back`.

### Task 9: Claim, preview, and the ticket list

**Files:**
- Create: `src/app/api/me/tickets/claim/route.ts`, `src/app/api/me/tickets/claim/preview/route.ts`
- Modify: `src/app/api/me/tickets/route.ts`
- Test: `src/__tests__/api/me/claimSeat.test.ts`, `src/__tests__/api/me/tickets.test.ts`

- [ ] **Step 1: Failing tests for `claim`:**
  - **refusals before any work:**
    - cross-site → 403;
    - signed out → 401;
    - a body over 1024 bytes → 413;
  - **one 404:** a missing, malformed or non-string `token` gives the **same** 404 body as an RPC `refused`: `{ error: { code: "NOT_FOUND", message: "This link no longer works." } }`;
  - **a valid token:**
    - calls `claim_share_link` with its hash, the host tenant and the session buyer;
    - `claimed` → 200 `{ ticketId }`;
    - `seatClaimedEmail` is sent to the leader. The route reads the leader's `buyer_profiles.email` for `leader_id` with `deleted_at` null (none → no email, still 200), the ticket's `tier`, and the tenant's `name, logo_url`. `claimedBy` is `maskEmail(ctx.email)`. The send is awaited with `.catch(() => false)`; a failed send still answers 200, with a fixed log line;
  - **limits:** `limitClaim` limited → 429; unavailable → 503; both happen before the RPC;
  - **logging:** no log line contains the token or its hash.
- [ ] **Step 2: Failing tests for `preview`:**
  - the same refusals and the same 404;
  - a row → 200 `{ eventName, tier, seatNo, eventDate }`;
  - it uses `limitPreview` (decision 12), not `limitClaim`.
- [ ] **Step 3: Failing tests for the list.** `GET /api/me/tickets` returns:
  - seats on the buyer's orders, `role: "leader"`;
  - seats where `holder_buyer_id` is the buyer, `role: "holder"`, with `leaderEmail` masked;
  - for a leader's seat a friend holds: `sharedWith` masked, `bound: false`, and no link to open it (the page decides, Task 11);
  - for a leader's seat with an open link: `linkOpen: true`;
  - `canShare`: role leader, valid, not shared, `firstScanAt` null, and now before `shareCutoffAt`;
  - `canGiveBack`: role holder, valid, `firstScanAt` null, before the cutoff;
  - `shareClosesAt` from `shareCutoffAt(eventDate)`;
  - a ticket of another tenant, or of an unprotected intake, is never listed by either query;
  - any read error → 503.
- [ ] **Step 4:** Run them and watch them fail.
- [ ] **Step 5: Implement the two claim routes.**
  1. Parse the body as the bind route does (`MAX_BODY_BYTES = 1024`).
  2. `if (!isShareToken(token)) return linkGone();`
  3. Then the limiter, then the RPC.

  `linkGone()` is the one 404 response for every refusal.
- [ ] **Step 6: Implement the list.**
  - Extend `AccountTicket` with:
    ```ts
    role: "leader" | "holder";
    sharedWith: string | null;   // masked; leader only
    leaderEmail: string | null;  // masked; holder only
    linkOpen: boolean;           // leader only
    canShare: boolean;
    canGiveBack: boolean;
    shareClosesAt: number | null;
    ```
  - **Query 1:** today's query, plus `holder_buyer_id, first_scan_at` in the select.
  - **Query 2:** the same select with `.eq("holder_buyer_id", ctx.buyerId)` in place of the `enrollments.buyer_id` filter. Keep the `enrollments.status`, `intakes.ticket_protection` and tenant filters, and filter the rows again in code as today.
  - Merge by id; a seat in both is impossible (a leader can't claim their own seat), but dedupe anyway.
  - Read active devices **only for seats the buyer holds**, so `bound` describes the viewer's phone.
  - Read open links for leader-held seats: `ticket_share_links.select("ticket_id").in(...).is("claimed_at", null).is("cancelled_at", null)`.
  - Read the profiles behind `sharedWith` and `leaderEmail` in one `buyer_profiles` read. A deleted or missing profile shows `***`.
- [ ] **Step 7:** Run all three files (PASS), and `src/__tests__/account/accountTickets.test.tsx` and `src/__tests__/account/liveTicketFlow.test.ts`: their `AccountTicket` fixtures need the new fields.
- [ ] **Step 8: Commit** `feat(me): claim a shared seat; list seats held and shared`.

### Task 10: Part A verification and PR

- [ ] **Step 1:** Run the five whole-repo commands; every exit code must be 0.
- [ ] **Step 2:** Run `codex review --base origin/dev`, and post the result on the PR signed "Reviewed by Codex". Fix what it finds, or answer it, signed "Addressed by Claude Code".
- [ ] **Step 3:** Open `feat: account-bound tickets — seat sharing part A (data and server)` into `dev`. The body has the checks table, "Not verified" (no browser, no real inbox, nothing on the dev DB), and the three-part status. **Human steps, in order:**
  1. **Required:** merge.
  2. **Required:** apply `20261123120000_seat_sharing.sql` to the **dev DB** (`fnfvwzwrdsnmwxunciti`) after reviewing its diff, then check the function list and ACLs. Show the SQL first, per the repo rules.
  3. **Production:** nothing while the freeze holds. When it lifts, the migration goes to production **before** this code: the scan and bind read `holder_buyer_id`.

---

# Part B — pages and admin

### Task 11: Sharing on the ticket pages

**Files:**
- Modify: `src/app/(public)/account/tickets/TicketList.tsx`
- Create: `src/app/(public)/account/tickets/[id]/SeatSharing.tsx`
- Modify: `src/app/(public)/account/tickets/[id]/LiveTicket.tsx`
- Test: `src/__tests__/account/accountTickets.test.tsx` (extend), `src/__tests__/account/SeatSharing.test.tsx` (new; static render, as `accountTickets.test.tsx` does)

- [ ] **Step 1: Failing tests:**
  - **`TicketList`:**
    - a leader's seat with `sharedWith` shows "Claimed by k***@gmail.com", has **no** "Show QR" link, and isn't an `<a>`;
    - `linkOpen` shows "Link sent";
    - a holder's seat shows "From k***@gmail.com" and links to its QR.
  - **`SeatSharingView`:**
    - the leader with `canShare` sees "Share this seat" and "Sharing closes <date, Yangon>";
    - after a share it shows the URL in a read-only field with Copy, and Cancel link;
    - the holder with `canGiveBack` sees "Give back to k***@gmail.com";
    - neither flag shows "Sharing has closed for this event." on a valid seat;
    - it shows nothing on a void seat;
    - the URL is never put in `localStorage` or `sessionStorage` (spy both).
- [ ] **Step 2:** Run them and watch them fail.
- [ ] **Step 3: Implement.**
  - **`SeatSharing`** splits like the existing pages: `SeatSharingView` renders a state, the default export runs the requests.
    - **Share:** `POST /api/me/tickets/<id>/share`. Keep `url` only in React state. Copy uses `navigator.clipboard.writeText` and falls back to selecting the field.
    - **Cancel:** `DELETE`.
    - **Give back:** asks for a confirm step first ("Give this seat back? Your QR stops working."), then `POST …/give-back`, then navigates to `/account/tickets`.
    - **Errors:** 429 → "Too many tries. Try again later."; anything else → the existing "Something went wrong" copy.
  - **Bilingual copy** in a `COPY` object like `TicketList`'s. Every `mm` string is marked NEEDS NATIVE REVIEW.
  - **`LiveTicket`:** mount `<SeatSharing ticket={ticket} />` under the QR when `ticket` is loaded. A leader whose seat is claimed never reaches the QR: the bind answers 404 and the page shows `notAvailable` as today. Add to `notAvailable` a line, "This seat is with someone else now.", when the list says `sharedWith`.
- [ ] **Step 4:** Run them (PASS), plus `src/__tests__/account/liveTicketFlow.test.ts`.
- [ ] **Step 5: Commit** `feat(account): share a seat, copy or cancel the link, give a seat back`.

### Task 12: `/t/claim`

**Files:**
- Create: `src/app/(public)/t/claim/stripFragment.ts`, `claimFlow.ts`, `ClaimSeat.tsx`, `page.tsx`
- Modify: `src/middleware.ts` (matcher, `:262-282`)
- Test: `src/__tests__/account/claimFlow.test.ts`, `src/__tests__/account/ClaimSeat.test.tsx`, `src/__tests__/middleware.test.ts`

- [ ] **Step 1: Failing tests:**
  - **`STRIP_FRAGMENT_JS`** (a string exported from `stripFragment.ts`), run against a fake `location` and `history` with `new Function`:
    - with `#<token>` it writes the token to `sessionStorage["seat_claim"]`, calls `history.replaceState(null, "", "/t/claim")`, and the fake URL has no `#`;
    - without a hash, or with a hash that isn't a token, it writes nothing, but still strips the hash;
    - if `sessionStorage` throws, it keeps the token on `window.__seatClaim` instead and still strips.
  - **`claimFlow`:**
    - `readClaimToken()` returns the stored token, or `null`;
    - `finishClaim()` removes it from both places;
    - `decide(previewStatus)`: 200 → `ready`, 401 → `signIn`, 404 → `gone`, 429 → `limited`, anything else → `error`.
  - **`ClaimSeatView`:**
    - `ready` shows event, tier, seat, date and "Claim this seat";
    - `signIn` links to `/account?next=%2Ft%2Fclaim`;
    - `gone` shows "This link no longer works.";
    - none of them render the token.
  - **middleware:** `/t/claim` is in the matcher, and it gets the sanitized tenant headers, like `/account`.
  - **tags:** `isTrackedPath("/t/claim")` is false. Also check `TenantTagManager` and `AdClickCapture` render nothing there.
- [ ] **Step 2:** Run them and watch them fail.
- [ ] **Step 3: Implement.**
  - **`page.tsx`** is a server component. It renders, as its **first** element, `<script dangerouslySetInnerHTML={{ __html: STRIP_FRAGMENT_JS }} />`, then `<ClaimSeat />`.
    - The script runs as the body is parsed, before React hydrates the page.
    - `/t/claim` loads no tag scripts (decision 10), so the only scripts that could run before it are the app's own bundles.
    - Record that in a comment.
  - **`ClaimSeat`:**
    1. Read the token. With none, show `gone`.
    2. `POST /api/me/tickets/claim/preview` with `{ token }`.
    3. On 401, show "Sign in to claim this seat", linking to `/account?next=/t/claim`. The token stays in `sessionStorage` across the sign-in.
    4. On "Claim this seat", `POST /api/me/tickets/claim`.
    5. Call `finishClaim()` as soon as the claim answers, whether or not it succeeded.
    6. On 200, go to `/account/tickets/<ticketId>`.

    A preview that answers 404 also calls `finishClaim()`.
  - **Middleware:** add `"/t/:path*"` to the matcher. Check the custom-domain split doesn't redirect it: it only redirects `/admin`, `/login`, `/onboarding`, `/register` and `/superadmin`.
  - **Copy:** bilingual, NEEDS NATIVE REVIEW. "Sign in with the email you want this seat on. The seat moves to your account and works only on your phone."
- [ ] **Step 4:** Run them (PASS).
- [ ] **Step 5: Commit** `feat(account): /t/claim — claim a shared seat`.

### Task 13: Holder history in the admin order view

**Files:**
- Modify: `src/app/api/admin/enrollments/[id]/account/route.ts`
- Modify: `src/app/admin/students/page.tsx` (`OrderAccount`, `:716-860`)
- Test: `src/__tests__/api/admin/enrollmentAccount.test.ts`, and the `OrderAccount` test if there is one (`grep -rln "OrderAccount" src/__tests__`)

- [ ] **Step 1: Failing tests** for the route. Each ticket gains:
  - `holder`: masked, or `null` while with the buyer;
  - `linkOpen`: boolean;
  - `history`: `[{ at, event, by, from, to }]`, oldest first, where:
    - `by` is a masked buyer email, the staff `full_name` (or "Staff"), or `null` for `voided`;
    - `from` and `to` are masked.

  Also:
  - the response still never has a full email, a buyer id, a key or a token hash;
  - a `ticket_holder_events` or `ticket_share_links` read error → 500;
  - an agent still gets 403.
- [ ] **Step 2:** Run them and watch them fail.
- [ ] **Step 3: Implement.**
  - Add `holder_buyer_id` to the ticket read.
  - Read the open links and the events for the order's tickets in the existing `Promise.all`.
  - Add every buyer id the events mention to `buyerIds`, and every `actor_staff_id` to `staffIds`, so it's still one profile read and one staff read.
  - In `OrderAccount`, under each seat row, add "Holder" and "Link" cells and a collapsible "History" list. Admin text is English only, as in the rest of the admin.
- [ ] **Step 4:** Run them (PASS).
- [ ] **Step 5: Commit** `feat(admin): seat holder, link status and holder history in the order's Account section`.

### Task 14: "Share until" in the confirmation email

**Files:**
- Modify: `src/lib/email.ts` (`myTicketsSection`, `:335`)
- Test: `src/__tests__/notifications/accountTicketsEmail.test.ts`

- [ ] **Step 1: Failing test.** With `myTicketsUrl` set, the section also says "You can share a seat with a friend from My Tickets until 24 hours before the event.", with a Myanmar line. Without the URL, the section is still empty.
- [ ] **Step 2:** Run it and watch it fail.
- [ ] **Step 3: Implement.** Add one English and one Myanmar paragraph (NEEDS NATIVE REVIEW) after "Open it again on your phone…". No date: the email builder doesn't have the event date in every caller, and the ticket page shows the exact time.
- [ ] **Step 4:** Run it (PASS), plus the six callers' email tests.
- [ ] **Step 5: Commit** `feat(email): say seats can be shared until 24 hours before the event`.

### Task 15: Design notes

**Files:**
- Modify: `docs/superpowers/specs/2026-11-20-account-bound-tickets-design.md`

- [ ] **Step 1:** Record this plan's departures in the design, each one line with "(Plan 4)":
  - **6.1:** "first bind" counts from the latest holder change (decision 3).
  - **6.4:**
    - the staff actor column (decision 2);
    - the preview function (decision 4);
    - the link uses the tenant's public host (decision 9);
    - voiding has no caller yet (decision 1).
  - **13:** "Voiding is not wired to refunds: a refunded order's tickets stay valid until a void path is built." Check this first. The scan admits a valid ticket whatever the order's status, so confirm whether a refunded order's seats still admit. If they do, write it as a known gap and tell the owner in chat.
- [ ] **Step 2: Commit** `docs(spec): Plan 4 departures and the void gap`.

### Task 16: Part B verification, PR and hand-overs

- [ ] **Step 1:** Run the five whole-repo commands; every exit code must be 0. Run Codex review and post it, as in Task 10.
- [ ] **Step 2: Local run against the dev DB**, only after the owner has applied Part A's migration there (Task 10, step 3). Use the same setup as the Plan 3 spike: the dev server on port 3005, a protected test event, two buyer accounts the owner signs in.
  1. The leader shares seat 2, and the link opens on another browser profile.
  2. The friend signs in and claims it; the leader's list shows "Claimed by …".
  3. The friend's page shows a live QR.
  4. The friend gives it back; the leader can open it again.
  5. Check `ticket_holder_events` for the four rows with a read-only query, showing the SQL first.

  Record the result in Findings. This is local evidence only, not staging.
- [ ] **Step 3:** Open `feat: account-bound tickets — seat sharing part B (pages and admin)` into `dev`. **Human steps, in order:**
  1. **Required:** merge.
  2. **Required:** promote Plans 2–4 to `staging` in order (each migration first).
  3. **Required: the staging phone test** (design 11). The leader shares a second seat, and a friend claims it on phone C. Check:
     - the leader's QR for that seat fails, and C's passes;
     - the friend gives it back, and C's QR fails;
     - both emails arrive.

     This needs kuunyi-scanner's `k2` support.
  4. **Required:** native review of every NEEDS NATIVE REVIEW string.
  5. **Production:** nothing while the freeze holds.
- [ ] **Step 4: #451 note.** Post a short "Backend → app sync" comment on #451:
  - `revokeBuyerTicketDevices` is unchanged to call, but now also logs `holder_deleted` and cancels the buyer's share links. It must still run in its own transaction, after `deleted_at` is committed;
  - `/me/tickets` must still leave protected seats out, including seats a buyer holds as a friend (`tickets.holder_buyer_id`).

  No exploit detail and no client figures.
- [ ] **Step 5:** Set Plan 4's row in `docs/superpowers/plans/2026-11-21-buyer-accounts.md` to "built". Commit `docs(plan): Plan 4 built`.

---

## Findings (filled in during the work)

| Question | Result | Consequence |
|---|---|---|
| Does a refunded order's ticket still admit at the gate (Task 15) | | known gap in design 13, or none |
| Local claim and give-back run against the dev DB (Task 16 step 2) | | |
| Staging phone test with a claimed seat (Task 16 step 3) | | |
