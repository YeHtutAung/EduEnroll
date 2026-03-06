import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import LoginForm from "./LoginForm";

// ─── Server component: resolve tenant name from subdomain ───────────────────

export default async function LoginPage() {
  const headersList = headers();
  const slug = headersList.get("x-tenant-slug");

  // No tenant context (root domain) — superadmin-only login
  if (!slug) {
    return <LoginForm schoolName="EduEnroll Admin" schoolNameMm={null} tenantSlug={null} isSuperadminOnly />;
  }

  let schoolName = "EduEnroll Admin";
  const schoolNameMm: string | null = null;
  let logoUrl: string | null = null;

  const supabase = createAdminClient();
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("name, logo_url")
    .eq("subdomain", slug)
    .maybeSingle()) as { data: { name: string; logo_url: string | null } | null; error: unknown };

  if (tenant?.name) {
    schoolName = tenant.name;
  }
  if (tenant?.logo_url) {
    logoUrl = tenant.logo_url;
  }

  return <LoginForm schoolName={schoolName} schoolNameMm={schoolNameMm} tenantSlug={slug} logoUrl={logoUrl} />;
}
