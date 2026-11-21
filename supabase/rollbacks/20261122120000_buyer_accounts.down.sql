-- Reverse of 20261122120000_buyer_accounts.sql. Destroys buyer profiles:
-- run only with the owner's explicit confirmation.
DROP TRIGGER IF EXISTS buyer_profile_email_sync ON auth.users;
DROP FUNCTION IF EXISTS public.sync_buyer_profile_email();
DROP FUNCTION IF EXISTS public.release_buyer_profile_claim(uuid, uuid);
DROP FUNCTION IF EXISTS public.create_buyer_profile(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.buyer_profile_claim_held(uuid, uuid);
DROP FUNCTION IF EXISTS public.claim_buyer_profile(uuid);
DROP FUNCTION IF EXISTS public.consume_rate_limit(text, int, int);
DROP TABLE IF EXISTS public.mobile_rate_limits;
DROP TABLE IF EXISTS public.buyer_profile_claims;
DROP TABLE IF EXISTS public.buyer_profiles;
