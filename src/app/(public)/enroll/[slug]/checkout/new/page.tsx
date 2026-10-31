"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  currentNavigationType,
  prepareTrustedOfficialOrder,
  submitTrustedOfficialOrder,
  type CheckoutNewResult,
  type OrderAttempt,
} from "@/lib/enrollment/trustedOfficialCheckout";

// Untracked (under checkout/**): creates the order from the stash left by
// /tickets so that no tracked page ever sees an enrollment ref or its
// idempotency key. Logic lives in lib/enrollment/trustedOfficialCheckout.ts.
//
// The attempt (body + idempotency key) is prepared once per document and kept
// in a ref, so "Try again" re-sends the same key and the server can return the
// order a lost response belonged to, instead of holding a second one.

function CheckoutNew() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // StrictMode runs effects twice on mount; the POST must go out once per mount.
  const started = useRef(false);
  const attemptRef = useRef<OrderAttempt | null>(null);
  // One POST in flight at a time: a double click on Try again sends one request.
  const inFlight = useRef(false);

  const slug = params.slug;
  const cartKey = searchParams.get("cart_key");

  const handle = useCallback(
    (result: CheckoutNewResult) => {
      // /tickets is tracked: enter it with a full page load, never a soft move.
      if (result.kind === "redirect-tickets") window.location.replace(`/enroll/${slug}/tickets/`);
      else if (result.kind === "created") router.replace(`/enroll/${slug}/checkout/?ref=${result.ref}`);
      else setError(result.message);
    },
    [slug, router],
  );

  const submit = useCallback(async () => {
    const attempt = attemptRef.current;
    if (!attempt || inFlight.current) return;
    inFlight.current = true;
    setRetrying(true);
    try {
      handle(await submitTrustedOfficialOrder(attempt));
    } finally {
      inFlight.current = false;
      setRetrying(false);
    }
  }, [handle]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const prepared = prepareTrustedOfficialOrder({
      slug,
      cartKey,
      navigationType: currentNavigationType(window.performance),
    });
    if (prepared.kind !== "ready") {
      handle(prepared);
      return;
    }
    attemptRef.current = prepared.attempt;
    void submit();
  }, [slug, cartKey, handle, submit]);

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-5" style={{ background: "#f7f5ef" }}>
        <p className="text-[13px] text-center" style={{ color: "#0f1f42" }}>{error}</p>
        {attemptRef.current && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              void submit();
            }}
            disabled={retrying}
            className="rounded-lg px-5 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
            style={{ background: "#0f1f42" }}
          >
            {retrying ? "Trying again..." : "Try again"}
          </button>
        )}
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
