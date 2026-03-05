import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { User } from "@/types/database";

export default async function SuperadminLayout({
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

  if (!profile || profile.role !== "superadmin") {
    redirect("/admin/dashboard");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="bg-[#4c1d95] text-white">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
              <span className="text-white font-bold text-sm">SA</span>
            </div>
            <div>
              <h1 className="text-base font-bold">EduEnroll Super Admin</h1>
              <p className="text-xs text-white/60">Platform Management</p>
            </div>
          </div>
          <p className="text-sm text-white/70">{user.email}</p>
        </div>
      </header>
      {children}
    </div>
  );
}
