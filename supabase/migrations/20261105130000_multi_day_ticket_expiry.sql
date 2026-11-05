-- Tickets for a multi-day event were issued with exp at the end of the START
-- date, so /api/scans refused them for the rest of the event. New tickets now use
-- the end date (classes.end_time, a DATE since migration 031); this corrects the
-- tickets already issued.
--
-- Only ever moves exp later, so it is safe to run again and cannot shorten a
-- ticket. Asia/Yangon is the default TICKET_TZ.
--
-- A QR already saved or emailed keeps its old exp inside the signed token, and the
-- scanner app checks that copy on the device. This does not change those; the
-- payment page generates a fresh QR from this column.

update public.tickets t
set exp = (c.end_time + time '23:59:59') at time zone 'Asia/Yangon'
from public.classes c
where c.id = t.class_id
  and c.end_time > c.event_date
  and t.exp < (c.end_time + time '23:59:59') at time zone 'Asia/Yangon';
