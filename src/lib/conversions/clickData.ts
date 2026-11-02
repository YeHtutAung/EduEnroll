// ─── Ad click cookie: pure rules ────────────────────────────────────────────
//
// Holds the ad platforms' click IDs and when they were seen. Nothing else: no
// order ref, no buyer data. See
// docs/superpowers/specs/2026-11-02-purchase-conversion-design.md.

export const AD_CLICK_COOKIE = "kn_ad_click";
export const AD_CLICK_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const CLICK_VALUE_RE = /^[A-Za-z0-9._\-=+/]{1,500}$/;

export function cleanClickValue(value: unknown): string | null {
  return typeof value === "string" && CLICK_VALUE_RE.test(value) ? value : null;
}

export interface ClickData {
  fbclid: string | null;
  ttclid: string | null;
  at: number | null;
}

export function parseClickCookie(raw: string | null | undefined): ClickData {
  const empty: ClickData = { fbclid: null, ttclid: null, at: null };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
    return {
      fbclid: cleanClickValue(parsed.fbclid),
      ttclid: cleanClickValue(parsed.ttclid),
      at: typeof parsed.at === "number" && Number.isFinite(parsed.at) ? parsed.at : null,
    };
  } catch {
    return empty;
  }
}

/** The new cookie value, or null when the URL carries no valid click ID. */
export function nextClickCookie(search: string, existing: string | null | undefined, now: number): string | null {
  const params = new URLSearchParams(search);
  const fbclid = cleanClickValue(params.get("fbclid"));
  const ttclid = cleanClickValue(params.get("ttclid"));
  if (!fbclid && !ttclid) return null;
  const current = parseClickCookie(existing);
  return encodeURIComponent(
    JSON.stringify({ fbclid: fbclid ?? current.fbclid, ttclid: ttclid ?? current.ttclid, at: now }),
  );
}

export function buildFbc(fbclid: string, capturedAtMs: number): string {
  return `fb.1.${capturedAtMs}.${fbclid}`;
}
