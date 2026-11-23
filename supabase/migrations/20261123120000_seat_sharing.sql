-- Seat sharing (mode B): design section 6.4, Plan 4.
-- Every new object is service-role only. Lock order everywhere: enrollment(s)
-- FOR SHARE, then ticket(s) FOR UPDATE, then buyer_profiles FOR SHARE, several
-- rows ORDER BY id — bind_ticket_device's order. move_order_buyer differs
-- (enrollment FOR UPDATE, profile, tickets) and is safe only because its
-- FOR UPDATE makes everything else on that order wait first.

BEGIN;

-- ── 1. The current holder ───────────────────────────────────────────────────
-- NULL means the seat is with the order's buyer. The current holder is
-- coalesce(tickets.holder_buyer_id, enrollments.buyer_id) everywhere.
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
-- ('created', cutoff) or ('refused', NULL). Replacing a link logs only
-- link_created (plan decision 7).
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
-- ('claimed', ticket, leader) or ('refused', NULL, NULL). One generic refusal.
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
-- ('given_back', leader) or ('refused', NULL). One generic refusal.
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

-- ── 12. bind_ticket_device: the current holder binds ────────────────────────
-- Plan 3's body (20261122130000_leaders_phone.sql) with three changes:
-- the holder test reads coalesce(holder_buyer_id, buyer_id); a bind is first
-- when the buyer has no device row after the seat's latest holder change
-- (plan decision 3); and the device row's created_at is clock_timestamp().
CREATE OR REPLACE FUNCTION public.bind_ticket_device(
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

  -- Account deletion sets buyer_profiles.deleted_at, then revokes the buyer's
  -- phones (revoke_buyer_ticket_devices). The share lock makes a bind and a
  -- deletion take turns: a bind waiting behind the deletion's UPDATE wakes
  -- up to a deleted profile and is refused; a deletion waiting behind a bind
  -- revokes the row the bind just wrote. Without it a bind could commit after
  -- the revoke, and deleteUser would leave an active row nobody can find.
  PERFORM 1 FROM public.buyer_profiles
   WHERE id = p_buyer_id AND deleted_at IS NULL
     FOR SHARE;
  IF NOT FOUND THEN
    RETURN 'refused';
  END IF;

  -- A separate statement after the locks: a fresh READ COMMITTED snapshot.
  SELECT t.tenant_id, t.status, t.holder_buyer_id, e.buyer_id, e.status::text AS order_status, i.ticket_protection
    INTO v_t
    FROM public.tickets t
    JOIN public.enrollments e ON e.id = t.enrollment_id
    JOIN public.intakes i ON i.id = t.intake_id
   WHERE t.id = p_ticket_id;

  -- Only the current holder binds: a friend who claimed the seat, else the
  -- order's buyer.
  IF NOT FOUND
     OR v_t.tenant_id <> p_tenant_id
     OR v_t.status <> 'valid'
     OR v_t.order_status <> 'confirmed'
     OR NOT v_t.ticket_protection
     OR coalesce(v_t.holder_buyer_id, v_t.buyer_id) IS DISTINCT FROM p_buyer_id
  THEN
    RETURN 'refused';
  END IF;

  SELECT public_key INTO v_active
    FROM public.ticket_devices
   WHERE ticket_id = p_ticket_id AND revoked_at IS NULL;

  IF v_active = p_public_key THEN
    RETURN 'unchanged';
  END IF;

  -- First per (ticket, holder) counts from the seat's latest holder change
  -- (plan decision 3). Both sides use clock_timestamp(), written under the
  -- ticket lock, so the order is exact.
  v_first := NOT EXISTS (
    SELECT 1 FROM public.ticket_devices d
     WHERE d.ticket_id = p_ticket_id AND d.buyer_id = p_buyer_id
       AND d.created_at > coalesce(
         (SELECT max(h.created_at) FROM public.ticket_holder_events h
           WHERE h.ticket_id = p_ticket_id
             AND h.event IN ('claimed', 'given_back', 'order_moved', 'holder_deleted')),
         '-infinity'::timestamptz));

  UPDATE public.ticket_devices
     SET revoked_at = now(), revoked_by = 'rebind'
   WHERE ticket_id = p_ticket_id AND revoked_at IS NULL;

  INSERT INTO public.ticket_devices (ticket_id, buyer_id, public_key, created_at)
  VALUES (p_ticket_id, p_buyer_id, p_public_key, clock_timestamp());

  RETURN CASE WHEN v_first THEN 'bound_first' ELSE 'bound_again' END;
END;
$$;

-- ── 13. move_order_buyer: only the leader's seats move ──────────────────────
-- Plan 3's body with the device revoke replaced (design 4.7 step 5): seats a
-- friend claimed stay with them; open links are cancelled; order_moved is
-- logged per moved seat with the staff user as actor (plan decision 2).
CREATE OR REPLACE FUNCTION public.move_order_buyer(
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

  -- Hold the target's profile live until this move commits, so a deletion
  -- of the target can't slip in between the check above and the commit: a
  -- deletion waiting behind the move then sees the moved order, and a move
  -- waiting behind a deletion wakes up to a deleted profile and is refused.
  -- Placed after the refusal check so the FOUND that check reads is still
  -- the enrollment read's, not this statement's.
  PERFORM 1 FROM public.buyer_profiles
   WHERE id = p_to_buyer_id AND deleted_at IS NULL
     FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid; RETURN;
  END IF;

  -- Last day across the order's classes (single or cart). end_time is the END DATE.
  SELECT max(greatest(c.event_date, coalesce(c.end_time, c.event_date)))
    INTO v_last
    FROM public.classes c
   WHERE c.id = v_e.class_id
      OR c.id IN (SELECT ei.class_id FROM public.enrollment_items ei WHERE ei.enrollment_id = v_e.id);

  -- The zone must equal the app's TICKET_TZ default (DEFAULT_TICKET_TZ in
  -- src/lib/tickets/exp.ts); a database test compares them.
  IF v_last IS NOT NULL AND v_last < (now() AT TIME ZONE 'Asia/Yangon')::date THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid; RETURN;
  END IF;

  PERFORM 1 FROM public.tickets t WHERE t.enrollment_id = v_e.id FOR UPDATE;

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

  UPDATE public.enrollments SET buyer_id = p_to_buyer_id WHERE id = v_e.id;

  INSERT INTO public.order_moves (enrollment_id, tenant_id, from_buyer_id, to_buyer_id, moved_by, reason)
  VALUES (v_e.id, p_tenant_id, v_e.buyer_id, p_to_buyer_id, p_staff_user_id, btrim(p_reason));

  RETURN QUERY SELECT 'moved'::text, v_e.buyer_id;
END;
$$;

-- ── 14. revoke_buyer_ticket_devices: the deletion step (plan decision 8) ────
-- Same name, signature and return value. Idempotent. Returns the number of
-- device rows revoked. Must run in its own transaction, after the deleted_at
-- update has committed (as the wrapper calls it).
CREATE OR REPLACE FUNCTION public.revoke_buyer_ticket_devices(p_buyer_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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

  -- Once per (ticket, buyer), so a retried or swept deletion doesn't log twice.
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
$$;

-- ── 15. Grants ──────────────────────────────────────────────────────────────
-- CREATE OR REPLACE keeps an ACL; restated anyway.

REVOKE ALL ON FUNCTION public.share_cutoff(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.share_cutoff(date) TO service_role;

REVOKE ALL ON FUNCTION public.seat_open_for_sharing(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seat_open_for_sharing(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.create_share_link(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_share_link(uuid, uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.cancel_share_link(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_share_link(uuid, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.preview_share_link(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_share_link(text, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.claim_share_link(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_share_link(text, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.give_back_seat(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.give_back_seat(uuid, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.void_enrollment_tickets(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_enrollment_tickets(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.bind_ticket_device(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_ticket_device(uuid, uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.move_order_buyer(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_order_buyer(uuid, uuid, uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.revoke_buyer_ticket_devices(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_buyer_ticket_devices(uuid) TO service_role;

-- ── 16. Fail closed on the bodies and ACLs ──────────────────────────────────
-- CRLF-tolerant, like this repository's other prosrc guards.

DO $$
DECLARE
  v_fn    text;
  v_src   text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.share_cutoff(date)',
    'public.seat_open_for_sharing(uuid,uuid)',
    'public.create_share_link(uuid,uuid,uuid,text)',
    'public.cancel_share_link(uuid,uuid,uuid)',
    'public.preview_share_link(text,uuid,uuid)',
    'public.claim_share_link(text,uuid,uuid)',
    'public.give_back_seat(uuid,uuid,uuid)',
    'public.void_enrollment_tickets(uuid)',
    'public.bind_ticket_device(uuid,uuid,uuid,text)',
    'public.move_order_buyer(uuid,uuid,uuid,uuid,text)',
    'public.revoke_buyer_ticket_devices(uuid)'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE EXCEPTION '% is missing', v_fn;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = v_fn::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '% is executable by PUBLIC', v_fn;
    END IF;
    IF to_regrole('anon') IS NOT NULL
       AND has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by anon', v_fn;
    END IF;
    IF to_regrole('authenticated') IS NOT NULL
       AND has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by authenticated', v_fn;
    END IF;
    IF to_regrole('service_role') IS NOT NULL
       AND NOT has_function_privilege('service_role', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not executable by service_role', v_fn;
    END IF;
  END LOOP;

  SELECT replace(prosrc, chr(13), '') INTO v_src
    FROM pg_proc WHERE oid = 'public.bind_ticket_device(uuid,uuid,uuid,text)'::regprocedure;
  IF v_src NOT LIKE '%holder_buyer_id%' OR v_src NOT LIKE '%ticket_holder_events%' THEN
    RAISE EXCEPTION 'bind_ticket_device body is not the expected one';
  END IF;

  SELECT replace(prosrc, chr(13), '') INTO v_src
    FROM pg_proc WHERE oid = 'public.move_order_buyer(uuid,uuid,uuid,uuid,text)'::regprocedure;
  IF v_src NOT LIKE '%ticket_share_links%' OR v_src NOT LIKE '%order_moved%' THEN
    RAISE EXCEPTION 'move_order_buyer body is not the expected one';
  END IF;

  SELECT replace(prosrc, chr(13), '') INTO v_src
    FROM pg_proc WHERE oid = 'public.revoke_buyer_ticket_devices(uuid)'::regprocedure;
  IF v_src NOT LIKE '%holder_deleted%' THEN
    RAISE EXCEPTION 'revoke_buyer_ticket_devices body is not the expected one';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
