# Event interest list with priority enrollment window

**Date:** 2026-08-26
**Status:** Approved (design), pending implementation plan
**Revision:** v4 (2026-08-27) — incorporates three rounds of external review (Codex)

## Problem

Clients want pre-enrollment for events without payment. On clarification, this
means an **expression of interest** list, not a free ticket and not a
pay-later invoice. People register interest in an event whose ticket sales
have not opened. They hold no seat and receive no ticket. When sales approach,
**holders of an access link** get a priority window: a head start during which
only they can enroll through the normal paid flow. At the public open time the
window ends and the event behaves exactly as it does today.

"Holders of an access link" is deliberate wording. The link is a bearer
credential tied to an event, not to a person — see *Accepted risk* under
Redemption.

### Decisions taken during design

| Question | Decision |
|---|---|
| What "pre-enrollment without payment" means | Expression of interest / waitlist |
| What happens when sales open | Priority window (early access), not notify-and-requeue |
| What interest attaches to | The **intake** (the event), not a single ticket tier |
| Capacity during the window | Pure head start — same seat pool, no reserved quota |
| Credential | Secret link, one per person per event |
| Link transport | URL **fragment**, never a query parameter |
| Delivery | Email at signup, plus the link shown on screen |
| Window control | Scheduled, via `priority_open_at` on the **intake** |
| Token reuse | Multi-use for the whole window, first use recorded |
| Lost link recovery | Rotate on resend, with a grace period on the old token |
| Signup cutoff | Closes when the priority window opens |
| Spam control | IP+intake creation limit, honeypot, unique `(intake_id, email)` index, resend cooldown, input bounds |
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
- The house pattern for a new function is three `REVOKE`s (`PUBLIC`, `anon`,
  `authenticated`) plus an explicit grant to the role that needs it — see
  `20260719031500_fix_seat_restoration_ownership.sql`.
- `classes` is `UNIQUE (intake_id, level)` — **a class is a ticket tier within
  an event, and the intake is the event.** The `tickets` table takes its
  `tier` from `classes.level`.
- Carts are built per-intake on `/enroll/[slug]`, and each cart item carries
  its own `class_id` (`handleCartCheckout`). `submit_cart_enrollment` loops
  over them and enforces same-tenant, but not same-intake.
- `resolveTenantId()` (`src/lib/api.ts`) resolves the tenant from the
  subdomain or `x-tenant-slug`. Public routes must scope writes to it.
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

A standalone `event_interest` table holding a hashed token per person **per
event (intake)**, and a new `intakes.priority_open_at`. The two enrollment
RPCs gain a token-hash parameter; when a class's public window has not opened
they consult the interest table for that class's intake instead of refusing
outright.

Holding both the interest record and the window at the intake keeps one
promise true: **one token, every tier, one moment.** No token array, no
per-tier eligibility to explain, and multi-tier cart checkout works unchanged.

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
stable across resends. Rejected: key management, plus a credential readable to
anyone with database access, for no benefit that rotation-with-grace does not
also provide.

**A token-versions child table.** Proposed in review to make rotation safe
across email failures. The two-slot grace period below gives the same
guarantee with one column pair and no join in the gate.

**Per-tier priority windows.** Would allow staggered early access (VIP before
Regular). Rejected as unrequested complexity: it makes "one token, every tier"
false and forces per-tier eligibility into the CTA, the email, and the
checkout error. Public sale times remain per-tier, so staggering is still
available where it already existed.

## Data model

```sql
ALTER TABLE public.intakes
  ADD COLUMN priority_open_at timestamptz;

-- Enables the composite FK below.
ALTER TABLE public.intakes
  ADD CONSTRAINT intakes_id_tenant_uniq UNIQUE (id, tenant_id);
```

The window lives on the intake, but public sale times remain per class. The
relationship between them cannot be a table CHECK because it spans two tables,
so it is a trigger on both sides:

```sql
CREATE FUNCTION public.assert_priority_window_valid(p_intake_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_priority timestamptz;
BEGIN
  SELECT priority_open_at INTO v_priority
  FROM public.intakes WHERE id = p_intake_id;

  IF v_priority IS NULL THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1 FROM public.classes
    WHERE intake_id = p_intake_id
      AND enrollment_open_at IS NOT NULL
      AND enrollment_open_at < v_priority
  ) THEN
    RAISE EXCEPTION
      'priority_open_at must not be later than any ticket tier''s enrollment_open_at';
  END IF;
END $$;
```

Fired `AFTER INSERT OR UPDATE` on `intakes` (when `priority_open_at` changes)
and on `classes` (when `enrollment_open_at` or `intake_id` changes). A tier
with a null `enrollment_open_at` is already on sale, so the priority gate never
engages for it and it is exempt.

```sql
CREATE TABLE public.event_interest (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                     uuid NOT NULL,
  intake_id                     uuid NOT NULL,
  name                          text NOT NULL,
  email                         text NOT NULL,       -- stored trimmed + lowercased
  phone                         text,
  token_hash                    text NOT NULL UNIQUE,
  token_prefix                  text NOT NULL,
  superseded_token_hash         text,
  superseded_expires_at         timestamptz,
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
  CONSTRAINT event_interest_superseded_format CHECK (
    superseded_token_hash IS NULL OR superseded_token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT event_interest_superseded_paired CHECK (
    (superseded_token_hash IS NULL) = (superseded_expires_at IS NULL)
  ),
  CONSTRAINT event_interest_email_canonical CHECK (email = lower(btrim(email))),
  CONSTRAINT event_interest_name_len  CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT event_interest_email_len CHECK (char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT event_interest_phone_len CHECK (phone IS NULL OR char_length(phone) <= 32)
);

CREATE UNIQUE INDEX event_interest_intake_email_uniq
  ON public.event_interest (intake_id, email);
CREATE INDEX event_interest_superseded_idx
  ON public.event_interest (superseded_token_hash)
  WHERE superseded_token_hash IS NOT NULL;
CREATE INDEX event_interest_tenant_intake_idx
  ON public.event_interest (tenant_id, intake_id);

ALTER TABLE public.event_interest ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only, matching tickets and scanner_api_keys.
```

The raw token exists only in the email and in the one-time signup response.

`email` is stored already trimmed and lowercased, and the CHECK enforces it, so
the unique index needs no `lower()` wrapper and whitespace variants cannot
create duplicate rows. Application-side normalisation and database truth cannot
drift apart.

The composite FK closes the denormalisation gap that `tickets` leaves open:
`tenant_id` cannot drift from the intake's owner.

### Signup rate limiting

Signup emails a link, so the public endpoint can send branded mail from the
tenant's Resend domain to any address a caller supplies. The cost of abuse is
not junk rows — it is Resend spend and sender-reputation damage on the same
domain that delivers payment email. That warrants a real counter, which this
codebase does not yet have.

```sql
CREATE TABLE public.interest_signup_attempts (
  id         bigserial PRIMARY KEY,
  intake_id  uuid NOT NULL REFERENCES public.intakes(id) ON DELETE CASCADE,
  ip_hash    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT interest_signup_attempts_ip_format CHECK (ip_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX interest_signup_attempts_lookup
  ON public.interest_signup_attempts (intake_id, ip_hash, created_at DESC);
CREATE INDEX interest_signup_attempts_prune
  ON public.interest_signup_attempts (created_at);

ALTER TABLE public.interest_signup_attempts ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only.
```

`ip_hash` is `sha256(ip + server-side salt)`, never the raw address: the table
exists to count, not to build a log of who visited. The salt lives in an
environment variable alongside the other secrets.

Two limits, both checked before any insert or send:

- per `(ip_hash, intake_id)` — the narrow case, someone hammering one event;
- per `ip_hash` across all intakes — the broad case, a script walking events.

Rows older than the longest window are pruned opportunistically on write, so
the table stays small without a scheduled job.

**This is a cost and reputation control, not a security boundary.** The client
address comes from `NextRequest.ip`, falling back to the first `x-forwarded-for`
entry, and forwarded headers are attacker-influenced in the general case.
Treating it as an authorisation mechanism would repeat the tenant-header
mistake this codebase has already paid for; it raises the cost of abuse and
nothing more.

## The gate

The gate lives in one place — inside the two RPCs, in the same transaction as
the seat decrement:

```sql
IF v_class.enrollment_open_at IS NOT NULL AND now() < v_class.enrollment_open_at THEN
  IF NOT public.priority_access_granted(v_class.id, p_priority_token_hash) THEN
    RETURN jsonb_build_object('success', false, 'error', 'ENROLLMENT_NOT_OPEN', ...);
  END IF;
END IF;
```

```sql
CREATE FUNCTION public.priority_access_granted(p_class_id uuid, p_token_hash text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.classes c
    JOIN public.intakes i        ON i.id = c.intake_id
    JOIN public.event_interest ei ON ei.intake_id = c.intake_id
    WHERE c.id          = p_class_id
      AND ei.revoked_at IS NULL
      AND i.priority_open_at IS NOT NULL
      AND now() >= i.priority_open_at
      AND (
            ei.token_hash = p_token_hash
        OR (ei.superseded_token_hash = p_token_hash
            AND now() < ei.superseded_expires_at)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.priority_access_granted(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
```

Two deliberate choices here.

**It is not `SECURITY DEFINER`.** It is only ever called from inside the two
enrollment RPCs, which are definer-owned; a nested invoker function runs with
the outer function's rights, so definer buys nothing and would add an
escalation surface. Combined with the revokes — and with RLS enabled and no
policies on `event_interest` — a direct call by `anon` is both unprivileged and
fruitless. The owner retains `EXECUTE` implicitly, so no grant is needed.

**Access is evaluated per class but the window is per intake**, so a cart
carrying several tiers of the token's own event passes as a unit. A single
token parameter therefore suffices.

Cart validation is all-or-nothing: `submit_cart_enrollment` checks every item
in Phase 1 and returns on the first failure, before Phase 2 creates anything.
A cart mixing the token's own tiers with a class from a different intake
therefore fails **entirely** — not partially. The RPC enforces same-tenant but
not same-intake, so such a cart is constructible even though the UI, which
builds carts per `/enroll/[slug]`, never produces one. That is left as it is:
the case already fails safely, and adding a restriction to an RPC on the live
payment path is scope this change set does not need.

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
   `EXECUTE TO PUBLIC`, silently re-opening what that migration closed.
4. Apply the same revokes to `priority_access_granted` and
   `assert_priority_window_valid`. Every new function in this migration is
   subject to the same default.
5. Assert with `to_regprocedure(...)` that the required functions exist
   afterwards, following the fail-closed pattern that migration established.
6. `NOTIFY pgrst, 'reload schema';`

## Public surfaces

### Signup and resend

`POST /api/public/interest` — `{ intake_id, name, email, phone?, __hp }`,
reusing the honeypot convention from `src/app/api/public/enroll/route.ts`.

**Eligibility is validated server-side before anything is written:**

- The intake must belong to the tenant returned by `resolveTenantId()`. A
  client-supplied `intake_id` from another tenant is rejected, not merely
  stored consistently — the composite FK would happily record a row consistent
  with the *wrong* tenant.
- The intake must have `priority_open_at` set, and `now()` must be **before**
  it. Signup closes when the window opens: otherwise anyone could mint
  themselves a token at that moment and the head start would be available to
  the general public, defeating the feature.
- The intake must not be closed or cancelled.
- `email` is trimmed and lowercased, `name` and `phone` trimmed, before both
  lookup and insert.
- The signup rate limits above are checked before any row is written or any
  mail is sent. A caller over the limit receives the same generic success as
  everyone else — telling a script when it has been throttled only helps it
  calibrate.

Because only a hash is stored, a lost link cannot be re-sent verbatim.
Recovery is **rotation with a grace period**:

- **First signup for this email on this event** — mint a token, store its
  hash, email the link, and return the raw token so the page can display it
  with a "save this link" prompt. The submitter has just demonstrated they are
  the person enrolling.
- **Repeat signup** — mint a new token, move the current hash into
  `superseded_token_hash` with `superseded_expires_at = now() + grace`, and
  email the new link to the address on file. The response says "we have
  emailed your link" and contains **no token**. Echoing it would let anyone
  harvest another person's link by typing their address into the public form.

The first-signup response carries a live credential in its body, so it is
returned with `Cache-Control: no-store` and must never be recorded by
application, CDN, or diagnostic logging. Request/response body logging on this
route is prohibited, and the raw token must not appear in any log line. This
complements moving the token out of the query string; neither substitutes for
the other.

The grace period is what makes rotation safe across a failed send. Rotating and
emailing cannot be one atomic operation — the mail server is not in the
transaction — so if delivery fails after the row is updated, the person's
existing link keeps working until the grace expires. `last_link_sent_at` is
stamped **only on a successful send**, so a failure does not start the cooldown
and the request can be retried immediately.

The superseded hash is cleared the first time the new token is used, so a
successful rotation narrows to one live credential as soon as it is confirmed.

**Accepted consequence:** rotation sits on a public endpoint, so a third party
who knows someone's email can force a rotation. They gain no access — the new
link goes only to the address on file — and the grace period means the victim's
current link keeps working meanwhile. `last_link_sent_at` enforces a cooldown
(proposal: 15 minutes per email per intake); requests inside it return the same
generic success without sending or rotating.

### Discovery

`GET /api/public/enroll/[slug]` returns the intake's `priority_open_at`
alongside the `opens_at` it already provides. The event page shows an interest
CTA when `priority_open_at` is set and still in the future, and stops showing
it once the window opens.

### Redemption

The emailed link is `https://<tenant>/enroll/<slug>#pa=<token>`.

**The token travels in the URL fragment, never a query parameter.** A fragment
is not sent to the server, so it stays out of Vercel request logs, out of
`Referer` headers on any outbound link, and out of server-side analytics. The
event page reads `location.hash`, moves the token into `sessionStorage` under
`pa_<slug>`, and immediately strips it with `history.replaceState` so it does
not linger in the address bar or in browser history entries created afterwards.
Checkout then includes it as `priority_token` in the enroll POST body.

**The link is issued at signup but inert until `priority_open_at`.** Visiting
it earlier shows the ordinary "opens on" state. This is deliberate: everyone
holds their link from the moment they sign up, so the admin invitation is a
*reminder*, not the delivery mechanism, and a window that opens before an admin
has sent invitations still works correctly for every person on the list.

On a successful enrollment during the window the RPC stamps `first_used_at` and
`first_converted_enrollment_id` if they are null, and clears any superseded
token. The token stays valid for the rest of the window: a mid-checkout browser
failure must not strand someone with a dead link.

**Accepted risk — links are forwardable.** A priority link is a bearer
credential tied to an event, not to a person; nothing binds it to the name or
email used at checkout. Someone may pass their head start to a friend or post
it publicly, and `max_tickets_per_person` bounds a single enrollment but not how
many people use one shared link. This was chosen knowingly over requiring phone
confirmation at redemption, and it is why user-facing copy says "holders of an
access link" rather than promising exclusivity. If it proves a problem, the
mitigation is to compare the checkout email against the interest record inside
the gate — an additive change to `priority_access_granted`.

## Admin

- A `priority_open_at` datetime input on the intake editor in
  `src/app/admin/intakes/[id]/page.tsx`, with the trigger's rule surfaced as a
  validation message rather than a raw database error.
- The intake update route accepts `priority_open_at` with the same
  ISO-string-or-null validation `enrollment_open_at` already receives.
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
- Processes a bounded chunk per invocation and returns `{ sent, remaining }` so
  a large list can be drained across calls without hitting the function
  timeout.

## Email

Two new templates beside the existing four in `src/lib/email.ts`, built on
`baseLayout` so they inherit tenant name and logo:

1. **Interest confirmation** (signup and resend) — carries the `#pa=` link and
   states when it becomes usable. On a resend, states that the previous link
   stops working shortly.
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
| Cart mixing the token's own tiers with another event's | **The whole cart fails.** `submit_cart_enrollment` validates every item in Phase 1 and returns on the first failure, before Phase 2 creates anything — there is no partial success |
| Signup over the IP rate limit | Generic success, nothing written, no mail sent |
| Superseded token inside its grace period | Accepted |
| Superseded token after the grace expires | Denied |
| Rotation succeeded but the email failed | Old link works until grace expiry; cooldown not stamped, so retry is immediate |
| Resend requested inside the cooldown | Generic success, nothing sent, no rotation |
| Signup attempted after the window opens | Rejected — no self-minted head start |
| Signup with another tenant's `intake_id` | Rejected before any write |
| Email differing only by case or whitespace | Collapses to the existing row; no duplicate token |
| After `enrollment_open_at` | Token irrelevant, public flow |
| `enrollment_close_at` passed | Denied, priority or not |
| Class full during the window | Ordinary `NOT_ENOUGH_SEATS` — a head start is not a guarantee |
| Email bounces | Person still holds the link shown on screen at signup; admin can resend |
| Window opens before admin sends invitations | Works — everyone received their link at signup |
| `priority_open_at` set later than a tier's sale time | Rejected by the trigger, on either table |

## Testing

The gate is database logic operating under concurrency, so it belongs in the DB
suite (`vitest.db.config.ts`, alongside
`src/__tests__/db/seat-restoration.db.test.ts`). A mocked unit test would prove
nothing about it.

Required coverage:

- Every row of the failure-mode table above.
- A multi-tier cart authorised by one intake-level token.
- Concurrent priority enrollments against the last remaining seat.
- Rotation: new token works, old token works until grace expiry, old token dies
  after it, and first use of the new token clears the superseded slot.
- The privilege assertions: after migration `anon` and `authenticated` cannot
  execute either RPC, nor `priority_access_granted`.
- The composite FK rejects an `event_interest` row whose `tenant_id` does not
  match its intake.
- The window trigger fires from both directions — editing the intake, and
  editing a class.
- Repeat signup returns no token.

- A cart mixing intakes fails wholesale, with no enrollment row and no seat
  decremented for the token's own tiers.
- The signup rate limits: both the per-intake and the cross-intake counter
  throttle, a throttled caller gets the same generic success as a permitted
  one, and no mail is sent.

Route-level tests follow the existing patterns in `src/__tests__/api/public/`,
including that the token never appears in a query string or a `Referer`, and
that the first-signup response carries `Cache-Control: no-store`.

## Deployment

Standard project rules apply. Migration to the dev database
(`fnfvwzwrdsnmwxunciti`) first, with the diff shown before any push. Production
migration is a separate, gated step. `npm run build` locally before pushing,
judged by exit code.

## Open items for the implementation plan

- Exact token entropy and encoding (proposal: 32 random bytes, base64url, with
  `token_prefix` holding the first 8 characters for admin display).
- Grace period duration for a superseded token (proposal: 24 hours).
- Final cooldown duration (proposal: 15 minutes per email per intake).
- Signup rate-limit thresholds and windows (proposal: 5 per hour per
  `(ip_hash, intake_id)`, 20 per hour per `ip_hash` across intakes), and the
  prune horizon.
- Chunk size for the invite endpoint, based on Resend throughput and the Vercel
  function timeout.
- Whether the interest CTA also appears on the intake-level listing page or
  only on the event page.

## Review history

**v2 (2026-08-26)** — external review by Codex, from the spec text alone
without repository access. Accepted and fixed: the hash-only resend
contradiction (P0), multi-class cart authorisation (P0, fixed at the root by
moving interest to the intake), `converted_enrollment_id` versus multi-use
(P1), email-timing ambiguity (P1), tenant-consistency enforcement (P2), and a
dedicated hash helper (P2). Accepted as documentation-only: link forwardability
and the limits of honeypot-plus-unique-index, both previously decided with
their tradeoffs stated — the review's additions of a resend cooldown and
bounded input lengths were adopted. Declined: a scheduled invitation job, which
the email-timing clarification makes unnecessary.

**v3 (2026-08-26)** — second review round. Accepted and fixed: the token
travelling in a query string (P0 — now a fragment, stripped after read),
`priority_access_granted` left executable by `PUBLIC` (P0 — now invoker, with
the house revokes, in the same document that warned about this exact default),
rotation unsafe across email failure (P0 — two-slot grace period rather than
the proposed token-versions table), "one token, every tier" being false against
per-class windows (P1 — the window moved to the intake rather than the prose
being softened), the exclusivity promise conflicting with forwardable links
(P1 — wording changed to "holders of an access link"), missing signup
eligibility validation (P1 — tenant ownership and intake state now checked
before any write), and email canonicalisation (P2 — normalised at the boundary
and enforced by CHECK).

**v4 (2026-08-27)** — third review round, conducted against a stale copy of v2
rather than the committed v3, so its claim that the round-two findings were
unincorporated does not hold against this document. Its three new findings were
assessed on their own merits. Accepted and fixed: the mixed-cart failure
description, which wrongly implied partial success when
`submit_cart_enrollment` validates every item before creating anything — the
error was live in v3; and `Cache-Control: no-store` plus a logging prohibition
on the response that carries a raw token. Reversed from two earlier rounds:
signup rate limiting, previously declined twice, is now in — not because it was
raised a third time, but because v3 made signup send email, turning the
endpoint into an unauthenticated trigger for branded mail from the domain that
also delivers payment email. The premise the earlier decision rested on had
changed. Declined: enforcing same-intake carts in the RPC, which is tidiness
rather than a fix — the case already fails safely, and it would mean a
behavioural change to the live payment path.

Raised by neither review, found while applying them: **interest signup had to
close at `priority_open_at`.** Left open, anyone could have registered during
the window and minted themselves a token on the spot, which would have made the
head start available to the general public and defeated the feature.
