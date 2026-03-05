-- ============================================================
-- 013_create_announcements.sql
-- Nihon Moment — Announcement composer / history log.
--
-- Stores announcements composed by admins.  Actual email/SMS
-- dispatch will be wired in Sprint 4; this table is the source
-- of truth for the history panel.
--
-- target_label is denormalised so history rows survive even if
-- the linked intake/class is later deleted.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.announcements (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES public.tenants  (id) ON DELETE CASCADE,
  intake_id     uuid                 REFERENCES public.intakes  (id) ON DELETE SET NULL,
  class_level   jlpt_level,                    -- NULL = all classes for this intake
  target_label  varchar     NOT NULL,           -- "N5 — April 2026 Intake" or "All Classes — April 2026 Intake"
  message       text        NOT NULL,
  sent_by_id    uuid                 REFERENCES public.users    (id) ON DELETE SET NULL,
  sent_by_name  varchar,                        -- denormalised display name
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_announcements_tenant_id  ON public.announcements (tenant_id);
CREATE INDEX IF NOT EXISTS idx_announcements_created_at ON public.announcements (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_announcements_intake_id  ON public.announcements (intake_id);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "announcements_select"
  ON public.announcements
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());

CREATE POLICY "announcements_insert"
  ON public.announcements
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.get_my_tenant_id());

-- Admins may update/delete their own announcements
CREATE POLICY "announcements_update"
  ON public.announcements
  FOR UPDATE
  TO authenticated
  USING     (tenant_id = public.get_my_tenant_id())
  WITH CHECK (tenant_id = public.get_my_tenant_id());

CREATE POLICY "announcements_delete"
  ON public.announcements
  FOR DELETE
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());
