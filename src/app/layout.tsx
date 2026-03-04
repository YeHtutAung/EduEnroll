import type { Metadata } from "next";
import { Noto_Sans, Noto_Sans_Myanmar } from "next/font/google";
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

export const metadata: Metadata = {
  title: "Nihon Moment — Japanese Language School",
  description:
    "Japanese Language School Enrollment System. Built in Myanmar, supports MMK currency and Myanmar + English bilingual interface.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="my">
      <body
        className={`${notoSans.variable} ${notoSansMyanmar.variable} font-sans antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
