-- Optional text a ticket tier shows on the enrollment page once it sells out,
-- in place of the template's own "SOLD OUT". Empty by default, so every
-- existing tier looks exactly as before.
--
-- Apply BEFORE deploying the code: the public enrollment API selects this
-- column by name, so code that arrives first fails to load the tickets.
-- Adding a nullable column with no default only touches the catalog. The check
-- below reads every tier once to validate it, which on a table of a few hundred
-- rows takes milliseconds, so ticket sales aren't held up.

alter table public.classes
  add column if not exists sold_out_label text;

alter table public.classes
  drop constraint if exists classes_sold_out_label_length;

-- Short enough to fit on a ticket card; blank is stored as null by the API.
alter table public.classes
  add constraint classes_sold_out_label_length
  check (sold_out_label is null or char_length(btrim(sold_out_label)) between 1 and 60);
