import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  extractSubdomainFromHost,
  tenantForCustomHost,
  isDevHost,
  isPlatformRootHost,
} from "@/lib/tenant";

// ─── Routes that skip tenant detection ────────────────────────────────────────

const SKIP_TENANT_PREFIXES = ["/register", "/api/saas/", "/api/messenger/", "/api/stripe/", "/api/scans", "/api/events", "/superadmin", "/onboarding"];

function shouldSkipTenant(pathname: string): boolean {
  return SKIP_TENANT_PREFIXES.some((p) => pathname.startsWith(p));
}

// ─── Middleware ───────────────────────────────────────────────────────────────
// Host → tenant resolution lives in @/lib/tenant, which server components also
// use as a fallback when this middleware's x-tenant-slug header doesn't
// propagate on Vercel. This file used to carry a byte-identical copy; two
// resolvers is how a custom domain resolves on some requests and not others.

// ─── Transitional agent allowlist (#164 Phase 1) ─────────────────────────────
// x-tenant-slug is caller-supplied until middleware overwrites it, and it was
// only ever overwritten when a tenant resolved — so on the platform root, an
// unknown host, or a skipped prefix, a forged value survived downstream.
//
// It is deleted everywhere except these prefixes, which the Telegram bot signs
// requests to while it still calls the platform root. Every route beneath them
// goes through requireAuth()/requireOwner(): a session user's tenant comes from
// their profile (so the header is inert), and an agent request is HMAC-verified.
//
// Gated on PATH, never on the presence of x-agent-signature — anyone can send
// that header, which would make the sanitization bypassable by exactly the
// callers it exists to stop.
//
// Removed once the bot moves to tenant hosts; see the Phase 2 signing plan.
const AGENT_TRANSITIONAL_PREFIXES = [
  "/api/admin/",
  "/api/intakes",
  "/api/classes/",
];

function isTransitionalAgentPath(pathname: string): boolean {
  return AGENT_TRANSITIONAL_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export async function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  const { pathname } = request.nextUrl;

  // Before shouldSkipTenant(), so /api/messenger/*, /api/saas/*, /api/events,
  // /api/scans and /superadmin are covered too.
  if (!isTransitionalAgentPath(pathname)) {
    requestHeaders.delete("x-tenant-slug");
  }

  // Route family for the transitional telemetry in requireAuth(), which cannot
  // see the path: it reads headers() only. A fixed enum, never the raw path —
  // no uuids, query strings or slugs.
  //
  // Deleted unconditionally first so it is middleware-written or absent; a
  // caller-supplied value would be another client-controlled input, which is
  // the defect this change exists to remove.
  requestHeaders.delete("x-agent-route-family");
  if (isTransitionalAgentPath(pathname)) {
    requestHeaders.set(
      "x-agent-route-family",
      pathname.startsWith("/api/admin/")
        ? "admin"
        : pathname.startsWith("/api/intakes")
          ? "intakes"
          : "classes",
    );
  }

  // ── Tenant detection (subdomain or localhost fallback) ───────────────────
  let tenantSlug: string | null = null;
  const host = request.headers.get("host") ?? "";
  const hostname = host.split(":")[0];
  const isRootDomain = isPlatformRootHost(host);

  // ── Custom domain surface split ──────────────────────────────────────────
  // A tenant's own domain is student-facing only. Staff surfaces stay on the
  // kuunyi subdomain so sessions live on exactly one origin; platform surfaces
  // stay on the platform root so a client's domain never serves signup or
  // superadmin. Runs before shouldSkipTenant(): /superadmin, /register and
  // /onboarding skip tenant detection and would otherwise slip through.
  const customTenant = tenantForCustomHost(host);
  if (customTenant) {
    const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "kuunyi.com";
    const search = request.nextUrl.search;

    // app/page.tsx renders the KuuNyi SaaS landing for every host — not
    // something to serve on a client's homepage. Send the root to their
    // enrollment index.
    if (pathname === "/") {
      return NextResponse.redirect(new URL("/enroll", request.url));
    }

    // Root-platform surfaces: the platform's, not this tenant's.
    if (/^\/(register|superadmin)(\/|$)/.test(pathname)) {
      return NextResponse.redirect(`https://${appDomain}${pathname}${search}`);
    }

    // Tenant staff surfaces.
    if (/^\/(admin|login|onboarding)(\/|$)/.test(pathname)) {
      return NextResponse.redirect(`https://${customTenant}.${appDomain}${pathname}${search}`);
    }

    // Not a security control: tenant-scoped authorization is. This only avoids
    // answering platform calls on a client's domain.
    if (/^\/api\/(admin|saas|superadmin)(\/|$)/.test(pathname)) {
      return new NextResponse("Not Found", { status: 404 });
    }
  }

  // "/" is in the matcher only for the redirect above. The landing page needs no
  // session, so skip the Supabase round-trip the rest of this middleware does.
  // Must forward the sanitized headers: a bare NextResponse.next() carries the
  // ORIGINAL request headers, so a forged slug would still reach app/layout.tsx
  // on the platform root — the deletion above would be bypassed on the most
  // obvious host to attack.
  if (pathname === "/") {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  if (!shouldSkipTenant(pathname)) {
    tenantSlug = extractSubdomainFromHost(host);

    // Dev conveniences — ?tenant=, the cookie, NEXT_PUBLIC_DEV_TENANT — must
    // never establish tenant context on a host we do not control. The old guard
    // was `!isRootDomain`, a four-host literal list, so every UNKNOWN host
    // qualified: https://flashtic.evil.com/enroll?tenant=flashtic got tenant
    // context even after the resolver correctly returned null. Gate on the host
    // instead.
    //
    // VERCEL_ENV, not NODE_ENV: Vercel preview deployments run
    // NODE_ENV=production, and staging CI targets a 3-part *.vercel.app preview
    // host that resolves to null and relies on this fallback. VERCEL_ENV is
    // production|preview|development and is unset locally.
    if (!tenantSlug && process.env.VERCEL_ENV !== "production" && isDevHost(hostname)) {
      tenantSlug =
        request.nextUrl.searchParams.get("tenant") ??
        request.cookies.get("x-tenant-slug")?.value ??
        process.env.NEXT_PUBLIC_DEV_TENANT ??
        null;
    }

    if (tenantSlug) {
      requestHeaders.set("x-tenant-slug", tenantSlug);
    }

    // Block /admin on root domain — no tenant context means no school dashboard
    // Note: /login is allowed on root domain for superadmin access
    if (!tenantSlug && isRootDomain && pathname.startsWith("/admin")) {
      return NextResponse.redirect(new URL("/register", request.url));
    }
  }

  // ── Supabase auth session refresh ────────────────────────────────────────
  let response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({
            request: { headers: requestHeaders },
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user && pathname === "/login") {
    // Check x-user-role cookie (set by LoginForm after auth) for superadmin redirect
    const userRole = request.cookies.get("x-user-role")?.value;
    const dest = userRole === "superadmin" ? "/superadmin" : "/admin/dashboard";
    const loginRedirect = NextResponse.redirect(new URL(dest, request.url));
    // Persist the tenant slug cookie so the admin layout has tenant context after redirect
    if (tenantSlug) {
      loginRedirect.cookies.set("x-tenant-slug", tenantSlug, {
        path: "/",
        httpOnly: false,
        sameSite: "lax",
        maxAge: 60 * 60 * 24,
      });
    }
    return loginRedirect;
  }

  if (!user && pathname.startsWith("/admin")) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Onboarding requires auth
  if (!user && pathname.startsWith("/onboarding")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Set tenant cookie so client-side fetches carry the tenant slug.
  // Only set when ?tenant= param was used (explicit override) to avoid stale cookies.
  const tenantParam = request.nextUrl.searchParams.get("tenant");
  if (tenantParam && tenantSlug) {
    response.cookies.set("x-tenant-slug", tenantSlug, {
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      maxAge: 60 * 60 * 24, // 24 hours
    });
  }

  return response;
}

export const config = {
  matcher: [
    // "/" and "/register" are here only so the custom-domain surface split can
    // redirect them; without these entries middleware never runs there and the
    // redirects silently no-op.
    "/",
    "/login",
    "/register",
    "/admin/:path*",
    "/superadmin",
    "/superadmin/:path*",
    "/onboarding",
    "/api/:path*",
    "/enroll/:path*",
    "/status",
  ],
};
