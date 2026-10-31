"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Script from "next/script";
import {
  GTM_CONTAINER_ID_RE,
  isBrowserStateClean,
  isTrackedPath,
} from "@/lib/tagManager";

// Loads the tenant's own Google Tag Manager container on tracked pages only.
// The first render is always null (so hydration matches); the guard runs in an
// effect because it reads browser state. It does not unload a running
// container: leaving tracked pages is always a full page load.
// See docs/superpowers/specs/2026-10-30-tenant-gtm-design.md.

export default function TenantTagManager({ containerId }: { containerId: string | null }) {
  const pathname = usePathname();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(
      containerId !== null &&
        GTM_CONTAINER_ID_RE.test(containerId) &&
        isTrackedPath(pathname ?? "") &&
        isBrowserStateClean({
          location: window.location,
          referrer: document.referrer,
          sessionStorage: () => window.sessionStorage,
          localStorage: () => window.localStorage,
          cookie: document.cookie,
        }),
    );
  }, [containerId, pathname]);

  // Re-checked at render so only a regex-checked ID is ever interpolated.
  if (!enabled || containerId === null || !GTM_CONTAINER_ID_RE.test(containerId)) return null;

  return (
    <Script id="tenant-gtm" strategy="afterInteractive">
      {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${containerId}');`}
    </Script>
  );
}
