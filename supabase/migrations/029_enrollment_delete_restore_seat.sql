-- ─── Migration 029: Auto-restore seat on enrollment delete ───────────────────
-- When an enrollment row is deleted (by any means — admin dashboard, API, etc.),
-- automatically increment seat_remaining on the corresponding class.

CREATE OR REPLACE FUNCTION public.restore_seat_on_enrollment_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.classes
  SET seat_remaining = LEAST(seat_remaining + 1, seat_total),
      status = CASE
        WHEN status = 'full' THEN 'open'::class_status
        ELSE status
      END
  WHERE id = OLD.class_id;

  RETURN OLD;
END;
$$;

-- Drop if exists to make migration idempotent
DROP TRIGGER IF EXISTS trg_restore_seat_on_enrollment_delete ON public.enrollments;

CREATE TRIGGER trg_restore_seat_on_enrollment_delete
  AFTER DELETE ON public.enrollments
  FOR EACH ROW
  EXECUTE FUNCTION public.restore_seat_on_enrollment_delete();
