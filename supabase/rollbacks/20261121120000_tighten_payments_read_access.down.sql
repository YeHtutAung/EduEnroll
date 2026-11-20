-- Rollback for 20261121120000_tighten_payments_read_access.sql
--
-- Restores the table privileges `anon` held before (the Supabase defaults).
-- That alone gives anon no rows: RLS stays on and no anon policy exists.
--
-- The dropped `anon_read_payments` policy is deliberately NOT recreated:
-- it was never part of a migration, and no code in this repo depends on it.
-- If an outside tool turns out to need it, give that tool a narrow,
-- server-side path instead of reopening the table to anon.
BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.payments TO anon;

COMMIT;
