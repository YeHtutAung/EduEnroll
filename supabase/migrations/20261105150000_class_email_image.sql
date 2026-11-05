-- An optional image per ticket tier, printed in the confirmation email. Empty by
-- default, so a tier without one sends the same email as before.

alter table public.classes
  add column if not exists email_image_url text;

alter table public.classes
  drop constraint if exists classes_email_image_url_https;

alter table public.classes
  add constraint classes_email_image_url_https
  check (email_image_url is null or email_image_url like 'https://%');
