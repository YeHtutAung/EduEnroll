# Event interest list with priority enrollment window

**Date:** 2026-08-26
**Status:** Approved (design), pending implementation plan
**Revision:** v2 — incorporates external review (Codex, 2026-08-26)

## Problem

Clients want pre-enrollment for events without payment. On clarification, this
means an **expression of interest** list, not a free ticket and not a
pay-later invoice. People register interest in an event whose ticket sales
have not opened. They hold no seat and receive no ticket. When sales approach,
each of them gets a **priority window**: a head start during which they, and
only they, can enroll through the normal paid flow. At the public open time
the window ends and the event behaves exactly as it does today.

### Decisions taken during design

| Question | Decision |
|---|---|
| What "pre-enrollment without payment" means | Expression of interest / waitlist |
| What happens when sales open | Priority window (early access), not notify-and-requeue |
| What interest attaches to | The **intake** (the event), not a single ticket tier |
| Capacity during the window | Pure head start — same seat pool, no reserved quota |
| Credential | Secret link, one per person per event |
| Delivery | Email at signup, plus the link shown on screen |
| Window control | Scheduled, via a new `priority_open_at` on the class |
| Token reuse | Multi-use for the whole window, first use recorded |
| Lost link recovery | Rotate on resend, email to the address on file, with a cooldown |
| Spam control | Honeypot + unique `(intake_id, email)` index + resend cooldown + input bounds |
| Tenant scope | Admin UI hidden for `language_school`, no database restriction |

## Current state

Established by reading the code, not assumed:

- Both `submit_enrollment` and `submit_cart_enrollment`
  (`supabase/migrations/076_fix_stored_functions.sql`) hard-code
  `status = 'pending_payment'` on insert. There is no zero-fee path anywhere.
- Those two RPCs are the **sole** enforcer of `enrollment_open_at`. No API
  route checks it.
- The RPCs are **service_role only** — `20260719100000_restrict_enrollment_rpc_privileges.sql`
  revoked `anon` and `authenticated`. That migration exists because
  `SECURITY DEFINER` overloads had accumulated with PostgreSQL's default
  `EXECUTE TO PUBLIC` never revoked.
- `classes` is `UNIQUE (intake_id, level)` — **a class is a ticket tier within
  an event, and the intake is the event.** The `tickets` table takes its
  `tier` from `classes.level`.
- Carts are built per-intake on `/enroll/[slug]`, and each cart item carries
  its own `class_id` (`handleCartCheckout`). `submit_cart_enrollment` loops
  over them and enforces same-tenant, but not same-intake.
- `confirmed` is reached only through payment settlement
  (`verifyPayment`, `settlePaidPayment`, `settleMmqrPayment`, five webhooks),
  and `issueTicketsForEnrollment` is called only from those same paths.
- `check_expired_enrollments()` auto-cancels anything left in
  `pending_payment` past `auto_cancel_hours` (which holds **minutes**).
- Seats are decremented at enrollment time, before any payment.
- `scanner_api_keys` + `src/lib/scanner/hash.ts` establish the house pattern
  for a bearer credential: store `sha256(raw)`, keep a display prefix, RLS
  enabled with no policies, service-role access only.
- `tickets` denormalises `tenant_id` alongside `intake_id`/`class_id` with no
  cross-table consistency check.
- `src/app/api/public/enroll/route.ts` uses an `__hp` honeypot field.
- The event page already lifts a URL parameter into client state for the
  Messenger `psid` (`src/app/(public)/enroll/[slug]/page.tsx`).
- **There is no rate-limiting infrastructure in `src/`.**

## Approach

A standalone `event_interest` table holding one hashed token per person **per
event (intake)**, and a new `classes.priority_open_at`. The two enrollment
RPCs gain a token-hash parameter; when a class's public window has not opened
they consult the interest table for that class's intake instead of refusing
outright.

Attaching interest to the intake rather than the class is what keeps the
multi-tier cart working: one token authorises every tier in the event, so no
token array or per-class token map is needed.

### Rejected alternatives

**Reuse `enrollments` with a new `interest` status.** `EnrollmentStatus` is
load-bearing across every money path — `check_expired_enrollments()`,
`verifyPayment`, `settlePaidPayment`, the five webhooks, the payments-pending
query, analytics, and the students API all branch on it. Each would need an
`interest` exclusion, and each miss means either a real payment mishandled or
an interest row silently auto-cancelled. Not worth taking regression risk on
live payment code to build a mailing list.

**Stateless HMAC-signed link, no token table.** Cheapest, and
`src/lib/tickets/sign.ts` already exists. Rejected: a single link cannot be
revoked, usage cannot be observed, and rotating the key invalidates the whole
list at once.

**Encrypting the token so it can be re-sent verbatim.** Would keep links
stable across resends. Rejected: it introduces key management and leaves a
credential readable to anyone with database access, departing from the
`scanner_api_keys` pattern for no benefit that rotation does not also provide.

## Data model

```sql
ALTER TABLE public.classes
  ADD COLUMN priority_open_at timestamptz;

ALTER TABLE public.classes
  ADD CONSTRAINT classes_priority_window_valid CHECK (
    priority_open_at IS NULL
    OR (enrollment_open_at IS NOT NULL AND priority_open_at <= enrollment_open_at)
  );

-- Enables the composite FK below.
ALTER TABLE public.intakes
  ADD CONSTRAINT intakes_id_tenant_uniq UNIQUE (id, tenant_id);
```

A priority window with no public open date would be an event only the list can
ever enter. The constraint refuses that configuration rather than relying on
the admin UI to prevent it.

`priority_open_at` stays on the **class**, so individual tiers can open at
different times even though interest is held at the intake level.

```sql
CREATE TABLE public.event_interest (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                     uuid NOT NULL,
  intake_id                     uuid NOT NULL,
  name                          text NOT NULL,
  email                         text NOT NULL,
  phone                         text,
  token_hash                    text NOT NULL UNIQUE,
  token_prefix                  text NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  last_link_sent_at             timestamptz,
  invited_at                    timestamptz,
  first_used_at                 timestamptz,
  first_converted_enrollment_id uuid REFERENCES public.enrollments(id) ON DELETE SET NULL,
  revoked_at                    timestamptz,

  -- Composite FK: guarantees tenant_id matches the intake's tenant.
  FOREIGN KEY (intake_id, tenant_id)
    REFERENCES public.intakes (id, tenant_id) ON DELETE CASCADE,

  CONSTRAINT event_interest_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT event_interest_name_len  CHECK (char_length(name)  BETWEEN 1 AND 120),
  CONSTRAINT event_interest_email_len CHECK (char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT event_interest_phone_len CHECK (phone IS NULL OR char_length(phone) <= 32)
);

CREATE UNIQUE INDEX event_interest_intake_email_uniq
  ON public.event_interest (intake_id, lower(email));
CREATE INDEX event_interest_tenant_intake_idx
  ON public.event_interest (tenant_id, intake_id);

ALTER TABLE public.event_interest ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only, matching tickets and scanner_api_keys.
```

The raw token exists only in the email and in the one-time signup response.

The composite FK closes the denormalisation gap that `tickets` leaves open:
`tenant_id` cannot drift from the intake's owner. The length CHECKs bound
input independently of any application validation.

## The gate

The gate lives in one place — inside the two RPCs, in the same transaction as
the seat decrement. The current unconditional refusal becomes:

```sql
IF v_class.enrollment_open_at IS NOT NULL AND now() < v_class.enrollment_open_at THEN
  IF NOT public.priority_access_granted(v_class.id, p_priority_token_hash) THEN
    RETURN jsonb_build_object('success', false, 'error', 'ENROLLMENT_NOT_OPEN', ...);
  END IF;
END IF;
```

```sql
CREATE FUNCTION public.priority_access_granted(p_class_id uuid, p_token_hash text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.classes c
    JOIN public.event_interest ei ON ei.intake_id = c.intake_id
    WHERE c.id            = p_class_id
      AND ei.token_hash   = p_token_hash
      AND ei.revoked_at   IS NULL
      AND c.priority_open_at IS NOT NULL
      AND now() >= c.priority_open_at
  );
$$;
```

The check is per class, so a cart carrying tiers from the token's own event
passes while any class from a different intake is judged on its own merits and
correctly denied. A single token parameter therefore suffices; no array or
token map is needed.

### Why the token is hashed in Node

The API route hashes the raw token with a dedicated `hashPriorityToken()`
helper (delegating to the shared SHA-256 in `src/lib/scanner/hash.ts`) and
passes the hash to the RPC. A distinct name keeps the credential's purpose
legible rather than borrowing `hashApiKey()` for something that is not an API
key.

This avoids adding a `pgcrypto` dependency for `digest()`. It is safe because
the RPCs are service-role only: no untrusted caller can reach them with a
stolen hash. Node performs a pure transformation; the decision stays in the
database, in the same transaction as the seat decrement.

### Migration hazard — must not be missed

Adding `p_priority_token_hash text DEFAULT NULL` creates a **new overload**. It
does not replace the existing function. Overload accumulation is precisely
what `20260719100000_restrict_enrollment_rpc_privileges.sql` was written to
clean up.

The migration must therefore:

1. `DROP FUNCTION` the old signatures explicitly
   (`submit_enrollment(uuid, text, integer)`,
   `submit_cart_enrollment(jsonb, uuid)`).
2. `CREATE` the new signatures.
3. **Re-apply `REVOKE ALL ... FROM PUBLIC, anon, authenticated` and the
   service_role grant.** A fresh `CREATE` restores PostgreSQL's default
   `EXECUTE TO PUBLIC`, silently re-opening what that migration closed. Missing
   this leaves a `SECURITY DEFINER` function reachable by `anon`.
4. Assert with `to_regprocedure(...)` that the required functions exist
   afterwards, following the fail-closed pattern that migration established.
5. `NOTIFY pgrst, 'reload schema';`

## Public surfaces

### Signup and resend

`POST /api/public/interest` — `{ intake_id, name, email, phone?, __hp }`,
reusing the honeypot convention from `src/app/api/public/enroll/route.ts`.

Because only a hash is stored, a lost link cannot be re-sent verbatim.
Recovery is therefore **rotation**:

- **First signup for this email on this event** — mint a token, store its
  hash, email the link, and return the raw token so the page can display it
  with a "save this link" prompt. The submitter has just demonstrated they are
  the person enrolling.
- **Repeat signup for an email already on the list** — mint a *new* token,
  replace the stored hash (invalidating the previous link), and email the new
  link to the address on file. The response says "we have emailed your link"
  and contains **no token**. Echoing it would let anyone harvest another
  person's link by typing their address into the public form.

**Accepted consequence:** because rotation sits on a public endpoint, a third
party who knows someone's email can invalidate that person's older link. They
gain no access — the new link goes only to the address on file, so the owner
always holds a working link. `last_link_sent_at` enforces a cooldown
(proposal: 15 minutes per email per intake) so this cannot be used to
mail-bomb. Requests inside the cooldown return the same generic success
without sending or rotating.

### Discovery

`GET /api/public/enroll/[slug]` extends its class select to carry
`priority_open_at` alongside the `opens_at` it already returns. The event page
shows an interest CTA when any class has a `priority_open_at` and sales have
not opened.

### Redemption

The emailed link is `https://<tenant>/enroll/<slug>?pa=<token>`. The event page
lifts it into `sessionStorage` under `pa_<slug>` — the same pattern already
used for the Messenger `psid` — and checkout includes it as `priority_token`
in the enroll POST. No new state-carrying mechanism is introduced.

**The link is issued at signup but inert until `priority_open_at`.** Visiting
it earlier shows the ordinary "opens on" state. This is deliberate: everyone
holds their link from the moment they sign up, so the admin invitation is a
*reminder*, not the delivery mechanism, and a window that opens before an
admin has sent invitations still works correctly for every person on the list.

On a successful enrollment during the window, the RPC stamps `first_used_at`
and `first_converted_enrollment_id` if they are null. The token remains valid
for the rest of the window: a mid-checkout browser failure must not strand a
legitimate person with a dead link.

**Accepted risk — links are forwardable.** A priority link is a bearer
credential tied to an event, not to a person; nothing binds it to the name or
email used at checkout. Someone may pass their head start to a friend, or post
it publicly. `max_tickets_per_person` bounds a single enrollment but does not
bound how many people use one shared link. This was chosen knowingly over
requiring phone confirmation at redemption. If it proves a problem, the
mitigation is to compare the checkout email against the interest record inside
the gate — an additive change to `priority_access_granted`.

## Admin

- A `priority_open_at` datetime input beside the existing `enrollment_open_at`
  field in `src/app/admin/intakes/[id]/page.tsx`.
- `PATCH /api/classes/[id]` and `POST /api/intakes/[id]/classes` accept
  `priority_open_at` with the same ISO-string-or-null validation
  `enrollment_open_at` already receives.
- A per-intake interest view: count, table (name, email, signed up, last link
  sent, invited, first used, converted), CSV export, per-row revoke, per-row
  resend. Admin-initiated resend rotates and bypasses the public cooldown.
- Hidden when `org_type = 'language_school'`, following the pattern in
  `src/app/api/admin/channels/route.ts`. No database-level restriction, so a
  later decision to offer this to schools is a UI change rather than a
  migration.

### Invitations

`POST /api/admin/interest/[intakeId]/invite` sends a reminder to rows not yet
invited. It does **not** rotate tokens — the link each person already holds
stays valid.

- Stamps `invited_at` **per row as each send succeeds**, so a partial failure
  re-runs only the remainder instead of double-mailing the whole list.
- `await`s the sends. Fire-and-forget is killed on Vercel serverless.
- Processes a bounded chunk per invocation and returns
  `{ sent, remaining }` so a large list can be drained across calls without
  hitting the function timeout.

## Email

Two new templates beside the existing four in `src/lib/email.ts`, built on
`baseLayout` so they inherit tenant name and logo:

1. **Interest confirmation** (signup and resend) — carries the `?pa=` link and
   states when it becomes usable. On a resend, states that previous links have
   stopped working.
2. **Priority window reminder** (admin invitation) — same link, sent when the
   window is about to open or has opened.

Resend and `FROM_EMAIL` are already wired.

## What deliberately does not change

No new `EnrollmentStatus`. Nothing in `check_expired_enrollments()`,
`verifyPayment`, `settlePaidPayment`, `settleMmqrPayment`, any of the five
webhooks, `issueTicketsForEnrollment`, or the payments tables.

An interest row never touches money, never holds a seat, and never expires.
Priority users take seats through the ordinary path, so `seat_remaining`,
`max_tickets_per_person`, and `enrollment_close_at` all keep working untouched.

## Failure modes

| Case | Result |
|---|---|
| No, invalid, or revoked token during the window | `ENROLLMENT_NOT_OPEN` — identical to today, and no leak of whether a token exists |
| Valid token, `priority_open_at` still in the future | Denied |
| Token for event A presented on a class of event B | Denied — the class's intake is part of the lookup |
| Cart mixing the token's own tiers with another event's | The own-event tiers pass; the foreign class is denied on its own merits |
| Superseded token after a rotation | Denied — its hash no longer exists |
| Resend requested inside the cooldown | Generic success, nothing sent, no rotation |
| After `enrollment_open_at` | Token irrelevant, public flow |
| `enrollment_close_at` passed | Denied, priority or not |
| Class full during the window | Ordinary `NOT_ENOUGH_SEATS` — a head start is not a guarantee |
| Email bounces | Person still holds the link shown on screen at signup; admin can resend |
| Window opens before admin sends invitations | Works — everyone received their link at signup |

## Testing

The gate is database logic operating under concurrency, so it belongs in the
DB suite (`vitest.db.config.ts`, alongside
`src/__tests__/db/seat-restoration.db.test.ts`). A mocked unit test would
prove nothing about it.

Required coverage:

- Every row of the failure-mode table above.
- A multi-tier cart authorised by one intake-level token.
- Concurrent priority enrollments against the last remaining seat.
- Rotation: the superseded hash stops granting access in the same transaction
  the new one starts working.
- The privilege assertion: after migration, `anon` and `authenticated` still
  cannot execute either RPC.
- The composite FK rejects an `event_interest` row whose `tenant_id` does not
  match its intake.
- Repeat signup returns no token.

Route-level tests follow the existing patterns in
`src/__tests__/api/public/`.

## Deployment

Standard project rules apply. Migration to the dev database
(`fnfvwzwrdsnmwxunciti`) first, with the diff shown before any push.
Production migration is a separate, gated step. `npm run build` locally before
pushing, judged by exit code.

## Open items for the implementation plan

- Exact token entropy and encoding (proposal: 32 random bytes, base64url,
  with `token_prefix` holding the first 8 characters for admin display).
- Final cooldown duration (proposal: 15 minutes per email per intake).
- Chunk size for the invite endpoint, based on Resend throughput and the
  Vercel function timeout.
- Whether the interest CTA also appears on the intake-level listing page or
  only on the event page.

## Review history

**v2 (2026-08-26)** — external review by Codex, working from the spec text
alone without repository access. Accepted and fixed: the hash-only resend
contradiction (P0), multi-class cart authorisation (P0, fixed at the root by
moving interest to the intake), `converted_enrollment_id` versus multi-use
(P1), email-timing ambiguity (P1), tenant-consistency enforcement (P2), and a
dedicated hash helper (P2). Accepted as documentation-only: link forwardability
and the limits of honeypot-plus-unique-index, both previously decided with
their tradeoffs stated — the review's specific additions of a resend cooldown
and bounded input lengths were adopted. Declined: a scheduled invitation job,
which the email-timing clarification makes unnecessary. Not raised by the
review: rotation on a public endpoint creates a griefing vector, addressed
here with the cooldown and by never returning a rotated token.
