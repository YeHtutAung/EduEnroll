-- A ticket for a multi-day event admits once per day. /api/scans claims the day by
-- moving last_scan_date in one conditional update, the same race-safe pattern as
-- first_scan_at. One-day tickets don't use these columns.
--
-- APPLY BEFORE THE CODE: /api/scans sets these columns, so a multi-day pass can't
-- be scanned until they exist.

alter table public.tickets
  add column if not exists last_scan_date date,
  add column if not exists last_scan_at timestamptz,
  add column if not exists last_scan_gate text;

-- A ticket already scanned today must not get a second entry when this ships.
-- Asia/Yangon is the default TICKET_TZ.
update public.tickets
set last_scan_date = (first_scan_at at time zone 'Asia/Yangon')::date,
    last_scan_at = first_scan_at,
    last_scan_gate = first_scan_gate
where first_scan_at is not null
  and last_scan_date is null;
