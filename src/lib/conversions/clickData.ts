// ─── Ad click cookie: pure rules ────────────────────────────────────────────
//
// Holds the ad platforms' click IDs and when they were seen. Nothing else: no
// order ref, no buyer data. See
// docs/superpowers/specs/2026-11-02-purchase-conversion-design.md.

export const AD_CLICK_COOKIE = "kn_ad_click";
export const AD_CLICK_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const AD_REFERRER_COOKIE = "kn_ad_referrer";
const REFERRER_ORIGIN_MAX = 255;

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
      at: typeof parsed.at === "number" && Number.isSafeInteger(parsed.at) && parsed.at > 0 ? parsed.at : null,
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
    JSON.stringify({
      fbclid: fbclid ?? current.fbclid,
      ttclid: ttclid ?? current.ttclid,
      // Only a new fbclid restarts its clock: fbc embeds this time, so a reload
      // or a ttclid landing must not move it.
      at: fbclid && fbclid !== current.fbclid ? now : (current.at ?? now),
    }),
  );
}

/**
 * The site a buyer arrived from, as scheme and host only. The path and query of
 * another site can hold personal details, and Meta only needs to know the source.
 * Null for anything that isn't a plain web address.
 */
export function cleanReferrerOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin.length <= REFERRER_ORIGIN_MAX ? `${url.origin}/` : null;
  } catch {
    return null;
  }
}

export function buildFbc(fbclid: string, capturedAtMs: number): string {
  return `fb.1.${capturedAtMs}.${fbclid}`;
}

/**
 * The query to carry across a redirect that would otherwise drop it: the two
 * click IDs, validated, and nothing else. The rest of the query can hold
 * sensitive params and must never be forwarded. Returns "" or "?a=b".
 */
export function forwardedClickQuery(params: URLSearchParams): string {
  const out = new URLSearchParams();
  const fbclid = cleanClickValue(params.get("fbclid"));
  const ttclid = cleanClickValue(params.get("ttclid"));
  if (fbclid) out.set("fbclid", fbclid);
  if (ttclid) out.set("ttclid", ttclid);
  const q = out.toString();
  return q ? `?${q}` : "";
}
