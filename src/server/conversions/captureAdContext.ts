import { createAdminClient } from "@/lib/supabase/admin";
import { tenantLinkOrigin } from "@/lib/origin";
import { clientIpFrom } from "@/lib/rateLimit";
import {
  AD_CLICK_COOKIE,
  AD_REFERRER_COOKIE,
  buildFbc,
  cleanClickValue,
  cleanReferrerOrigin,
  GA_CLIENT_COOKIE,
  gaSessionCookieName,
  parseClickCookie,
  parseGaClientId,
  parseGaSessionId,
} from "@/lib/conversions/clickData";

const USER_AGENT_MAX = 1000;
const CAPTURE_TIMEOUT_MS = 1500;

export interface AdContext {
  fbp: string | null;
  fbc: string | null;
  ttp: string | null;
  ttclid: string | null;
  client_ip: string | null;
  user_agent: string | null;
  referrer_url: string | null;
  ga_client_id: string | null;
}

/** Cookies can be edited by the browser, so this cleans it again. */
function storedReferrer(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return cleanReferrerOrigin(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

/**
 * Null when the buyer has none of fbp, fbc, ttp, ttclid or a GA cookie: their IP
 * is never stored. Pixel cookies count on their own (owner's decision, 2026-11-02).
 */
export function adContextFromRequest(
  cookie: (name: string) => string | undefined,
  headers: Headers,
): AdContext | null {
  const clicks = parseClickCookie(cookie(AD_CLICK_COOKIE));
  const fbp = cleanClickValue(cookie("_fbp"));
  const ttp = cleanClickValue(cookie("_ttp"));
  const fbc =
    cleanClickValue(cookie("_fbc")) ??
    (clicks.fbclid && clicks.at !== null ? buildFbc(clicks.fbclid, clicks.at) : null);
  const ttclid = clicks.ttclid;
  const gaClientId = parseGaClientId(cookie(GA_CLIENT_COOKIE));
  if (!fbp && !fbc && !ttp && !ttclid && !gaClientId) return null;

  const ip = clientIpFrom(headers);
  return {
    fbp,
    fbc,
    ttp,
    ttclid,
    client_ip: ip === "unknown" ? null : ip,
    user_agent: headers.get("user-agent")?.slice(0, USER_AGENT_MAX) ?? null,
    referrer_url: storedReferrer(cookie(AD_REFERRER_COOKIE)),
    ga_client_id: gaClientId,
  };
}

/**
 * Never throws: a tracking failure must not fail an order that already holds
 * its seats. All its queries share one time limit, so a stalled database cannot
 * hold the order response. The cookie check comes first, so only a buyer with no
 * pixel cookie or click ID costs no query; pixels set _fbp for every visitor, so
 * most orders from a tracked page do run them. Logs carry only an error code or
 * name, never a cookie, IP or click ID.
 */
export async function captureAdContext(args: {
  cookie: (name: string) => string | undefined;
  headers: Headers;
  enrollmentId: string;
  tenantId: string;
  subdomain: string | null | undefined;
  classId: unknown;
}): Promise<void> {
  try {
    const context = adContextFromRequest(args.cookie, args.headers);
    if (!context) return;

    const signal = AbortSignal.timeout(CAPTURE_TIMEOUT_MS);
    const logTimeout = () => console.error("[conversions] ad context timed out:", "TimeoutError");

    const supabase = createAdminClient();
    const { data: settings, error: settingsError } = (await supabase
      .from("tenant_conversion_settings" as never)
      .select("tenant_id, ga4_measurement_id")
      .eq("tenant_id", args.tenantId)
      .eq("enabled", true)
      .abortSignal(signal)
      .maybeSingle()) as {
      data: { tenant_id: string; ga4_measurement_id?: string | null } | null;
      error: { code?: string } | null;
    };
    if (settingsError) {
      // A failed read is not "disabled": say so, then skip. The order stands.
      if (signal.aborted) logTimeout();
      else console.error("[conversions] settings read failed:", settingsError.code ?? "unknown");
      return;
    }
    if (!settings) return;

    // GA IDs are kept only for a tenant that reports to GA4. Without that, GA
    // cookies alone are no reason to store anything about this buyer.
    const measurementId = settings.ga4_measurement_id ?? null;
    if (!measurementId && !context.fbp && !context.fbc && !context.ttp && !context.ttclid) return;
    const gaIds = {
      ga_client_id: measurementId ? context.ga_client_id : null,
      ga_session_id: measurementId ? parseGaSessionId(args.cookie(gaSessionCookieName(measurementId))) : null,
    };

    // Built from our own data, never from the Host header or a request URL.
    let path = "/enroll";
    if (typeof args.classId === "string") {
      const { data: cls, error: clsError } = (await supabase
        .from("classes")
        .select("intakes(slug)")
        .eq("id", args.classId)
        .abortSignal(signal)
        .maybeSingle()) as {
        data: { intakes: { slug: string | null } | null } | null;
        error: { code?: string } | null;
      };
      if (clsError && signal.aborted) {
        logTimeout();
        return;
      }
      if (clsError) console.error("[conversions] class lookup failed:", clsError.code ?? "unknown");
      if (cls?.intakes?.slug) path = `/enroll/${encodeURIComponent(cls.intakes.slug)}`;
    }

    const { error } = (await supabase
      .from("enrollment_ad_context" as never)
      .upsert(
        {
          enrollment_id: args.enrollmentId,
          ...context,
          ...gaIds,
          source_url: `${tenantLinkOrigin(args.subdomain)}${path}`,
        } as never,
        { onConflict: "enrollment_id", ignoreDuplicates: true },
      )
      .abortSignal(signal)) as { error: { code?: string } | null };
    if (error && signal.aborted) logTimeout();
    else if (error) console.error("[conversions] ad context not stored:", error.code ?? "unknown");
  } catch (err) {
    console.error("[conversions] ad context failed:", err instanceof Error ? err.name : "unknown");
  }
}
