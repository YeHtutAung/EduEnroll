-- ─── Marketing page versions ─────────────────────────────────────────────────
--
-- Versioned content for the marketing homepage: at most one draft and one
-- published row, plus any number of archived rows for restore.
--
-- Access is server-side only, with the service role, after requireSuperadmin.
-- RLS alone doesn't remove grants, and hosted Supabase gives new tables and
-- functions to anon and authenticated by default, so both are revoked below.
--
-- Additive, and safe in either order: without this migration the public page
-- falls back to defaultContent and the Marketing screen says "not configured".

BEGIN;

CREATE TABLE public.marketing_page_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status       text NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  content      jsonb NOT NULL,
  revision     integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  published_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE UNIQUE INDEX marketing_page_versions_one_draft
  ON public.marketing_page_versions (status) WHERE status = 'draft';
CREATE UNIQUE INDEX marketing_page_versions_one_published
  ON public.marketing_page_versions (status) WHERE status = 'published';

ALTER TABLE public.marketing_page_versions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.marketing_page_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.marketing_page_versions TO service_role;

-- First save. Both functions take the same lock first. Otherwise a save could
-- read the old published id, wait on the unique index while a publish commits,
-- and then insert content based on a version that is no longer live.
CREATE FUNCTION public.create_marketing_draft(
  p_base_published_id uuid,
  p_content jsonb,
  p_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_published uuid;
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('marketing_page_versions', 0));

  IF EXISTS (SELECT 1 FROM public.marketing_page_versions WHERE status = 'draft') THEN
    RAISE EXCEPTION 'marketing_draft_stale' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_published FROM public.marketing_page_versions WHERE status = 'published';
  IF v_published IS DISTINCT FROM p_base_published_id THEN
    RAISE EXCEPTION 'marketing_draft_stale' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.marketing_page_versions (status, content, revision, created_by)
  VALUES ('draft', p_content, 1, p_user_id)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE FUNCTION public.publish_marketing_draft(
  p_expected_revision integer,
  p_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_revision integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('marketing_page_versions', 0));

  SELECT id, revision INTO v_id, v_revision
  FROM public.marketing_page_versions
  WHERE status = 'draft'
  FOR UPDATE;

  IF v_id IS NULL OR v_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'marketing_draft_stale' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.marketing_page_versions
  SET status = 'archived', updated_at = now()
  WHERE status = 'published';

  UPDATE public.marketing_page_versions
  SET status = 'published', published_by = p_user_id, published_at = now(), updated_at = now()
  WHERE id = v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_marketing_draft(uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_marketing_draft(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_marketing_draft(uuid, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_marketing_draft(integer, uuid) TO service_role;

-- Public read through its URL. No write policies on purpose: uploads only
-- happen through the superadmin route, with the service role.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'marketing-assets',
  'marketing-assets',
  true,
  4194304,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

COMMIT;
