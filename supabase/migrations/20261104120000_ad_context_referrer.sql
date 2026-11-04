-- The outside site a buyer arrived from, as scheme and host only, for Meta's
-- referrer_url. Stored and deleted with the rest of the ad context.
ALTER TABLE public.enrollment_ad_context
  ADD COLUMN referrer_url text;
