import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import Sidebar from "@/components/admin/Sidebar";
import { RoleProvider } from "@/components/admin/RoleContext";
import { ToastProvider } from "@/components/ui/Toast";
import type { User, UserRole } from "@/types/database";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = (await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single()) as { data: User | null; error: unknown };

  if (!profile) {
    redirect("/login");
  }

  // ── Tenant membership guard ────────────────────────────────────────────────
  // Ensure the logged-in user belongs to the tenant identified by the subdomain.
  // Prevents cross-tenant admin access (e.g. Nihon Moment admin on IGM's portal).
  const headersList = headers();
  const tenantSlug = headersList.get("x-tenant-slug");

  if (tenantSlug && profile.role !== "superadmin") {
    const adminSupabase = createAdminClient();
    const { data: tenant } = (await adminSupabase
      .from("tenants")
      .select("id")
      .eq("subdomain", tenantSlug)
      .maybeSingle()) as { data: { id: string } | null; error: unknown };

    if (tenant && profile.tenant_id !== tenant.id) {
      // User doesn't belong to this school — sign out and redirect
      await supabase.auth.signOut();
      redirect("/login");
    }
  }

  const displayName = profile.full_name ?? user.email ?? "Admin";
  const displayEmail = user.email ?? "";
  const displayRole = (profile.role ?? "staff") as UserRole;

  // Fetch tenant name for sidebar branding
  let schoolName = "EduEnroll";
  if (profile.tenant_id) {
    const { data: tenant } = (await supabase
      .from("tenants")
      .select("name")
      .eq("id", profile.tenant_id)
      .single()) as { data: { name: string } | null; error: unknown };
    if (tenant?.name) schoolName = tenant.name;
  }

  return (
    <RoleProvider role={displayRole}>
      <ToastProvider>
        {/* flex-row: sidebar + content side-by-side on lg+; stacked on mobile */}
        <div className="flex h-screen bg-[#f0f4ff] overflow-hidden">
          <Sidebar
            displayName={displayName}
            displayEmail={displayEmail}
            displayRole={displayRole}
            schoolName={schoolName}
          />

          {/* Main content — push down on mobile to clear the fixed top bar */}
          <main className="flex-1 overflow-y-auto pt-14 lg:pt-0">
            {children}
          </main>
        </div>
      </ToastProvider>
    </RoleProvider>
  );
}
