# Event interest list with priority enrollment window

**Date:** 2026-08-26
**Status:** Approved (design), pending implementation plan

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
| What interest attaches to | A specific class (event) that already exists |
| Capacity during the window | Pure head start — same seat pool, no reserved quota |
| Credential | Secret link, one per person |
| Delivery | Email, plus the link shown on screen at signup |
| Window control | Scheduled, via a new `priority_open_at` on the class |
| Token reuse | Multi-use for the whole window, first use recorded |
| Spam control | Existing honeypot + unique `(class_id, email)` index |
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
- `confirmed` is reached only through payment settlement
  (`verifyPayment`, `settlePaidPayment`, `settleMmqrPayment`, five webhooks),
  and `issueTicketsForEnrollment` is called only from those same paths.
- `check_expired_enrollments()` auto-cancels anything left in
  `pending_payment` past `auto_cancel_hours` (which holds **minutes**).
- Seats are decremented at enrollment time, before any payment.
- `scanner_api_keys` + `src/lib/scanner/hash.ts` establish the house pattern
  for a bearer credential: store `sha256(raw)`, keep a display prefix, RLS
  enabled with no policies, service-role access only.
- `src/app/api/public/enroll/route.ts` uses an `__hp` honeypot field.
- The event page already lifts a URL parameter into client state for the
  Messenger `psid` (`src/app/(public)/enroll/[slug]/page.tsx`).
- **There is no rate-limiting infrastructure in `src/`.**

## Approach

A standalone `event_interest` table holding one hashed token per person, and a
new `classes.priority_open_at`. The two enrollment RPCs gain a token-hash
parameter; when the public window has not opened they consult the interest
table instead of refusing outright.

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
list at once. For a credential emailed to strangers weeks before it matters,
revocability is worth a table.

## Data model

```sql
ALTER TABLE public.classes
  ADD COLUMN priority_open_at timestamptz;

ALTER TABLE public.classes
  ADD CONSTRAINT classes_priority_window_valid CHECK (
    priority_open_at IS NULL
    OR (enrollment_open_at IS NOT NULL AND priority_open_at <= enrollment_open_at)
  );
```

A priority window with no public open date would be an event only the list can
ever enter. The constraint refuses that configuration rather than relying on
the admin UI to prevent it.

```sql
CREATE TABLE public.event_interest (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES public.tenants(id)     ON DELETE CASCADE,
  class_id                uuid NOT NULL REFERENCES public.classes(id)     ON DELETE CASCADE,
  name                    text NOT NULL,
  email                   text NOT NULL,
  phone                   text,
  token_hash              text NOT NULL UNIQUE,
  token_prefix            text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  invited_at              timestamptz,
  first_used_at           timestamptz,
  converted_enrollment_id uuid REFERENCES public.enrollments(id) ON DELETE SET NULL,
  revoked_at              timestamptz
);

CREATE UNIQUE INDEX event_interest_class_email_uniq
  ON public.event_interest (class_id, lower(email));
CREATE INDEX event_interest_tenant_class_idx
  ON public.event_interest (tenant_id, class_id);

ALTER TABLE public.event_interest ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only, matching tickets and scanner_api_keys.
```

The raw token exists only in the email and in the one-time signup response.

The unique index on `(class_id, lower(email))` does real work: it makes a
repeat signup idempotent instead of minting a second token and silently
invalidating the link already sitting in someone's inbox.

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
    FROM public.event_interest ei
    JOIN public.classes c ON c.id = ei.class_id
    WHERE ei.class_id   = p_class_id
      AND ei.token_hash = p_token_hash
      AND ei.revoked_at IS NULL
      AND c.priority_open_at IS NOT NULL
      AND now() >= c.priority_open_at
  );
$$;
```

### Why the token is hashed in Node

The API route hashes the raw token with the existing `hashApiKey()`
(`src/lib/scanner/hash.ts`) and passes the hash to the RPC. This avoids adding
a `pgcrypto` dependency for `digest()` and reuses the established credential
pattern. It is safe because the RPCs are service-role only: no untrusted
caller can reach them with a stolen hash. Node performs a pure transformation;
the decision stays in the database, in the same transaction as the seat
decrement.

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

### Signup

`POST /api/public/interest` — `{ class_id, name, email, phone?, __hp }`,
reusing the honeypot convention from `src/app/api/public/enroll/route.ts`.

Response rules, which differ by case and matter for security:

- **First signup for this email on this class** — mint token, store hash,
  return the raw token so the page can display it with a "save this link"
  prompt. The submitter has just demonstrated they are the person enrolling.
- **Repeat signup for an email already on the list** — return success with a
  "we have re-sent your link" message and **no token**. The existing token is
  re-emailed to the address on file. Echoing it back would let anyone harvest
  another person's link by typing their address into the public form.

### Discovery

`GET /api/public/enroll/[slug]` extends its class select to carry
`priority_open_at` alongside the `opens_at` it already returns. The event page
shows an interest CTA when `priority_open_at` is set and sales have not opened.

### Redemption

The emailed link is `https://<tenant>/enroll/<slug>?pa=<token>`. The event page
lifts it into `sessionStorage` under `pa_<slug>` — the same pattern already
used for the Messenger `psid` — and checkout includes it as `priority_token`
in the enroll POST. No new state-carrying mechanism is introduced.

On a successful enrollment during the window, the RPC stamps `first_used_at`
(if null) and `converted_enrollment_id`. The token remains valid for the rest
of the window: a mid-checkout browser failure must not strand a legitimate
person with a dead link, and `max_tickets_per_person` already caps how much
any one person can take.

## Admin

- A `priority_open_at` datetime input beside the existing `enrollment_open_at`
  field in `src/app/admin/intakes/[id]/page.tsx`.
- `PATCH /api/classes/[id]` and `POST /api/intakes/[id]/classes` accept
  `priority_open_at` with the same ISO-string-or-null validation
  `enrollment_open_at` already receives.
- A per-class interest view: count, table (name, email, signed up, invited,
  first used, converted), CSV export, per-row revoke, per-row resend.
- Hidden when `org_type = 'language_school'`, following the pattern in
  `src/app/api/admin/channels/route.ts`. No database-level restriction, so a
  later decision to offer this to schools is a UI change rather than a
  migration.

### Invitations

`POST /api/admin/interest/[classId]/invite` sends to un-invited rows.

- Stamps `invited_at` **per row as each send succeeds**, so a partial failure
  re-runs only the remainder instead of double-mailing the whole list.
- `await`s the sends. Fire-and-forget is killed on Vercel serverless.
- Processes a bounded chunk per invocation and returns
  `{ sent, remaining }` so a large list can be drained across calls without
  hitting the function timeout.

## Email

One new template beside the existing four in `src/lib/email.ts`, built on
`baseLayout` so it inherits tenant name and logo. It carries the `?pa=` link,
the event, and both window boundaries. Resend and `FROM_EMAIL` are already
wired.

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
| Class A's token presented on class B | Denied — `class_id` is part of the lookup |
| After `enrollment_open_at` | Token irrelevant, public flow |
| `enrollment_close_at` passed | Denied, priority or not |
| Class full during the window | Ordinary `NOT_ENOUGH_SEATS` — a head start is not a guarantee |
| Email bounces | Person still holds the link shown on screen at signup; admin can resend |

## Testing

The gate is database logic operating under concurrency, so it belongs in the
DB suite (`vitest.db.config.ts`, alongside
`src/__tests__/db/seat-restoration.db.test.ts`). A mocked unit test would
prove nothing about it.

Required coverage:

- Every row of the failure-mode table above.
- Concurrent priority enrollments against the last remaining seat.
- The privilege assertion: after migration, `anon` and `authenticated` still
  cannot execute either RPC.
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
- Chunk size for the invite endpoint, based on Resend throughput and the
  Vercel function timeout.
- Whether the interest CTA also appears on the intake-level listing page or
  only on the event page.
