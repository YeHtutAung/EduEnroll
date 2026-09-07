// ─── Cache policy for uploaded storage objects ───────────────────────────────
// Supabase serves `Cache-Control: no-cache` when an upload does not set one, so
// every visit re-downloaded every image. On 2026-09-07 the live event page was
// 452 KB of artwork — about four minutes on the 2 KB/s connection a buyer
// reported, paid again on every page load and every press of the back button.
//
// A year is safe here because every upload path is effectively immutable:
//
//   tenant-assets/<tenant>/<type>/<Date.now()>.<ext>        new name each upload
//   class-images/<tenant>/<intake>/<level>-<Date.now()>     new name each upload
//   intake-images/<tenant>/<intake>/hero-<Date.now()>       new name each upload
//   qr-codes/<tenant>/<Date.now()>-<random>.<ext>           new name each upload
//   school-logos/<tenant>/logo.<ext>                        FIXED path, but the
//     stored tenants.logo_url is `publicUrl + "?t=" + Date.now()`, so the URL
//     a browser sees still changes on every re-upload.
//
// If a future upload path reuses a filename WITHOUT a query buster, it must not
// use this constant — a stale asset would be pinned in caches for a year.
//
// Supabase takes this as a string of seconds and emits `max-age=<n>`.
export const STORAGE_CACHE_CONTROL = "31536000"; // 1 year
