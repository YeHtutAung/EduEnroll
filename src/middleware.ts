import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { extractSubdomainFromHost, isDevHost } from "@/lib/tenant";

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

export async function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  const { pathname } = request.nextUrl;

  // ── Tenant detection (subdomain or localhost fallback) ───────────────────
  let tenantSlug: string | null = null;
  const host = request.headers.get("host") ?? "";
  const hostname = host.split(":")[0];
  const isRootDomain =
    hostname === "kuunyi.com" ||
    hostname === "www.kuunyi.com" ||
    hostname === "staging.kuunyi.com" ||
    hostname === "edu-enroll-xi.vercel.app";

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
    "/login",
    "/admin/:path*",
    "/superadmin",
    "/superadmin/:path*",
    "/onboarding",
    "/api/:path*",
    "/enroll/:path*",
    "/status",
  ],
};
