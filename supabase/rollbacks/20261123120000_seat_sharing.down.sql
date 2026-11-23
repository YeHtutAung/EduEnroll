-- Rollback for 20261123120000_seat_sharing.sql.
--
-- Restores Plan 3's bind_ticket_device, move_order_buyer and
-- revoke_buyer_ticket_devices, copied verbatim from
-- 20261122130000_leaders_phone.sql, then drops every new object.
--
-- DATA LOSS: tickets.holder_buyer_id, every ticket_share_links row and every
-- ticket_holder_events row are gone for good. A rollback after links were
-- claimed RETURNS EVERY CLAIMED SEAT TO ITS LEADER: the friend's active phone
-- is revoked here (revoked_by 'holder_changed'), so it can no longer pass a
-- bound-phone scan, and the leader can bind again.
--
-- Revert and deploy the code first: not only the code that calls the sharing
-- functions, but every reader of tickets.holder_buyer_id, including the scan
-- route (src/app/api/scans/route.ts) and /api/me/tickets. They fail once the
-- column is dropped.
--
-- The indexes on ticket_share_links and ticket_holder_events go with their
-- tables; tickets_holder_buyer_id_idx is dropped explicitly.

BEGIN;

-- ── Plan 3's bodies ─────────────────────────────────────────────────────────

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

-- Idempotent. Returns the number of rows revoked.
CREATE OR REPLACE FUNCTION public.revoke_buyer_ticket_devices(p_buyer_id uuid)
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

REVOKE ALL ON FUNCTION public.bind_ticket_device(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_ticket_device(uuid, uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.move_order_buyer(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_order_buyer(uuid, uuid, uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.revoke_buyer_ticket_devices(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_buyer_ticket_devices(uuid) TO service_role;

-- ── The eight new functions ─────────────────────────────────────────────────

DROP FUNCTION public.void_enrollment_tickets(uuid);
DROP FUNCTION public.give_back_seat(uuid, uuid, uuid);
DROP FUNCTION public.claim_share_link(text, uuid, uuid);
DROP FUNCTION public.preview_share_link(text, uuid, uuid);
DROP FUNCTION public.cancel_share_link(uuid, uuid, uuid);
DROP FUNCTION public.create_share_link(uuid, uuid, uuid, text);
DROP FUNCTION public.seat_open_for_sharing(uuid, uuid);
DROP FUNCTION public.share_cutoff(date);

-- ── Tables, index and column ────────────────────────────────────────────────

-- A friend's phone must not stay bound to a seat that returns to its leader.
UPDATE public.ticket_devices d
   SET revoked_at = now(), revoked_by = 'holder_changed'
  FROM public.tickets t
 WHERE d.ticket_id = t.id AND t.holder_buyer_id IS NOT NULL AND d.revoked_at IS NULL;

DROP TABLE public.ticket_holder_events;   -- its indexes go with it
DROP TABLE public.ticket_share_links;     -- its indexes go with it
DROP INDEX public.tickets_holder_buyer_id_idx;
ALTER TABLE public.tickets DROP COLUMN holder_buyer_id;

NOTIFY pgrst, 'reload schema';

COMMIT;
