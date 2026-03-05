import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ─── Routes that skip tenant detection ────────────────────────────────────────

const SKIP_TENANT_PREFIXES = ["/register", "/api/saas/", "/superadmin", "/onboarding"];

function shouldSkipTenant(pathname: string): boolean {
  return SKIP_TENANT_PREFIXES.some((p) => pathname.startsWith(p));
}

// ─── Extract subdomain from hostname ──────────────────────────────────────────
// e.g. "nihonmoment.edu-enroll-xi.vercel.app" → "nihonmoment"
// e.g. "nihonmoment.localhost:3005" → "nihonmoment"

function extractSubdomain(host: string): string | null {
  // Remove port
  const hostname = host.split(":")[0];
  const parts = hostname.split(".");

  // localhost with subdomain: "nihonmoment.localhost"
  if (parts.length === 2 && parts[1] === "localhost") {
    return parts[0];
  }

  // Vercel domains: "nihonmoment.edu-enroll-xi.vercel.app" (4 parts)
  // The bare "edu-enroll-xi.vercel.app" (3 parts) is NOT a subdomain.
  if (parts.length >= 3 && parts[parts.length - 1] === "app" && parts[parts.length - 2] === "vercel") {
    return parts.length >= 4 ? parts[0] : null;
  }

  // Custom domain: "nihonmoment.eduenroll.com" (3+ parts)
  if (parts.length >= 3) {
    return parts[0];
  }

  return null;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export async function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  const { pathname } = request.nextUrl;

  // ── Tenant detection (subdomain or localhost fallback) ───────────────────
  let tenantSlug: string | null = null;

  if (!shouldSkipTenant(pathname)) {
    const host = request.headers.get("host") ?? "";
    tenantSlug = extractSubdomain(host);

    // Fallback chain when no subdomain detected: ?tenant= param → cookie → env var → null
    // Works on localhost AND bare prod domains (e.g. edu-enroll-xi.vercel.app)
    if (!tenantSlug) {
      tenantSlug =
        request.nextUrl.searchParams.get("tenant") ??
        request.cookies.get("x-tenant-slug")?.value ??
        process.env.NEXT_PUBLIC_DEV_TENANT ??
        null;
    }

    if (tenantSlug) {
      requestHeaders.set("x-tenant-slug", tenantSlug);
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
    if (userRole === "superadmin") {
      return NextResponse.redirect(new URL("/superadmin", request.url));
    }
    return NextResponse.redirect(new URL("/admin/dashboard", request.url));
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
