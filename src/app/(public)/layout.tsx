import { headers } from "next/headers";
import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";

// ─── Server component: resolve tenant name for public pages ─────────────────

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const headersList = headers();
  const slug = headersList.get("x-tenant-slug");

  let schoolName = "KuuNyi";
  const schoolNameMm: string | null = null;
  let logoUrl: string | null = null;

  if (slug) {
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
  }

  return (
    <div className="flex min-h-screen flex-col bg-white">
      {/* ─── Header ──────────────────────────────────────────────── */}
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="flex items-center gap-3">
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="" className="w-10 h-10 rounded-lg object-contain shrink-0" />
            )}
            <span className="flex flex-col">
              <span className="text-xl font-bold text-[#1a6b3c]">{schoolName}</span>
              {schoolNameMm && (
                <span className="font-myanmar text-sm text-[#1a6b3c]">{schoolNameMm}</span>
              )}
            </span>
          </Link>
          <p className="hidden text-right text-xs text-gray-500 sm:block">
            Japanese Language School
            <br />
            <span className="font-myanmar">ဂျပန်ဘာသာ သင်တန်းကျောင်း</span>
          </p>
        </div>
      </header>

      {/* ─── Main ────────────────────────────────────────────────── */}
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6 sm:py-10">
        {children}
      </main>

      {/* ─── Footer ──────────────────────────────────────────────── */}
      <footer className="border-t border-gray-200 bg-gray-50">
        <div className="mx-auto max-w-4xl px-4 py-6 text-center text-sm text-gray-500 sm:px-6">
          <p className="font-semibold text-gray-700">{schoolName}</p>
          <p className="mt-1">
            Powered by{" "}
            <a
              href="https://www.kuunyi.com"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-gray-700"
            >
              KuuNyi
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
