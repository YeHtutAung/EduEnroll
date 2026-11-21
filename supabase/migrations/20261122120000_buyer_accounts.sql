-- Buyer accounts (account-bound tickets Plan 2; mobile spec 4.1, 4.2, 4.4, 12 steps 1, 1a, 2).
-- Every new object is service-role only: RLS on with no policies, functions
-- revoked from PUBLIC, anon and authenticated.

-- ─── buyer_profiles ─────────────────────────────────────────────────────────
CREATE TABLE public.buyer_profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text NOT NULL UNIQUE CHECK (email = lower(email)),
  phone_e164  text NULL,                -- unverified contact number; never used to sign in or find orders
  name        text NULL,
  locale      text NOT NULL DEFAULT 'my' CHECK (locale IN ('my', 'en')),
  is_reviewer boolean NOT NULL DEFAULT false,  -- set only by a superadmin or the reviewer repair
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz NULL
);
ALTER TABLE public.buyer_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.buyer_profiles TO service_role;

-- ─── buyer_profile_claims ───────────────────────────────────────────────────
CREATE TABLE public.buyer_profile_claims (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  token      uuid NOT NULL,
  claimed_at timestamptz NOT NULL
);
ALTER TABLE public.buyer_profile_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_profile_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.buyer_profile_claims TO service_role;

-- ─── mobile_rate_limits ─────────────────────────────────────────────────────
CREATE TABLE public.mobile_rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        int NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
ALTER TABLE public.mobile_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mobile_rate_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mobile_rate_limits TO service_role;
CREATE INDEX mobile_rate_limits_window_start_idx ON public.mobile_rate_limits (window_start);

-- Counts one event for p_key in the current fixed window and says whether it
-- is still within p_limit. The caller passes an already-hashed key; this never
-- sees an email address. Windows are 1 s to 1 day: a longer window would be
-- swept by the two-day cleanup below while still counting, and fail open.
CREATE FUNCTION public.consume_rate_limit(p_key text, p_window_seconds int, p_limit int)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_start timestamptz;
  v_count int;
BEGIN
  IF p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 1 AND 86400 OR p_limit IS NULL OR p_limit < 0 THEN
    RAISE EXCEPTION 'bad rate limit args' USING ERRCODE = '22023';
  END IF;

  -- Assigned after the check: in DECLARE it would divide by zero first.
  v_start := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);

  INSERT INTO public.mobile_rate_limits AS r (key, window_start, count)
  VALUES (p_key, v_start, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET count = r.count + 1
  RETURNING r.count INTO v_count;

  -- Rows expire whether or not their key comes back (a deleted account's keys
  -- included): each call drops up to 50 windows, of any key, older than two days.
  DELETE FROM public.mobile_rate_limits
  WHERE ctid = ANY (ARRAY(
    SELECT ctid FROM public.mobile_rate_limits
    WHERE window_start < now() - interval '2 days'
    LIMIT 50
  ));

  RETURN v_count <= p_limit;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_rate_limit(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(text, int, int) TO service_role;

-- ─── Profile claim (mobile spec 4.1 step 2) ─────────────────────────────────
-- Returns the new claim token, 'exists' when a profile row (live or being
-- deleted) is already there, or NULL when another caller holds a fresh claim.
-- The profile check is a separate statement after the claim, so under
-- READ COMMITTED it sees a profile committed in the meantime.
CREATE FUNCTION public.claim_buyer_profile(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_token uuid;
BEGIN
  INSERT INTO public.buyer_profile_claims AS c (user_id, token, claimed_at)
  VALUES (p_user_id, gen_random_uuid(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET token = gen_random_uuid(), claimed_at = now()
    WHERE c.claimed_at < now() - interval '30 seconds'
  RETURNING c.token INTO v_token;

  IF v_token IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM public.buyer_profiles WHERE id = p_user_id) THEN
    DELETE FROM public.buyer_profile_claims WHERE user_id = p_user_id AND token = v_token;
    RETURN 'exists';
  END IF;

  RETURN v_token::text;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_buyer_profile(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_buyer_profile(uuid) TO service_role;

CREATE FUNCTION public.buyer_profile_claim_held(p_user_id uuid, p_token uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.buyer_profile_claims WHERE user_id = p_user_id AND token = p_token
  );
$$;
REVOKE ALL ON FUNCTION public.buyer_profile_claim_held(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_profile_claim_held(uuid, uuid) TO service_role;

-- Returns 'created', 'existing' (a row was already there) or 'lost' (the
-- claim was taken over; nothing inserted).
CREATE FUNCTION public.create_buyer_profile(p_user_id uuid, p_token uuid, p_email text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_inserted int;
BEGIN
  PERFORM 1 FROM public.buyer_profile_claims
  WHERE user_id = p_user_id AND token = p_token
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'lost';
  END IF;

  -- ON CONFLICT (id) only: an email already used by ANOTHER user's profile
  -- must raise (unique_violation), not look like 'existing' for this user.
  INSERT INTO public.buyer_profiles (id, email)
  VALUES (p_user_id, lower(p_email))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  DELETE FROM public.buyer_profile_claims WHERE user_id = p_user_id AND token = p_token;

  RETURN CASE WHEN v_inserted = 1 THEN 'created' ELSE 'existing' END;
END;
$$;
REVOKE ALL ON FUNCTION public.create_buyer_profile(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_buyer_profile(uuid, uuid, text) TO service_role;

-- Deletes only the caller's own claim, never someone else's.
CREATE FUNCTION public.release_buyer_profile_claim(p_user_id uuid, p_token uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.buyer_profile_claims WHERE user_id = p_user_id AND token = p_token;
$$;
REVOKE ALL ON FUNCTION public.release_buyer_profile_claim(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_buyer_profile_claim(uuid, uuid) TO service_role;

-- ─── Email sync (mobile spec 4.2, 12 step 1a) ───────────────────────────────
-- Email change isn't offered, but Supabase can't switch updateUser({ email })
-- off. If both addresses confirm a change anyway, keep the profile equal to
-- the auth email in the same transaction. Does nothing else: an error here
-- would roll back the Auth update.
CREATE FUNCTION public.sync_buyer_profile_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.buyer_profiles
  SET email = lower(NEW.email), updated_at = now()
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sync_buyer_profile_email() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_buyer_profile_email() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER buyer_profile_email_sync
AFTER UPDATE OF email ON auth.users
FOR EACH ROW
WHEN (OLD.email IS DISTINCT FROM NEW.email AND NEW.email IS NOT NULL)
EXECUTE FUNCTION public.sync_buyer_profile_email();
