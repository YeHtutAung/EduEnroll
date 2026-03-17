import type { Metadata } from "next";
import { headers } from "next/headers";
import { Noto_Sans, Noto_Sans_Myanmar, JetBrains_Mono } from "next/font/google";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractSubdomainFromHost } from "@/lib/tenant";
import "./globals.css";

const notoSans = Noto_Sans({
  subsets: ["latin"],
  variable: "--font-noto-sans",
  weight: ["400", "500", "600", "700"],
});

const notoSansMyanmar = Noto_Sans_Myanmar({
  subsets: ["myanmar"],
  variable: "--font-noto-sans-myanmar",
  weight: ["400", "500", "600", "700"],
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  weight: ["400", "600", "700"],
});

export async function generateMetadata(): Promise<Metadata> {
  const headersList = headers();
  const slug =
    headersList.get("x-tenant-slug") ||
    extractSubdomainFromHost(headersList.get("host") ?? "");

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
        className={`${notoSans.variable} ${notoSansMyanmar.variable} ${jetBrainsMono.variable} font-sans antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
