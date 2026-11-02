import { createAdminClient } from "@/lib/supabase/admin";
import { tenantLinkOrigin } from "@/lib/origin";
import { clientIpFrom } from "@/lib/rateLimit";
import { AD_CLICK_COOKIE, buildFbc, cleanClickValue, parseClickCookie } from "@/lib/conversions/clickData";

const USER_AGENT_MAX = 1000;

export interface AdContext {
  fbp: string | null;
  fbc: string | null;
  ttp: string | null;
  ttclid: string | null;
  client_ip: string | null;
  user_agent: string | null;
}

/**
 * Null when the buyer has none of fbp, fbc, ttp or ttclid: their IP is never
 * stored. Pixel cookies count on their own (owner's decision, 2026-11-02).
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
  if (!fbp && !fbc && !ttp && !ttclid) return null;

  const ip = clientIpFrom(headers);
  return {
    fbp,
    fbc,
    ttp,
    ttclid,
    client_ip: ip === "unknown" ? null : ip,
    user_agent: headers.get("user-agent")?.slice(0, USER_AGENT_MAX) ?? null,
  };
}

/**
 * Never throws: a tracking failure must not fail an order that already holds
 * its seats. The cookie check comes first, so organic orders cost no query.
 * Logs carry only an error code or name, never a cookie, IP or click ID.
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

    const supabase = createAdminClient();
    const { data: settings, error: settingsError } = (await supabase
      .from("tenant_conversion_settings" as never)
      .select("tenant_id")
      .eq("tenant_id", args.tenantId)
      .eq("enabled", true)
      .maybeSingle()) as { data: { tenant_id: string } | null; error: { code?: string } | null };
    if (settingsError) {
      // A failed read is not "disabled": say so, then skip. The order stands.
      console.error("[conversions] settings read failed:", settingsError.code ?? "unknown");
      return;
    }
    if (!settings) return;

    // Built from our own data, never from the Host header or a request URL.
    let path = "/enroll";
    if (typeof args.classId === "string") {
      const { data: cls, error: clsError } = (await supabase
        .from("classes")
        .select("intakes(slug)")
        .eq("id", args.classId)
        .maybeSingle()) as {
        data: { intakes: { slug: string | null } | null } | null;
        error: { code?: string } | null;
      };
      if (clsError) console.error("[conversions] class lookup failed:", clsError.code ?? "unknown");
      if (cls?.intakes?.slug) path = `/enroll/${encodeURIComponent(cls.intakes.slug)}`;
    }

    const { error } = (await supabase
      .from("enrollment_ad_context" as never)
      .upsert(
        { enrollment_id: args.enrollmentId, ...context, source_url: `${tenantLinkOrigin(args.subdomain)}${path}` } as never,
        { onConflict: "enrollment_id", ignoreDuplicates: true },
      )) as { error: { code?: string } | null };
    if (error) console.error("[conversions] ad context not stored:", error.code ?? "unknown");
  } catch (err) {
    console.error("[conversions] ad context failed:", err instanceof Error ? err.name : "unknown");
  }
}
