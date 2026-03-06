import type { Metadata } from "next";
import { Noto_Sans, Noto_Sans_Myanmar, JetBrains_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  title: "KuuNyi — School Enrollment Platform",
  description:
    "KuuNyi enrollment management for Myanmar language schools. " +
    "Bilingual Myanmar + English enrollment system. Pay in MMK.",
  openGraph: {
    title: "KuuNyi — School Enrollment Platform",
    description:
      "KuuNyi enrollment management for Myanmar language schools. " +
      "Easy online enrollment, MMK payment. သင်တန်းကျောင်းများအတွက် စာရင်းသွင်းစနစ်",
    siteName: "KuuNyi",
    locale: "my_MM",
    type: "website",
  },
};

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
