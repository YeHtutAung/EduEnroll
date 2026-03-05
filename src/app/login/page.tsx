import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import LoginForm from "./LoginForm";

// ─── Server component: resolve tenant name from subdomain ───────────────────

export default async function LoginPage() {
  const headersList = headers();
  const slug = headersList.get("x-tenant-slug");

  let schoolName = "EduEnroll Admin";
  const schoolNameMm: string | null = null;

  if (slug) {
    const supabase = createAdminClient();
    const { data: tenant } = (await supabase
      .from("tenants")
      .select("name")
      .eq("subdomain", slug)
      .maybeSingle()) as { data: { name: string } | null; error: unknown };

    if (tenant?.name) {
      schoolName = tenant.name;
    }
  }

  return <LoginForm schoolName={schoolName} schoolNameMm={schoolNameMm} />;
}
