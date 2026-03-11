import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractSubdomainFromHost } from "@/lib/tenant";
import type { User } from "@/types/database";

export interface AuthContext {
  supabase: ReturnType<typeof createClient> | ReturnType<typeof createAdminClient>;
  user: User;
  tenantId: string;
}

/**
 * Validates the Supabase session and resolves the caller's tenant.
 * Returns an AuthContext on success, or a 401 NextResponse on failure.
 * Usage in a route handler:
 *
 *   const auth = await requireAuth();
 *   if (auth instanceof NextResponse) return auth;
 */
export async function requireAuth(): Promise<AuthContext | NextResponse> {
  const headersList = headers();
  const authHeader = headersList.get("authorization");

  let supabase: ReturnType<typeof createClient> | ReturnType<typeof createAdminClient>;
  let authUser: { id: string } | null = null;

  if (authHeader?.startsWith("Bearer ")) {
    // Bearer token auth (API clients, CI) — use admin client so queries work
    // without cookie-based RLS session. Tenant isolation is enforced via tenantId.
    const token = authHeader.substring(7);
    const adminClient = createAdminClient();
    const { data, error } = await adminClient.auth.getUser(token);
    if (!error && data.user) {
      authUser = data.user;
    }
    supabase = adminClient;
  } else {
    // Cookie-based auth (browser)
    supabase = createClient();
    const { data, error } = await supabase.auth.getUser();
    if (!error && data.user) {
      authUser = data.user;
    }
  }

  if (!authUser) {
    return NextResponse.json(
      { error: "Unauthorized", message: "Valid session required." },
      { status: 401 },
    );
  }

  const { data: profile } = await supabase
    .from("users")
    .select("*")
    .eq("id", authUser.id)
    .single() as { data: User | null; error: unknown };

  if (!profile) {
    return NextResponse.json(
      { error: "Forbidden", message: "User profile not found in tenant." },
      { status: 403 },
    );
  }

  return { supabase, user: profile, tenantId: profile.tenant_id };
}

/**
 * Resolves tenant_id from the x-tenant-slug header injected by middleware.
 * For public API routes that don't require auth but need tenant scoping.
 * Returns the tenant_id string, or a 400/404 NextResponse on failure.
 */
export async function resolveTenantId(): Promise<string | NextResponse> {
  const headersList = headers();
  const slug =
    headersList.get("x-tenant-slug") ||
    extractSubdomainFromHost(headersList.get("host") ?? "");

  if (!slug) {
    return NextResponse.json(
      { error: "Bad Request", message: "Tenant could not be determined." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("tenants")
    .select("id")
    .eq("subdomain", slug)
    .maybeSingle() as { data: { id: string } | null; error: unknown };

  if (error || !data) {
    return NextResponse.json(
      { error: "Not Found", message: "School not found." },
      { status: 404 },
    );
  }

  return data.id;
}

/**
 * Same as requireAuth but restricted to tenant owners only.
 * Returns 403 for all other roles including superadmin.
 */
export async function requireOwner(): Promise<AuthContext | NextResponse> {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  if (auth.user.role !== "owner") {
    return NextResponse.json(
      { error: "Forbidden", message: "Owner access required." },
      { status: 403 },
    );
  }

  return auth;
}

/** Convenience: 400 with a message */
export function badRequest(message: string) {
  return NextResponse.json({ error: "Bad Request", message }, { status: 400 });
}

/** Convenience: 404 */
export function notFound(resource = "Resource") {
  return NextResponse.json(
    { error: "Not Found", message: `${resource} not found.` },
    { status: 404 },
  );
}
