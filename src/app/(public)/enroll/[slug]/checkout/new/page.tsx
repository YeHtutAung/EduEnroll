"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { createTrustedOfficialOrder, currentNavigationType } from "@/lib/enrollment/trustedOfficialCheckout";

// Untracked (under checkout/**): creates the order from the stash left by
// /tickets so that no tracked page ever sees an enrollment ref or its
// idempotency key. Logic lives in lib/enrollment/trustedOfficialCheckout.ts.

function CheckoutNew() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // StrictMode runs effects twice on mount; the POST must go out once per mount.
  const started = useRef(false);

  const slug = params.slug;
  const cartKey = searchParams.get("cart_key");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    createTrustedOfficialOrder({
      slug,
      cartKey,
      navigationType: currentNavigationType(window.performance),
    }).then((result) => {
      // /tickets is tracked: enter it with a full page load, never a soft move.
      if (result.kind === "redirect-tickets") window.location.replace(`/enroll/${slug}/tickets/`);
      else if (result.kind === "created") router.replace(`/enroll/${slug}/checkout/?ref=${result.ref}`);
      else setError(result.message);
    });
  }, [slug, cartKey, router]);

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-5" style={{ background: "#f7f5ef" }}>
        <p className="text-[13px] text-center" style={{ color: "#0f1f42" }}>{error}</p>
        <a href={`/enroll/${slug}/tickets/`} className="text-[12px] underline" style={{ color: "#b7912b" }}>
          Back to tickets
        </a>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "#f7f5ef" }}>
      <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: "#0f1f42", borderTopColor: "transparent" }} />
    </div>
  );
}

export default function CheckoutNewPage() {
  return (
    <Suspense>
      <CheckoutNew />
    </Suspense>
  );
}
