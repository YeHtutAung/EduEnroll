// ─── Sky Festival walk-in notice ─────────────────────────────────────────────
//
// Online sales for Sky Festival 2026 have closed, so visitors are told that
// walk-in tickets are sold at the gate. Fixed for this one tenant on purpose
// (owner decision 2026-11-21: fastest route to production on the festival's
// first day). An admin-editable notice per event would replace this.
//
// Shown on the tenant's public pages, not on order and ticket pages
// (/enroll/payment/<ref>, /status): a buyer opening their QR at the gate must
// not have it covered.
//
// Shown on every visit (owner decision 2026-11-21): with sales closed, this
// is what visitors come for. Nothing is remembered after Close. Nothing goes
// in localStorage or sessionStorage either: any key outside SAFE_STORAGE_KEYS
// in tagManager.ts would switch the tenant's GTM off.

export const WALK_IN_NOTICE_TENANT = "skyfestival";

/** Hidden from the end of 24 Nov 2026 in Yangon, the festival's last day. */
export const WALK_IN_NOTICE_ENDS_AT = Date.parse("2026-11-24T17:30:00Z");

const EXCLUDED_PREFIXES = ["/enroll/payment", "/status"];

export function walkInNoticeApplies(tenantSlug: string | null, pathname: string, now: number): boolean {
  if (tenantSlug !== WALK_IN_NOTICE_TENANT) return false;
  if (now >= WALK_IN_NOTICE_ENDS_AT) return false;
  return !EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
