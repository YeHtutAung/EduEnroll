import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractSubdomainFromHost } from "@/lib/tenant";
import type { User } from "@/types/database";

export interface AuthContext {
  supabase: ReturnType<typeof createClient>;
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
  const supabase = createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: "Unauthorized", message: "Valid session required." },
      { status: 401 },
    );
  }

  const { data: profile } = await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
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
 * Same as requireAuth but also checks that the user is an owner or superadmin.
 * Returns 403 if the user is a staff member.
 */
export async function requireOwner(): Promise<AuthContext | NextResponse> {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  if (auth.user.role !== "owner" && auth.user.role !== "superadmin") {
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
