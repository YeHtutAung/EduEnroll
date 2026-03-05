"use client";

import Link from "next/link";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      {/* ─── Header ──────────────────────────────────────────────── */}
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="flex flex-col">
            <span className="text-xl font-bold text-[#1a6b3c]">Nihon Moment</span>
            <span className="font-myanmar text-sm text-[#1a6b3c]">နီဟုန်မိုမန့်</span>
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
          <p className="font-semibold text-gray-700">
            Nihon Moment{" "}
            <span className="font-myanmar">နီဟုန်မိုမန့်</span>
          </p>
          <p className="mt-1">Powered by EduEnroll</p>
        </div>
      </footer>
    </div>
  );
}
