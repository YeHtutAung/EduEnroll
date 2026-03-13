import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractSubdomainFromHost } from "@/lib/tenant";
import LoginForm from "./LoginForm";

// Tenant slug comes from middleware at request time — never cache this page
export const dynamic = "force-dynamic";

// ─── Server component: resolve tenant name from subdomain ───────────────────

export default async function LoginPage() {
  const headersList = headers();
  // Prefer middleware header, fall back to extracting from host directly
  const slug =
    headersList.get("x-tenant-slug") ||
    extractSubdomainFromHost(headersList.get("host") ?? "");

  // No tenant context (root domain) — superadmin-only login
  if (!slug) {
    return <LoginForm schoolName="KuuNyi Admin" schoolNameMm={null} tenantSlug={null} isSuperadminOnly />;
  }

  let schoolName = "KuuNyi Admin";
  const schoolNameMm: string | null = null;
  let logoUrl: string | null = null;

  const supabase = createAdminClient();
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("name, logo_url, org_type")
    .eq("subdomain", slug)
    .maybeSingle()) as { data: { name: string; logo_url: string | null; org_type: string | null } | null; error: unknown };

  if (tenant?.name) {
    schoolName = tenant.name;
  }
  if (tenant?.logo_url) {
    logoUrl = tenant.logo_url;
  }

  return <LoginForm schoolName={schoolName} schoolNameMm={schoolNameMm} tenantSlug={slug} logoUrl={logoUrl} orgType={tenant?.org_type ?? "language_school"} />;
}
