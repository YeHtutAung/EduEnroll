"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/settings", label: "General", labelMm: "အထွေထွေ" },
  { href: "/admin/settings/staff", label: "Staff", labelMm: "ဝန်ထမ်းများ" },
  { href: "/admin/settings/billing", label: "Billing", labelMm: "ငွေတောင်းခံခြင်း" },
] as const;

export default function SettingsTabs() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 bg-white rounded-lg border border-gray-200 p-1 w-fit">
      {TABS.map((tab) => {
        const isActive = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={[
              "px-4 py-2 rounded-md text-sm font-medium transition-colors",
              isActive
                ? "bg-[#1a3f8a] text-white"
                : "text-gray-600 hover:bg-gray-100",
            ].join(" ")}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
