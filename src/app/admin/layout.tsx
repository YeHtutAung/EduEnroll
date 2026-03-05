import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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

  const displayName = profile?.full_name ?? user.email ?? "Admin";
  const displayEmail = user.email ?? "";
  const displayRole = (profile?.role ?? "staff") as UserRole;

  return (
    <RoleProvider role={displayRole}>
      <ToastProvider>
        {/* flex-row: sidebar + content side-by-side on lg+; stacked on mobile */}
        <div className="flex h-screen bg-[#f0f4ff] overflow-hidden">
          <Sidebar
            displayName={displayName}
            displayEmail={displayEmail}
            displayRole={displayRole}
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
