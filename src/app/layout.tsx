import type { Metadata } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractSubdomainFromHost } from "@/lib/tenant";
import { Analytics } from "@vercel/analytics/next";
import { MSWProvider } from "@/components/MSWProvider";
import "./globals.css";

// Self-hosted (src/app/fonts, OFL — see fonts/licenses) so the build never
// fetches from Google Fonts. Files are Google's variable woff2 for the subsets
// these fonts were previously loaded with.
const notoSans = localFont({
  src: "./fonts/NotoSans-latin.woff2",
  variable: "--font-noto-sans",
  weight: "400 700",
});

const notoSansMyanmar = localFont({
  src: "./fonts/NotoSansMyanmar-myanmar.woff2",
  variable: "--font-noto-sans-myanmar",
  weight: "400 700",
});

const jetBrainsMono = localFont({
  src: "./fonts/JetBrainsMono-latin.woff2",
  variable: "--font-jetbrains-mono",
  weight: "400 700",
});

const inter = localFont({
  src: "./fonts/Inter-latin.woff2",
  variable: "--font-inter",
  weight: "400 800",
});

export async function generateMetadata(): Promise<Metadata> {
  const headersList = headers();
  const slug =
    headersList.get("x-tenant-slug") || extractSubdomainFromHost(headersList.get("host") ?? "");

  let tenantName: string | null = null;
  let logoUrl: string | null = null;

  if (slug) {
    const supabase = createAdminClient();
    const { data: tenant } = (await supabase
      .from("tenants")
      .select("name, logo_url")
      .eq("subdomain", slug)
      .maybeSingle()) as {
      data: { name: string; logo_url: string | null } | null;
      error: unknown;
    };

    if (tenant) {
      tenantName = tenant.name;
      logoUrl = tenant.logo_url;
    }
  }

  const title = tenantName ? `${tenantName} — powered by KuuNyi` : "KuuNyi — Enrollment Platform";
  const description = tenantName
    ? `${tenantName} — online enrollment powered by KuuNyi`
    : "KuuNyi enrollment platform for schools, events, and training centers.";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: tenantName ?? "KuuNyi",
      locale: "my_MM",
      type: "website",
      ...(logoUrl ? { images: [{ url: logoUrl }] } : {}),
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="my">
      <body
        className={`${notoSans.variable} ${notoSansMyanmar.variable} ${jetBrainsMono.variable} ${inter.variable} font-sans antialiased`}
      >
        <MSWProvider>{children}</MSWProvider>
        <Analytics />
      </body>
    </html>
  );
}
