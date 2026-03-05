"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import LogoutButton from "@/components/admin/LogoutButton";

import type { UserRole } from "@/types/database";

interface SidebarProps {
  displayName: string;
  displayEmail: string;
  displayRole: UserRole;
}

interface NavLink {
  href: string;
  labelEn: string;
  labelMm: string;
  emoji: string;
  ownerOnly?: boolean;
}

const NAV_LINKS: NavLink[] = [
  {
    href: "/admin/dashboard",
    labelEn: "Dashboard",
    labelMm: "ဒက်ရှ်ဘုတ်",
    emoji: "📊",
  },
  {
    href: "/admin/intakes",
    labelEn: "Intakes & Classes",
    labelMm: "သင်တန်းများ",
    emoji: "🏫",
  },
  {
    href: "/admin/students",
    labelEn: "Students",
    labelMm: "ကျောင်းသားများ",
    emoji: "👥",
  },
  {
    href: "/admin/analytics",
    labelEn: "Analytics",
    labelMm: "စာရင်းအင်း",
    emoji: "📈",
  },
  {
    href: "/admin/payments",
    labelEn: "Payments",
    labelMm: "ငွေပေးချေမှု",
    emoji: "💳",
  },
  {
    href: "/admin/announcements",
    labelEn: "Announcements",
    labelMm: "ကြေညာချက်",
    emoji: "📢",
  },
  {
    href: "/admin/settings",
    labelEn: "Settings",
    labelMm: "ဆက်တင်",
    emoji: "⚙️",
    ownerOnly: true,
  },
];

export default function Sidebar({ displayName, displayEmail, displayRole }: SidebarProps) {
  const [open, setOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const pathname = usePathname();

  // Fetch pending payment count once on mount
  useEffect(() => {
    fetch("/api/admin/stats")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setPendingCount(data.payment_submitted_count ?? 0);
      })
      .catch(() => {});
  }, []);

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + "/");
  }

  function closeSidebar() {
    setOpen(false);
  }

  const isOwnerOrAbove = displayRole === "owner" || displayRole === "superadmin";
  const visibleLinks = NAV_LINKS.filter(
    (link) => !link.ownerOnly || isOwnerOrAbove,
  );
  const avatarLetter = displayName.charAt(0).toUpperCase();

  return (
    <>
      {/* ── Mobile top bar ─────────────────────────────────── */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-40 flex items-center gap-3 px-4 h-14 bg-[#0f1225] text-white shadow-md">
        <button
          onClick={() => setOpen(true)}
          className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
          aria-label="Open menu"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-red-700 flex items-center justify-center shrink-0">
            <span className="text-white font-bold text-sm select-none">日</span>
          </div>
          <span className="text-sm font-bold">Nihon Moment</span>
        </div>
      </header>

      {/* ── Mobile overlay ─────────────────────────────────── */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      {/* ── Sidebar panel ──────────────────────────────────── */}
      <aside
        className={[
          "fixed inset-y-0 left-0 z-50 w-60 flex flex-col bg-[#0f1225] text-white transition-transform duration-300 ease-in-out",
          "lg:static lg:translate-x-0 lg:w-60 lg:shrink-0",
          open ? "translate-x-0" : "-translate-x-full",
        ].join(" ")}
      >
        {/* School name */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-white/10">
          <div className="w-9 h-9 rounded-lg bg-red-700 flex items-center justify-center shrink-0">
            <span className="text-white font-bold text-base select-none">日</span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-white truncate leading-tight">
              Nihon Moment
            </p>
            <p className="text-xs font-myanmar text-white/50 truncate leading-tight mt-0.5">
              နီဟွန်းမိုးမန့်
            </p>
          </div>
          {/* Close button — mobile only */}
          <button
            onClick={closeSidebar}
            className="ml-auto lg:hidden p-1 rounded hover:bg-white/10 text-white/60 hover:text-white transition-colors"
            aria-label="Close menu"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
          {visibleLinks.map((link) => {
            const active = isActive(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={closeSidebar}
                className={[
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors group",
                  active
                    ? "bg-[#1a3f8a] text-white"
                    : "text-white/60 hover:text-white hover:bg-white/10",
                ].join(" ")}
              >
                <span className="text-base leading-none shrink-0">{link.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{link.labelEn}</span>
                  <span
                    className={[
                      "block truncate text-xs font-myanmar leading-tight mt-0.5",
                      active ? "text-white/70" : "text-white/35 group-hover:text-white/50",
                    ].join(" ")}
                  >
                    {link.labelMm}
                  </span>
                </span>
                {link.href === "/admin/payments" && pendingCount > 0 && (
                  <span className="ml-1 shrink-0 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-[#b07d2a] text-white text-xs font-bold leading-none">
                    {pendingCount > 99 ? "99+" : pendingCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* User + logout */}
        <div className="px-3 py-4 border-t border-white/10 space-y-1">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-8 h-8 rounded-full bg-[#1a3f8a] flex items-center justify-center shrink-0 text-white text-xs font-bold uppercase">
              {avatarLetter}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-white truncate leading-tight">
                {displayName}
              </p>
              <p className="text-xs text-white/40 truncate leading-tight mt-0.5">
                {displayEmail}
              </p>
              <p className="text-xs text-white/30 capitalize leading-tight">
                {displayRole}
              </p>
            </div>
          </div>
          <LogoutButton />
        </div>
      </aside>
    </>
  );
}
