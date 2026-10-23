-- ─── Custom web font per event ──────────────────────────────────────────────
--
-- An organiser can set one font for an event's public landing page, served by
-- Adobe Fonts (which carries the web licence — a desktop font file usually
-- does not):
--
--   intakes.font_css_url — the web project's stylesheet,
--                          https://use.typekit.net/<project id>.css
--   intakes.font_family  — the CSS font-family name Adobe lists for it,
--                          e.g. antique-olive-nord
--
-- Both or neither. Only use.typekit.net is accepted: the stylesheet is loaded
-- into a public page, so it must not point anywhere an organiser chooses. The
-- name goes into an inline style, so it is limited to letters, digits, spaces
-- and hyphens. src/lib/eventFont.ts enforces the same rules first with a 400;
-- these are the backstop.
--
-- Additive. Existing events get NULL and look exactly as before.
--
-- DEPLOY ORDER: apply this BEFORE the code that reads it. Without it, the
-- public event endpoint selects columns that do not exist and fails.

alter table public.intakes
  add column if not exists font_css_url text,
  add column if not exists font_family text;

alter table public.intakes
  drop constraint if exists intakes_font_pair;
alter table public.intakes
  add constraint intakes_font_pair
  check ((font_css_url is null) = (font_family is null));

alter table public.intakes
  drop constraint if exists intakes_font_css_url_adobe;
alter table public.intakes
  add constraint intakes_font_css_url_adobe
  check (font_css_url is null or font_css_url ~ '^https://use\.typekit\.net/[a-z0-9]{1,32}\.css$');

alter table public.intakes
  drop constraint if exists intakes_font_family_safe;
alter table public.intakes
  add constraint intakes_font_family_safe
  check (font_family is null or font_family ~ '^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$');

comment on column public.intakes.font_css_url is
  'Adobe Fonts web project stylesheet for the event landing page; NULL for the template''s own fonts.';
comment on column public.intakes.font_family is
  'CSS font-family name from that Adobe Fonts project; set together with font_css_url.';
