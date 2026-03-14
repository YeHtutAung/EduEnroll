-- Add messenger_psid to enrollments for chatbot notification on admin action
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS messenger_psid text;
