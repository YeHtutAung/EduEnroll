import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import LoginForm from "./LoginForm";

// Tenant slug comes from middleware at request time — never cache this page
export const dynamic = "force-dynamic";

// ─── Extract subdomain from host header (fallback for middleware) ────────────

function extractSubdomainFromHost(host: string): string | null {
  const hostname = host.split(":")[0];
  const parts = hostname.split(".");

  // "nihon-moment.localhost" → "nihon-moment"
  if (parts.length === 2 && parts[1] === "localhost") return parts[0];

  // "nihon-moment.kuunyi.com" → "nihon-moment"
  if (hostname.endsWith(".kuunyi.com")) {
    const sub = parts.slice(0, parts.length - 2).join(".");
    return sub && sub !== "www" ? sub : null;
  }

  // "nihon-moment.edu-enroll-xi.vercel.app" → "nihon-moment"
  if (hostname.endsWith(".vercel.app")) return parts.length >= 4 ? parts[0] : null;

  return parts.length >= 3 ? parts[0] : null;
}

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
