"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { GTM_CONTAINER_ID_RE, hasSensitiveParam, isTrackedPath } from "@/lib/tagManager";
import { AD_CLICK_COOKIE, AD_CLICK_MAX_AGE_SECONDS, nextClickCookie } from "@/lib/conversions/clickData";

// Stores the ad platforms' click IDs for the server-side purchase event.
// Deliberately does not use the full GTM guard: that fails on any unknown storage
// key, so a repeat ad click would lose its IDs, and writing our own cookie loads no
// third-party code. See docs/superpowers/specs/2026-11-02-purchase-conversion-design.md.

export function clickCookieToWrite(args: {
  containerId: string | null;
  pathname: string;
  search: string;
  existing: string | null;
  now: number;
}): string | null {
  if (args.containerId === null || !GTM_CONTAINER_ID_RE.test(args.containerId)) return null;
  if (!isTrackedPath(args.pathname)) return null;
  if (hasSensitiveParam(new URLSearchParams(args.search))) return null;
  return nextClickCookie(args.search, args.existing, args.now);
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const found = document.cookie.split("; ").find((c) => c.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

export default function AdClickCapture({ containerId }: { containerId: string | null }) {
  const pathname = usePathname();

  useEffect(() => {
    const value = clickCookieToWrite({
      containerId,
      pathname: pathname ?? "",
      search: window.location.search,
      existing: readCookie(AD_CLICK_COOKIE),
      now: Date.now(),
    });
    if (!value) return;
    document.cookie = `${AD_CLICK_COOKIE}=${value}; Path=/; Max-Age=${AD_CLICK_MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
  }, [containerId, pathname]);

  return null;
}
