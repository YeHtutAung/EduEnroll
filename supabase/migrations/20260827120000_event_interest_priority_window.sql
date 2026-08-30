-- ============================================================================
-- Event interest list with a scheduled priority enrollment window
--
-- Purely additive: a standalone `event_interest` table holding a hashed
-- access-link token per person per event (intake), plus `intakes.priority_open_at`
-- to schedule the head start. No application code calls any of this yet — a
-- later task wires the enrollment RPCs to consult it. Nothing existing changes
-- behaviour.
--
-- Terminology: an intake is the event. A class is a ticket tier within it
-- (`classes` is UNIQUE (intake_id, level)). Interest and the priority window
-- live on the intake; public sale times stay on the class.
--
-- See docs/superpowers/specs/2026-08-26-event-interest-priority-window-design.md
-- for the full design and rationale (sections: Data model, Signup rate
-- limiting, The gate).
-- ============================================================================

BEGIN;

-- ── 1. intakes: the scheduled window, and the FK enabler ────────────────────

ALTER TABLE public.intakes
  ADD COLUMN priority_open_at timestamptz;

-- Enables the composite FK on event_interest below — guarantees a row's
-- tenant_id cannot drift from its intake's actual owner, closing the
-- denormalisation gap that `tickets` leaves open.
--
-- Built inline (no CONCURRENTLY): intakes is small, so the exclusive lock and
-- inline index build this ADD CONSTRAINT takes are momentary. A large table
-- would need CREATE UNIQUE INDEX CONCURRENTLY followed by
-- ADD CONSTRAINT ... USING INDEX, split across a non-transactional migration —
-- see 20260820120000_kbzpay_mmqr.sql for that pattern.
ALTER TABLE public.intakes
  ADD CONSTRAINT intakes_id_tenant_uniq UNIQUE (id, tenant_id);

-- ── 2. event_interest: one hashed token per person per event ────────────────
--
-- No IF NOT EXISTS on this table, its indexes, or any other object this
-- migration creates: an unexpected same-named object must stop the
-- deployment, not silently skip a required control. Same precedent as
-- 20260722180000_stripe_settlement_contract.sql.

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

-- ── 3. interest_signup_attempts: the signup rate-limit counter ─────────────
--
-- Signup emails a link from the tenant's Resend domain to any address a
-- caller supplies. The cost of abuse is Resend spend and sender-reputation
-- damage on the domain that also delivers payment email, which warrants a
-- real counter.

CREATE TABLE public.interest_signup_attempts (
  id         bigserial PRIMARY KEY,
  intake_id  uuid NOT NULL REFERENCES public.intakes(id) ON DELETE CASCADE,
  ip_hash    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT interest_signup_attempts_ip_format CHECK (ip_hash ~ '^[0-9a-f]{64}$')
);

-- Serves v_intake_count: equality on the first two columns, range on the third.
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

-- ── 4. The priority-window trigger ───────────────────────────────────────────
--
-- The window lives on the intake, but public sale times remain per class. The
-- relationship between them cannot be a table CHECK because it spans two
-- tables, so it is enforced by a trigger fired from both directions: editing
-- the intake's priority_open_at, and editing a class's enrollment_open_at (or
-- moving a class to a different intake).

CREATE FUNCTION public.assert_priority_window_valid(p_intake_id uuid)
RETURNS void LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_priority timestamptz;
BEGIN
  -- FOR UPDATE, not a plain read. The two triggers fire on different tables,
  -- so under READ COMMITTED a transaction moving the intake's priority_open_at
  -- later and a concurrent transaction moving a tier's enrollment_open_at
  -- earlier would each validate against the other's pre-commit state, both
  -- pass, and leave the invariant violated once both commit. Locking the
  -- intake row serialises every validation for that event.
  --
  -- Trade-off accepted: this introduces a lock-ordering surface between
  -- intakes and classes that did not exist before. Two transactions touching
  -- the same two intakes in opposite order can deadlock. That is accepted --
  -- a loud, retryable 40P01 beats the silent invariant violation it replaces
  -- -- but a future bulk writer over classes must iterate in stable
  -- intake_id order and be ready to retry.
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

CREATE FUNCTION public.trg_assert_priority_window_from_intake()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.priority_open_at IS NOT DISTINCT FROM OLD.priority_open_at THEN
    RETURN NEW;
  END IF;
  PERFORM public.assert_priority_window_valid(NEW.id);
  RETURN NEW;
END $$;

CREATE TRIGGER trg_intakes_assert_priority_window
  AFTER INSERT OR UPDATE ON public.intakes
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_assert_priority_window_from_intake();

CREATE FUNCTION public.trg_assert_priority_window_from_class()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.enrollment_open_at IS NOT DISTINCT FROM OLD.enrollment_open_at
     AND NEW.intake_id IS NOT DISTINCT FROM OLD.intake_id THEN
    RETURN NEW;
  END IF;
  PERFORM public.assert_priority_window_valid(NEW.intake_id);
  RETURN NEW;
END $$;

CREATE TRIGGER trg_classes_assert_priority_window
  AFTER INSERT OR UPDATE ON public.classes
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_assert_priority_window_from_class();

-- ── 5. The gate: priority_access_granted ────────────────────────────────────
--
-- Called only from inside the two enrollment RPCs (a later task), which are
-- SECURITY DEFINER — a nested invoker function runs with the outer function's
-- rights, so making this one SECURITY DEFINER too would buy nothing and would
-- add a privilege-escalation surface. Combined with the revokes below, and
-- with RLS enabled and no policies on event_interest, a direct call by anon
-- is both unprivileged and fruitless.

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

-- ── 6. consume_interest_signup_slot: serialized rate-limit check + insert ──
--
-- A count-then-insert from the application races: concurrent requests from
-- one address each observe capacity, then all insert. The check and the
-- insert therefore live in a single database function under a
-- transaction-scoped advisory lock keyed on the address hash.

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
  -- pg_advisory_xact_lock(bigint) and (int, int) -- there is no (bigint,
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

-- ── 7. Privileges ────────────────────────────────────────────────────────────
--
-- PostgreSQL grants EXECUTE to PUBLIC by default on every new function. This
-- repository has already been burned by that default once
-- (20260719100000_restrict_enrollment_rpc_privileges.sql). Every function
-- created above is revoked from PUBLIC/anon/authenticated/service_role and
-- only consume_interest_signup_slot is granted back, to service_role, since it
-- is the only one called directly by application code (through the
-- service-role client). assert_priority_window_valid and
-- priority_access_granted are only ever called from inside other functions
-- owned by the same role, which retains EXECUTE implicitly, so neither needs
-- a grant.
--
-- The two trigger-wrapper functions (trg_assert_priority_window_from_intake,
-- trg_assert_priority_window_from_class) are included here too. PostgreSQL
-- refuses to invoke a trigger-returning function directly via SELECT/PERFORM,
-- so the default PUBLIC grant is not a live hole for them — but they are new
-- functions like the rest, and a reader scanning this block should not have
-- to wonder why two of the five are missing. Defence in depth, not a fix for
-- a reachable path.

REVOKE ALL ON FUNCTION public.assert_priority_window_valid(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.priority_access_granted(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.trg_assert_priority_window_from_intake()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.trg_assert_priority_window_from_class()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.consume_interest_signup_slot(uuid, text, integer, integer, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_interest_signup_slot(uuid, text, integer, integer, interval)
  TO service_role;

-- ── 8. Reload PostgREST schema cache ────────────────────────────────────────

NOTIFY pgrst, 'reload schema';

COMMIT;
