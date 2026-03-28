-- ─── Auto-reopen class when seats become available ───────────────────────────

CREATE OR REPLACE FUNCTION auto_reopen_class()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'full' AND NEW.seat_remaining > 0 THEN
    NEW.status := 'open';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_auto_reopen_class
  BEFORE UPDATE ON classes
  FOR EACH ROW
  EXECUTE FUNCTION auto_reopen_class();
