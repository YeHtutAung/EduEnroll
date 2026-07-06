"use client";

import { Suspense, useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import TrustedOfficialShell from "@/components/enrollment/TrustedOfficialShell";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

// ─── Card Payment Form ────────────────────────────────────────────────────────

function CardForm({ slug, enrollmentRef, totalAmount }: { slug: string; enrollmentRef: string; totalAmount: number }) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePay(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setPaying(true);
    setError(null);

    const origin = window.location.origin;
    const { error: stripeError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${origin}/enroll/${slug}/checkout/success/?ref=${enrollmentRef}`,
      },
    });

    if (stripeError) {
      setError(stripeError.message ?? "Payment failed. Please try again.");
      setPaying(false);
    }
    // On success, Stripe redirects to return_url — no manual redirect needed
  }

  return (
    <form onSubmit={handlePay} className="flex flex-col gap-4">
      <PaymentElement />
      {error && (
        <div className="p-3 rounded-lg border text-[12px]" style={{ background: "#fff5f5", borderColor: "#fca5a5", color: "#991b1b" }}>
          {error}
        </div>
      )}
      <button
        type="submit"
        className="w-full py-3 rounded-[8px] text-[12.5px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        style={{ background: "#0f1f42" }}
        disabled={paying || !stripe}
      >
        {paying ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-4 h-4 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(255,255,255,.3)", borderTopColor: "#fff" }} />
            Processing...
          </span>
        ) : (
          `PAY ${totalAmount.toLocaleString()}`
        )}
      </button>
      <p className="text-center text-[9.5px]" style={{ color: "#aca795" }}>
        Secured by <span className="font-bold" style={{ color: "#635bff" }}>stripe</span>
      </p>
    </form>
  );
}

// ─── PayNow Tab ───────────────────────────────────────────────────────────────

function PayNowTab({
  slug, enrollmentRef, piId, clientSecret, totalAmount,
}: { slug: string; enrollmentRef: string; piId: string; clientSecret: string; totalAmount: number }) {
  const router = useRouter();
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(600);
  const [expired, setExpired] = useState(false);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/public/payments/stripe/intent/status?pi=${piId}`);
        const { status } = await res.json();
        if (status === "succeeded") {
          clearInterval(pollRef.current!);
          router.push(`/enroll/${slug}/checkout/success/?ref=${enrollmentRef}`);
        } else if (status === "cancelled") {
          clearInterval(pollRef.current!);
          setError("Payment expired. Please return to the event page and try again.");
        }
      } catch { /* network error — keep polling */ }
    }, 3000);
  }, [piId, slug, enrollmentRef, router]);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    if (!qrImageUrl || expired) return;
    const t = setInterval(() => {
      setSeconds((s) => {
        if (s <= 1) { clearInterval(t); setExpired(true); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [qrImageUrl, expired]);

  async function handleGenerateQR() {
    setPaying(true);
    setError(null);
    setExpired(false);
    setSeconds(600);

    const stripe = await stripePromise;
    if (!stripe) { setError("Stripe not loaded."); setPaying(false); return; }

    const { paymentIntent, error: stripeError } = await stripe.confirmPayment({
      clientSecret,
      confirmParams: {
        return_url: `${window.location.origin}/enroll/${slug}/checkout/success/?ref=${enrollmentRef}`,
      },
      redirect: "if_required",
    });

    if (stripeError) {
      setError(stripeError.message ?? "Failed to generate QR. Please try again.");
      setPaying(false);
      return;
    }

    const qrData = (paymentIntent?.next_action as unknown as { paynow_display_qr_code?: { image_url_svg?: string } } | null)
      ?.paynow_display_qr_code;

    if (qrData?.image_url_svg) {
      setQrImageUrl(qrData.image_url_svg);
      startPolling();
    } else {
      setError("Could not generate PayNow QR. Please try card payment instead.");
    }
    setPaying(false);
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  if (qrImageUrl && !expired) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-[10px] p-[18px] text-center" style={{ border: "1px solid #e3e0d6" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrImageUrl} alt="PayNow QR" className="w-[130px] h-[130px] mx-auto mb-2" />
          <p className="text-[10.5px]" style={{ color: "#8b8f9a" }}>Scan with your banking app</p>
          <p className="text-[9.5px]" style={{ color: "#aca795" }}>DBS · OCBC · UOB · and most PayNow banks</p>
        </div>
        <div className="flex items-center justify-between px-3 py-2 rounded-[8px]" style={{ background: "#fdf3e0", border: "1px solid #eed9a3" }}>
          <span className="text-[10.5px]" style={{ color: "#8a6a1f" }}>Waiting for payment</span>
          <span className="text-[11.5px] font-extrabold" style={{ color: "#8a6a1f" }}>{mm}:{ss}</span>
        </div>
        {error && (
          <div className="p-3 rounded-lg border text-[12px]" style={{ background: "#fff5f5", borderColor: "#fca5a5", color: "#991b1b" }}>{error}</div>
        )}
        <p className="text-center text-[9.5px]" style={{ color: "#aca795" }}>
          Secured by <span className="font-bold" style={{ color: "#635bff" }}>stripe</span>
        </p>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="flex flex-col gap-4 items-center text-center">
        <p className="text-[13px] font-semibold" style={{ color: "#0f1f42" }}>QR code expired</p>
        <p className="text-[11px]" style={{ color: "#8b8f9a" }}>Generate a new one to continue.</p>
        <button
          className="w-full py-3 rounded-[8px] text-[12.5px] font-bold text-white"
          style={{ background: "#0f1f42" }}
          onClick={handleGenerateQR}
        >
          Generate New QR
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] text-center" style={{ color: "#8b8f9a" }}>
        A PayNow QR code will be generated for {totalAmount.toLocaleString()}.
      </p>
      {error && (
        <div className="p-3 rounded-lg border text-[12px]" style={{ background: "#fff5f5", borderColor: "#fca5a5", color: "#991b1b" }}>{error}</div>
      )}
      <button
        className="w-full py-3 rounded-[8px] text-[12.5px] font-bold text-white disabled:opacity-60"
        style={{ background: "#0f1f42" }}
        onClick={handleGenerateQR}
        disabled={paying}
      >
        {paying ? "Generating QR..." : "Pay via PayNow"}
      </button>
      <p className="text-center text-[9.5px]" style={{ color: "#aca795" }}>
        Secured by <span className="font-bold" style={{ color: "#635bff" }}>stripe</span>
      </p>
    </div>
  );
}

// ─── Payment Page ─────────────────────────────────────────────────────────────

function PaymentContent() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const ref = searchParams.get("ref") ?? "";
  const piId = searchParams.get("pi") ?? "";

  const [tab, setTab] = useState<"card" | "paynow">("card");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [totalAmount, setTotalAmount] = useState(0);
  const [orgName, setOrgName] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem(`cs_${ref}`);
    if (stored) setClientSecret(stored);

    fetch(`/api/public/enrollment/${ref}`)
      .then((r) => r.json())
      .then((d) => {
        setTotalAmount(d.total_amount ?? 0);
        setOrgName(d.event_name ?? "");
        if (!stored && d.stripe_client_secret) setClientSecret(d.stripe_client_secret);
        if (!stored && !d.stripe_client_secret) setLoadError("Payment session not found. Please go back and try again.");
      })
      .catch(() => setLoadError("Failed to load payment details."));
  }, [ref]);

  if (loadError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-5" style={{ background: "#f7f5ef" }}>
        <p className="text-[13px]" style={{ color: "#0f1f42" }}>{loadError}</p>
        <a href={`/enroll/${params.slug}/tickets/`} className="text-[12px] underline" style={{ color: "#b7912b" }}>
          Return to event page
        </a>
      </div>
    );
  }

  if (!clientSecret) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#f7f5ef" }}>
        <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: "#0f1f42", borderTopColor: "transparent" }} />
      </div>
    );
  }

  return (
    <TrustedOfficialShell orgName={orgName} step={2}>
      {/* Total due card */}
      <div className="flex items-center justify-between rounded-[10px] px-4 py-3 mb-5" style={{ border: "1px solid #e3e0d6", background: "#fbfaf6" }}>
        <span className="text-[11.5px]" style={{ color: "#8b8f9a" }}>Total due</span>
        <span className="text-[19px] font-extrabold" style={{ color: "#0f1f42" }}>{totalAmount.toLocaleString()}</span>
      </div>

      {/* Method toggle */}
      <div className="flex rounded-[7px] overflow-hidden mb-5" style={{ border: "1.5px solid #d8d5c9" }}>
        {(["card", "paynow"] as const).map((t) => (
          <button
            key={t}
            className="flex-1 py-2 text-[11px] font-bold uppercase tracking-wide transition-colors"
            style={{
              background: tab === t ? "#0f1f42" : "transparent",
              color: tab === t ? "#ffffff" : "#43485a",
            }}
            onClick={() => setTab(t)}
          >
            {t === "card" ? "CARD" : "PAYNOW"}
          </button>
        ))}
      </div>

      {tab === "card" ? (
        <Elements stripe={stripePromise} options={{ clientSecret }}>
          <CardForm slug={params.slug} enrollmentRef={ref} totalAmount={totalAmount} />
        </Elements>
      ) : (
        <PayNowTab
          slug={params.slug}
          enrollmentRef={ref}
          piId={piId}
          clientSecret={clientSecret}
          totalAmount={totalAmount}
        />
      )}
    </TrustedOfficialShell>
  );
}

export default function PaymentPage() {
  return (
    <Suspense>
      <PaymentContent />
    </Suspense>
  );
}
