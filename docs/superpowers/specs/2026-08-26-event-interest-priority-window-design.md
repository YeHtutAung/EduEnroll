# Event interest list with priority enrollment window

**Date:** 2026-08-26
**Status:** Approved (design), pending implementation plan
**Revision:** v14 (2026-08-30) — incorporates five rounds of external review (Codex)

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
| Link minting | A link is created only at the moment it is emailed or displayed, and always persisted before it is sent |
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
  -- FOR UPDATE, not a plain read. The two triggers fire on different tables,
  -- so under READ COMMITTED a transaction moving the intake's priority_open_at
  -- later and a concurrent transaction moving a tier's enrollment_open_at
  -- earlier would each validate against the other's pre-commit state, both
  -- pass, and leave the invariant violated once both commit. Locking the
  -- intake row serialises every validation for that event.
  SELECT priority_open_at INTO v_priority
  FROM public.intakes WHERE id = p_intake_id
  FOR UPDATE;

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
  last_link_attempt_at          timestamptz,
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

**`first_converted_enrollment_id` gets no such guarantee.** It is a bare FK to
`enrollments(id)`, and the same composite trick is unavailable because
`enrollments` has no `UNIQUE (id, tenant_id)` to reference. The schema
therefore cannot stop an interest row from pointing at an enrollment belonging
to another tenant or another event. Whatever writes that column must verify the
match itself — this is a requirement on the enrollment RPC, not something the
constraints will catch.

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

-- Serves v_intake_count: (ip_hash, intake_id, created_at) equality on the
-- first two, range on the third.
CREATE INDEX interest_signup_attempts_lookup
  ON public.interest_signup_attempts (intake_id, ip_hash, created_at DESC);

-- Serves both the scoped prune and v_global_count, which lead with ip_hash and
-- range on created_at. Deliberately NOT an index on created_at alone: once the
-- prune became per-address, no query filters on created_at without also
-- filtering on ip_hash, so a created_at-only index would serve nothing.
CREATE INDEX interest_signup_attempts_ip_window
  ON public.interest_signup_attempts (ip_hash, created_at);

ALTER TABLE public.interest_signup_attempts ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only.
```

`ip_hash` is `HMAC-SHA-256(secret, canonical_ip)`, never the raw address: the
table exists to count, not to build a log of who visited. A keyed MAC rather
than `sha256(ip + salt)` — concatenating a salt leaves the delimiter and
ordering as unstated conventions that a later edit can silently change, while
HMAC states the construction. `canonical_ip` is normalised first (IPv6
lowercased **and compressed to RFC 5952 form**, IPv4-mapped forms reduced) so
one client cannot occupy several buckets.

Compression is not cosmetic. A single IPv6 address has many valid textual
forms — leading zeros in any group, and `::` at any run of zeros — so lowercase
alone lets one client mint a fresh bucket per spelling and walk straight past
the limit. That is a bypass, not a degradation, and it is the whole reason the
limiter exists. The secret lives in an environment variable alongside
the others.

Two limits, both checked before any insert or send:

- per `(ip_hash, intake_id)` — the narrow case, someone hammering one event;
- per `ip_hash` across all intakes — the broad case, a script walking events.

**Checking and consuming a slot must be one serialized operation.** A
count-then-insert from the application races: concurrent requests from one
address each observe capacity, then all insert and all send. That is precisely
the flood the limiter exists to stop, so the check and the insert live in a
single database function under a transaction-scoped advisory lock keyed on the
address hash:

```sql
CREATE FUNCTION public.consume_interest_signup_slot(
  p_intake_id uuid,
  p_ip_hash   text,
  p_per_intake_limit integer,
  p_global_limit     integer,
  p_window           interval
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_intake_count integer; v_global_count integer;
BEGIN
  -- Serializes every concurrent request from this address for the rest of
  -- the transaction; released automatically on commit or rollback.
  -- Two-argument form: the first key is a constant reserved for this feature,
  -- so this cannot collide with an advisory lock taken by unrelated code. The
  -- keyspace is global to the database, not scoped to a function or table.
  --
  -- hashtext(), NOT hashtextextended(). Postgres offers only two overloads,
  -- pg_advisory_xact_lock(bigint) and (int, int) — there is no (bigint,
  -- bigint). hashtextextended returns bigint, so the two-key call fails to
  -- resolve, and narrowing casts are never implicit. Casting explicitly does
  -- not rescue it either: the bigint overflows int4 and raises at runtime.
  -- hashtext returns int4 natively and is the idiom for this form.
  --
  -- This fails at CALL time, not at CREATE time: PL/pgSQL prepares embedded
  -- statements on first execution, so a wrong overload here compiles clean,
  -- applies clean, and throws on the first real signup.
  PERFORM pg_advisory_xact_lock(
    hashtext('event_interest_signup'),
    hashtext(p_ip_hash)
  );

  -- Scoped to this address, NOT global. The lock is per-IP, so an unqualified
  -- delete would let two callers holding different locks contend over the same
  -- rows — serialising unrelated addresses behind each other, or deadlocking
  -- outright and surfacing a hard error to a legitimate signup. That happens
  -- under burst traffic, which is when a rate limiter is load-bearing.
  --
  -- This is complete for correctness: both counts below filter on ip_hash, so
  -- another address's stale rows can never affect this address's decision.
  -- Pruning globally is housekeeping, not correctness, and does not belong on
  -- the hot path.
  DELETE FROM public.interest_signup_attempts
   WHERE ip_hash = p_ip_hash
     AND created_at < now() - p_window;

  SELECT count(*) INTO v_intake_count
    FROM public.interest_signup_attempts
   WHERE ip_hash = p_ip_hash AND intake_id = p_intake_id
     AND created_at >= now() - p_window;

  SELECT count(*) INTO v_global_count
    FROM public.interest_signup_attempts
   WHERE ip_hash = p_ip_hash
     AND created_at >= now() - p_window;

  IF v_intake_count >= p_per_intake_limit OR v_global_count >= p_global_limit THEN
    RETURN false;
  END IF;

  INSERT INTO public.interest_signup_attempts (intake_id, ip_hash)
  VALUES (p_intake_id, p_ip_hash);

  RETURN true;
END $$;
```

The `DELETE` prunes only the calling address's expired rows. Rows belonging to
addresses that never return are left behind; the table therefore grows slowly
with the number of distinct addresses that ever signed up, which is bounded by
real traffic and is not a correctness problem. If it ever needs trimming, that
belongs in an out-of-band sweep, never on the hot path of a rate limiter.

Like every other function this migration creates, it is revoked from `PUBLIC`,
`anon`, and `authenticated`, and granted only to `service_role`.

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

  **The route's check is not the enforcement.** A route that checks the time,
  then awaits a rate-limiter call and a lookup, then inserts, can admit a
  request before the window and create the row after it — the cutoff is a
  moment in time and those awaits are not free. A `BEFORE INSERT` trigger on
  `event_interest` re-reads the intake and raises once the window has opened,
  making the check and the write one operation and closing it for every writer,
  not just this route.

  The trigger fires on `INSERT` only. Rotation is an `UPDATE`, so someone
  already on the list can still recover a lost link during the window — they
  are not signing up, they are re-reading something they were already owed.
- The intake's status must be `open` or `draft`. `intake_status` is
  `('draft','open','closed')` — there is no `cancelled` value, despite earlier
  revisions of this document referring to one. Written as an allowlist rather
  than a denylist on `closed`, so that adding a future status fails closed
  instead of silently admitting it.

  `draft` is deliberately included: a draft intake already renders publicly as
  "coming soon", which is exactly the state in which registering interest makes
  sense.
- `email` is trimmed and lowercased, `name` and `phone` trimmed, before both
  lookup and insert.
- The signup rate limits above are checked before any row is written or any
  mail is sent. A caller over the limit receives the same generic success as
  everyone else — telling a script when it has been throttled only helps it
  calibrate.

Because only a hash is stored, a lost link cannot be re-sent verbatim.
Recovery is **rotation with a grace period**:

- **First signup for this email on this event** — write the row and its token
  hash, then email the link, and return the raw token so the page can display
  it with a "save this link" prompt. The submitter has just demonstrated they
  are the person enrolling.

  **The insert stamps `last_link_attempt_at`.** The first send is an attempt
  like any other, so the cooldown applies from the moment the row exists.
  Without this the cooldown reads null on a brand-new row and an immediate
  resend rotates and sends a second email straight away — one free rotation per
  address per event, and the griefing case lands at its most effective on the
  record that has just been created. The legitimate reason to resend
  immediately, an email that did not arrive, is already covered: the link is on
  screen.
- **Repeat signup** — under a row lock, check the cooldown, mint a new token,
  move the current hash into `superseded_token_hash` with
  `superseded_expires_at = now() + grace`, store the new one and commit; then
  email the link to the address on file. The response says "we have emailed
  your link" and contains **no token**. Echoing it would let anyone harvest
  another person's link by typing their address into the public form.

The first-signup response carries a live credential in its body, so it is
returned with `Cache-Control: no-store` and must never be recorded by
application, CDN, or diagnostic logging. Request/response body logging on this
route is prohibited, and the raw token must not appear in any log line. This
complements moving the token out of the query string; neither substitutes for
the other.

#### Ordering: persist, then send

Minting and emailing cannot be one atomic operation — the mail server is not in
the transaction — so the order decides which failure the user gets. **The token
is persisted first, and only then emailed.**

A token is never emailed before its hash is stored, so a link that reaches an
inbox always works. What a failed send costs is a *notification*, never a
credential:

- **First signup** — the row and its hash are written, then the link is
  emailed and shown on screen. If the send fails, the token is still valid and
  the on-screen link still works; the page says the email did not go out and
  offers a resend. If the *write* fails, nothing was created, nothing was
  emailed, and the endpoint returns an error rather than a false success.
- **Rotation** (resend and invitation) — the new hash is stored and the current
  one moves into `superseded_token_hash` with `superseded_expires_at`, then the
  new link is emailed. If the send fails, the recipient's existing link keeps
  working for the whole grace period.

This is the point of the grace slot: it makes a failed send survivable on the
rotation path, exactly as a persisted-and-displayed token does on the signup
path. The endpoint never reports success before persistence succeeds, so no
outbox or durable delivery state is required to keep the promise that an
accepted link works.

The superseded hash is cleared the first time the new token is used, so a
successful rotation narrows to one live credential as soon as it is confirmed.

#### Rotation is serialized before the send, not after

The two-slot model holds exactly one superseded credential, so concurrent
rotations would overwrite it and silently cut short a grace period someone was
promised. Serializing only the write is not enough: two requests could both
read the old row, both decide to rotate, and both send, producing duplicate
mail, bypassing the cooldown, and leaving the first freshly-emailed link as
nothing but the superseded token of the second.

**The entire rotation decision therefore happens under the row lock, before any
mail is sent.** In one transaction: `SELECT ... FOR UPDATE` the
`event_interest` row, **re-check `revoked_at` and return `NOT_FOUND` if it is
set**, evaluate the cooldown against `last_link_attempt_at`, mint, write the
new hash and the superseded slot, stamp `last_link_attempt_at`, commit.

The revocation re-check belongs here, not in the caller. Checking it before
rotating is a stale read: an admin can revoke between the caller's read and the
rotation, and the row would still be rotated and a fresh credential emailed
that the gate then refuses. The check has to sit under the same lock that does
the writing. Only then is the email sent, and `last_link_sent_at` is stamped
afterwards on success.

The cooldown is evaluated against the *attempt*, not the successful send, which
is what makes a concurrent second request back off instead of sending a
duplicate.

**On a send failure the rotation is rolled back, not merely un-cooled.** This
is the same principle as persist-then-send: an operation that did not complete
must leave no durable effect. Under the same row lock, restore `token_hash`
from `superseded_token_hash`, null the superseded pair, and null
`last_link_attempt_at` — but **only if `token_hash` still equals the value this
attempt wrote**, so a concurrent rotation that has already superseded this one
is never clobbered.

**The caller must supply the prefix to restore.** `token_prefix` holds the
first eight characters of the *raw* token, which is unrecoverable from a hash —
there is no `superseded_token_prefix` column, and deriving something from the
stored hash would write a plausible-looking string matching nothing the
recipient holds, which is worse than leaving it stale. So the rollback takes
the prefix the caller read from the row before rotating, and the
compare-and-swap on `token_hash` is what guarantees that read is still valid: if
the row moved on, the swap fails and nothing is written. A null prefix raises
rather than being written.

Simply clearing the attempt is not sufficient, and the reason is worth stating
because it is not obvious. Clearing lets the caller retry at once — which is
the point — but it also disables the cooldown that is the stated mitigation for
a second rotation inside a grace window. Two failed sends then walk the token
forward twice: the original ends up in neither slot, so the link already in the
recipient's inbox dies while neither replacement was ever delivered. Because
`sendEmail` returns false rather than throwing whenever the mail provider is
unreachable or unconfigured, an outage makes this the *normal* path, not a rare
one. Dropping the clear instead would only make the loss less frequent — the
original still dies at the next rotation.

If the process dies between commit and the rollback, the record is in cooldown
until it expires and the previous token remains live for its grace — a bounded,
self-healing degradation rather than a stuck state.

The guarantee this design offers is deliberately narrow and should be stated in
those terms: **the token immediately prior to the most recent rotation stays
valid for the grace period.** It is not "every token ever issued." A second
rotation while a grace token is still live replaces it — the older credential
dies early by design. The cooldown makes this rare from the public endpoint;
admin resend bypasses the cooldown, so the admin UI warns before rotating a
record whose previous token is still inside its grace window.

**Accepted consequence:** rotation sits on a public endpoint, so a third party
who knows someone's email can force a rotation. They gain no access — the new
link goes only to the address on file — and the grace period means the victim's
current link keeps working meanwhile. `last_link_attempt_at` enforces a **15 minute**
cooldown per address per intake; requests inside it return the same generic
success without sending or rotating.

The cooldown reads the *attempt*, not the successful send — see *Rotation is
serialized before the send*. That is what makes a concurrent second request
back off instead of sending a duplicate, and it is why the insert stamps the
attempt too: a brand-new row must not start life exempt.

### Discovery

`GET /api/public/enroll/[slug]` returns the intake's `priority_open_at`
alongside the `opens_at` it already provides, plus which tiers the window
actually covers.

The interest CTA appears only when **both** hold: `priority_open_at` is set and
still in the future, *and* at least one tier still has a future
`enrollment_open_at`. It disappears once the window opens.

**Partially-public events need explicit copy.** A tier with a null
`enrollment_open_at` is already on sale and is exempt from the window trigger,
so an intake can legitimately have VIP selling now while General Admission
opens later behind a priority window. The gate handles this correctly on its
own — a token is simply irrelevant to a tier that is already public, and the
buyer needs no head start for it. What must not be left implicit is the
promise: the CTA and the confirmation email name the tiers the head start
covers, rather than saying "early access to this event" while part of the event
is already on sale. If every tier is already public, there is nothing to be
early for: the CTA is hidden and signup is rejected.

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

#### The redemption transition, and why it is locked

`priority_access_granted` is a `STABLE` read. It takes no lock, so on its own it
leaves a window: an admin can revoke a token *after* the gate has read it and
*before* the enrollment is inserted, and both transactions commit. The revoked
token gets one enrollment through.

The stamping and that race have the same fix, so the RPC does them together.
Once the gate has admitted a class on the strength of a token, and **before any
enrollment row is inserted or any seat decremented**:

1. `SELECT ... FOR UPDATE` the matching `event_interest` row — the one whose
   `token_hash` or live `superseded_token_hash` equals the presented hash, for
   the enrolled class's intake.
2. Re-check `revoked_at IS NULL` under that lock. If it is now set, return
   `ENROLLMENT_NOT_OPEN` exactly as an unauthorised caller would. A revocation
   that commits first wins; one that commits second is too late.
3. Proceed with the insert and the seat decrement.
4. Stamp `first_used_at` and `first_converted_enrollment_id` where they are
   null, and clear `superseded_token_hash` / `superseded_expires_at`.

The lock is held from step 1 to commit, so no revocation can interleave. Step 4
is what makes the rotation guarantee true in practice: without it a superseded
token stays valid for its entire grace period even after the current token has
been used, which contradicts *the superseded hash is cleared the first time the
new token is used*.

For a cart the token is intake-level, so exactly one interest row is locked and
stamped once, against the cart's enrollment id — not once per tier.

Locking a row the caller does not otherwise touch is deliberate. The alternative
is to check revocation twice and hope, which is the shape of the bug rather than
a fix for it.

**Accepted consequence — a signup is distinguishable from a resend.** A first
signup returns a visible token; a repeat does not. A throttled call also
returns after one round trip where a resend takes three, so the two are
separable by timing. Address enumeration on this endpoint is therefore possible
and is accepted: it follows directly from showing the link on screen, which is
the fallback that makes a failed send survivable. Making the paths
indistinguishable would mean either withholding the on-screen link or reporting
`emailed: true` when nothing was sent — telling the user something false. The
enumeration is not worth either price.

**Revoked records do not rotate.** A repeat signup against a revoked row
returns the same generic success and sends nothing. Rotating one would spend an
email on a link the gate refuses, and the recipient would get something that
silently does not work.

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
- Hidden **in the UI** when `org_type = 'language_school'`. The API routes are
  deliberately **not** gated on `org_type`, which is what makes the next
  sentence true: gating them would mean enabling this for schools required an
  API change as well as a UI one. This is safe because every route already
  requires an owner session and scopes every query to that owner's tenant — a
  school owner calling them sees their own empty interest list and nothing
  else. Note `channels/route.ts` is itself split this way: its POST gates on
  `org_type`, its GET does not.

  Earlier revisions said only "hidden when `org_type = 'language_school'`",
  which read as an instruction to gate the API and contradicted the sentence
  after it. No database-level restriction either, so a
  later decision to offer this to schools is a UI change rather than a
  migration.

### Invitations

`POST /api/admin/interest/[intakeId]/invite` sends a reminder to rows not yet
invited.

**It rotates.** Only hashes are stored, so the raw token a recipient already
holds cannot be reconstructed and cannot be put in an email — the same
hash-is-not-reversible constraint that governs resend. Rather than send a
linkless reminder, the invitation mints a fresh token per row through the
ordinary grace mechanism, so one click from the reminder gets the recipient in.
This is what makes the invariant hold everywhere: **a link is only ever created
at the moment it is emailed or displayed.**

Each row follows the same persist-then-send order and pre-send row lock as a
public resend, so a failed send costs that row a notification rather than a
credential: the new token is already live and the recipient's previous link
keeps working through its grace period.

- Stamps `invited_at` **per row as each send succeeds**, so a partial failure
  re-runs only the remainder instead of double-mailing the whole list.
- `await`s the sends. Fire-and-forget is killed on Vercel serverless.
- Processes a bounded chunk per invocation and returns `{ sent, remaining }` so
  a large list can be drained across calls without hitting the function
  timeout.

**`remaining` counts rows still owed an invitation, including ones that just
failed.** A caller draining the list must therefore loop on `sent > 0`, not on
`remaining > 0` — during a mail outage every row fails, `remaining` never
decreases, and looping on it never terminates.

**The run aborts after three consecutive send failures.** Without it, a mail
outage rotates and rolls back every row in the chunk just to discover the
provider is down, and any rollback that loses its compare-and-swap leaves that
row rotated with nothing delivered. The counter resets on any success, so one
undeliverable address does not stop a run.

## Email

Two new templates beside the existing four in `src/lib/email.ts`, built on
`baseLayout` so they inherit tenant name and logo:

1. **Interest confirmation** (signup and resend) — carries the `#pa=` link,
   states when it becomes usable, and names the tiers the head start covers.
   On a resend, states that the previous link stops working shortly.
2. **Priority window reminder** (admin invitation) — carries a **freshly minted
   link**, not the recipient's previous one, which cannot be reconstructed from
   a hash. Says plainly that this link supersedes any earlier one, and is sent
   when the window is about to open or has opened.

   **Its copy must branch on which of those two it is.** The invitation is
   explicitly permitted after the window has opened, so a template that
   unconditionally says "Opens Soon" and "this link will not work until
   `windowOpensAt`" tells a recipient their working link is dead, at the one
   moment they are being urged to use it. When the window is already open the
   email says so and tells them to go now.

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
| Email send fails on a first signup | Token is already persisted, so the on-screen link works; page reports the email failure and offers a resend |
| Email send fails during a rotation | New token is live and the previous one still works through its grace; attempt stamp cleared, so retry is immediate |
| Write fails on a first signup | Nothing created, nothing emailed, endpoint returns an error rather than a false success |
| Process dies between rotation commit and the send | Record sits in cooldown until it expires, then retryable — bounded and self-healing |
| Two concurrent resends on one record | Serialized by the row lock before sending; the second sees the attempt stamp and backs off, so one email goes out |
| Two rotations inside one grace window | The older superseded token dies early — the guarantee covers only the token immediately prior to the most recent rotation |
| Concurrent signups from one address at the limit | Serialized by the advisory lock; exactly the permitted number proceed |
| Intake where every tier is already public | CTA hidden, signup rejected — nothing to be early for |
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
- **Rate-limit atomicity** — N concurrent requests from one address against a
  limit of M admit exactly M. A count-then-insert implementation passes a
  sequential test and fails this one, which is the whole reason it exists.
- **Rotation serialization** — two concurrent rotations on one record leave a
  coherent row, and the surviving superseded token is the one immediately prior
  to the later rotation.
- Persist-then-send ordering: a simulated send failure on a first signup leaves
  a working token and a truthful "email failed" response; on a rotation it
  leaves the previous token valid through its grace.
- No token is ever emailed whose hash is not already stored — asserted by
  injecting a failure between the write and the send and confirming the gate
  accepts the token that was written.
- Two concurrent resends on one record produce exactly one email.
- An invitation run rotates each row, and a mid-run failure leaves already-sent
  rows stamped and the remainder retryable without double-mailing.

Route-level tests follow the existing patterns in `src/__tests__/api/public/`,
including that the token never appears in a query string or a `Referer`, and
that the first-signup response carries `Cache-Control: no-store`.

## Deployment

Standard project rules apply. Migration to the dev database
(`fnfvwzwrdsnmwxunciti`) first, with the diff shown before any push. Production
migration is a separate, gated step. `npm run build` locally before pushing,
judged by exit code.

## Open items for the implementation plan

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

**v5 (2026-08-27)** — fourth review round, the first conducted against the
current document rather than a stale copy. Accepted and fixed: the invitation
email promised "the same link" while the store holds only hashes, making the
template unimplementable (the identical hash-is-not-reversible error corrected
for resend in v2 and never carried across to invitations — invitations now
rotate, which also makes the mint-only-on-send invariant hold everywhere);
rate-limit consumption was a count-then-insert race that concurrent requests
defeat, now one serialized function under an advisory lock; token rotation was
unserialized, so concurrent rotations could overwrite the single superseded
slot and silently shorten a promised grace period, now row-locked with the
guarantee stated narrowly; and partially-public intakes, where one tier is
already on sale while the list forms for others — correct at the gate, but the
user-facing promise now names which tiers the head start covers.

**v6 (2026-08-27)** — fifth substantive round. Accepted and fixed: v5's
send-before-persist ordering, which is unsafe for a *first* signup where there
is no prior token to fall back on — a failed write after a successful send
would have left a dead link both in the inbox and on screen; the rotation lock,
which v5 acquired only after the email had gone out, so two concurrent resends
could each read the old row, each mint, and each send before their writes
serialized — the whole rotation decision and the cooldown check now happen
under the row lock before any mail is sent, keyed on a new
`last_link_attempt_at`; and the IP pseudonym, now `HMAC-SHA-256` over a
canonicalised address rather than a salt concatenation.

**Correcting v5's own reasoning.** v5 justified send-before-persist by claiming
that persisting first fails as "the old link is dead and the new one was never
delivered." That was false: the grace slot added in v3 keeps the previous token
valid precisely so a failed send is survivable. The design had already solved
the problem v5 reorganised itself to solve, and in doing so introduced a real
one on the signup path. v6 restores persist-then-send and states the invariant
it protects — no token is ever emailed whose hash is not already stored, so a
link that reaches an inbox always works, and a failed send costs a notification
rather than a credential.

**v7 (2026-08-27)** — found during implementation, by code review of the
migration rather than of the prose. The rate limiter's prune was unqualified:
the function takes a per-address advisory lock, then deleted every expired row
in the table for every address. Two callers holding different locks could
contend over the same rows, serialising unrelated addresses behind each other's
whole transaction or deadlocking and surfacing a hard error to a legitimate
signup — under burst traffic, which is exactly when a rate limiter matters. The
prune is now scoped to the calling address, which is complete for correctness
because both counts already filter on `ip_hash`. Also: the advisory lock is now
namespaced with a reserved constant, since its keyspace is global to the
database and a second future user of advisory locks would otherwise collide;
`assert_priority_window_valid` locks the intake row, closing a TOCTOU where two
concurrent edits from opposite sides could each validate against the other's
pre-commit state; and `first_converted_enrollment_id`'s missing tenant scoping
is now recorded as a requirement on the code that writes it, since no
constraint can enforce it.

The prune defect originated in this document, not in the implementation. The
migration reproduced what v6 specified.

**v8 (2026-08-27)** — the v7 lock-namespacing fix was itself broken, and was
caught by re-review before any caller existed. `pg_advisory_xact_lock` has only
two overloads, `(bigint)` and `(int, int)`; `hashtextextended` returns `bigint`,
so the two-key call could not resolve, and narrowing casts are never implicit.
Verified by execution: `consume_interest_signup_slot` raised `function
pg_advisory_xact_lock(bigint, bigint) does not exist` on **every** call. The
explicit-cast workaround was also tested and also fails — `integer out of
range`, because the bigint overflows int4. `hashtext` returns int4 natively and
is the correct idiom.

The important part is why nothing caught it earlier. PL/pgSQL prepares embedded
statements on first execution, so the wrong overload compiled clean, applied
clean, and passed a 181-test suite — because no caller exists yet. It would
have failed on the first live signup, in the one function granted to
`service_role`. A migration applying successfully is not evidence that its
functions run.

**v11 (2026-08-28)** — review of `registerInterest` found that this document
asked for two properties that cannot both hold. The failure table promises the
previous token keeps working through its grace; the rotation section relies on
the cooldown to make a second rotation inside that grace rare. But clearing
`last_link_attempt_at` on a send failure — which the same section required —
disables that cooldown precisely when it is needed, so two failed sends walk
the token forward twice and the link already in the recipient's inbox dies with
neither replacement delivered. Since `sendEmail` returns false rather than
throwing when the provider is unreachable, a mail outage makes that the normal
path. Rotation is now rolled back on a send failure, guarded on the hash this
attempt wrote so a concurrent rotation is never clobbered.

Also recorded here as accepted rather than fixed: signup and resend are
distinguishable by response and by timing, which follows from showing the link
on screen and is not worth withholding that fallback to close. And revoked
records now return generic success without rotating, rather than spending an
email on a link the gate will refuse.

**v10 (2026-08-28)** — the implementer of `registerInterest` flagged that the
first signup did not stamp `last_link_attempt_at`, so the cooldown read null on
a brand-new row and an immediate resend rotated and sent again for free. It
declined to change the behaviour on its own authority because this document did
not say which was intended, which was the right call. The insert now stamps the
attempt: the first send is an attempt like any other, the cooldown applies from
the moment the row exists, and the only legitimate reason to resend immediately
is already covered by the on-screen link.

Also settled here, having been left open: the grace period is **24 hours**, and
the signup limiter is **3 per address per intake** and **10 per address across
intakes**, both over a **1 hour** window. These were chosen, not derived; they
are cheap to change and should be revisited against real traffic.

**v9 (2026-08-27)** — external review of the enrollment-RPC migration found the
redemption transition missing entirely. The RPC authorised access, inserted the
enrollment and decremented seats, but never touched `event_interest`: no
`first_used_at`, no `first_converted_enrollment_id`, and no clearing of the
superseded token. The audit fields would have stayed null forever, and — the
part that matters — a rotated-away token would have remained valid for its whole
grace period even after the current token was successfully used, contradicting
this document's own rotation guarantee.

The same review found that `priority_access_granted` is a `STABLE` read holding
no lock, so a revocation committing between the gate check and the insert lets a
revoked token through once. Both have one fix, now specified above: lock the
matching interest row before the insert, re-check revocation under the lock, and
stamp the transition after. The lock is held to commit.

This was an omission in the implementation brief, not in the implementation. The
requirement was already stated in this document; the task that built the gate
never mentioned it.

Also recorded here: the `FOR UPDATE` added in v7 introduces a lock-ordering
surface between `intakes` and `classes` that did not exist before. Two
transactions touching the same two intakes in opposite order can deadlock. This
is accepted — a loud, retryable `40P01` is strictly better than the silent
invariant violation it replaces — but any future bulk writer over `classes`
must iterate in a stable `intake_id` order and be prepared to retry.

Raised by no review, found earlier while applying round two: **interest signup
had to close at `priority_open_at`.** Left open, anyone could have registered during
the window and minted themselves a token on the spot, which would have made the
head start available to the general public and defeated the feature.
