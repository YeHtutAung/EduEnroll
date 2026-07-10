"use client";

import { Suspense, useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import QRCode from "qrcode";
import TrustedOfficialShell from "@/components/enrollment/TrustedOfficialShell";
import QRPaymentModal from "@/components/payments/QRPaymentModal";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

// ─── Types ────────────────────────────────────────────────────────────────────

interface BankAccount {
  bank_name: string;
  account_number: string;
  account_holder: string;
  qr_code_url: string | null;
}

// ─── Card Payment Form ────────────────────────────────────────────────────────

function CardForm({ slug, enrollmentRef, totalAmount }: { slug: string; enrollmentRef: string; totalAmount: number }) {
  const stripe = useStripe();
  const elements = useElements();
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
  slug, enrollmentRef, piId, totalAmount,
}: { slug: string; enrollmentRef: string; piId: string; totalAmount: number }) {
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

    try {
      const res = await fetch("/api/public/payments/stripe/paynow-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentIntentId: piId, enrollmentRef }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.message ?? "Failed to generate QR. Please try again.");
        setPaying(false);
        return;
      }

      if (data.alreadyPaid) {
        router.push(`/enroll/${slug}/checkout/success/?ref=${enrollmentRef}`);
        return;
      }

      if (data.qrImageUrl) {
        setQrImageUrl(data.qrImageUrl);
        startPolling();
      } else {
        setError("Could not generate PayNow QR. Please try card payment instead.");
      }
    } catch {
      setError("Network error. Please try again.");
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

// ─── Bank Transfer Section ────────────────────────────────────────────────────

function BankTransferSection({
  enrollmentRef, bankAccounts, totalAmount, slug,
}: { enrollmentRef: string; bankAccounts: BankAccount[]; totalAmount: number; slug: string }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (files.length === 0) { setError("Please select a payment screenshot."); return; }
    setUploading(true);
    setError(null);
    const fd = new FormData();
    fd.append("enrollment_ref", enrollmentRef);
    files.forEach((f) => fd.append("proof_image", f));
    try {
      const res = await fetch("/api/public/payments/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const d = await res.json();
        setError(d.message ?? "Upload failed. Please try again.");
        setUploading(false);
        return;
      }
      router.push(`/enroll/${slug}/checkout/success/?ref=${enrollmentRef}`);
    } catch {
      setError("Network error. Please try again.");
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {bankAccounts.length === 0 && (
        <div className="p-3 rounded-[8px] text-[12px] text-center" style={{ background: "#fff5f5", color: "#991b1b", border: "1px solid #fca5a5" }}>
          No bank accounts configured. Please contact the organiser.
        </div>
      )}

      {bankAccounts.map((bank, i) => (
        <div key={i} className="rounded-[10px] p-4" style={{ border: "1px solid #e3e0d6", background: "#fbfaf6" }}>
          <p className="text-[10px] font-bold tracking-[1.2px] uppercase mb-2.5" style={{ color: "#8b8f9a" }}>
            {bank.bank_name}
          </p>
          <div className="flex justify-between text-[12px] mb-1.5">
            <span style={{ color: "#8b8f9a" }}>Account No.</span>
            <span className="font-bold font-mono" style={{ color: "#0f1f42" }}>{bank.account_number}</span>
          </div>
          <div className="flex justify-between text-[12px]">
            <span style={{ color: "#8b8f9a" }}>Account Name</span>
            <span className="font-bold" style={{ color: "#0f1f42" }}>{bank.account_holder}</span>
          </div>
          {bank.qr_code_url && (
            <div className="mt-3 text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={bank.qr_code_url} alt="Bank QR" className="w-[120px] h-[120px] mx-auto rounded-[6px] object-contain" />
            </div>
          )}
        </div>
      ))}

      <div className="rounded-[8px] px-4 py-3 text-center" style={{ background: "#fdf3e0", border: "1px solid #eed9a3" }}>
        <p className="text-[10px] mb-0.5" style={{ color: "#8a6a1f" }}>Transfer exactly</p>
        <p className="text-[18px] font-extrabold" style={{ color: "#8a6a1f" }}>{totalAmount.toLocaleString()}</p>
      </div>

      <div>
        <p className="text-[11px] font-semibold mb-1.5" style={{ color: "#43485a" }}>
          Upload payment screenshot
        </p>
        <label
          className="block w-full rounded-[8px] border-2 border-dashed p-4 text-center cursor-pointer"
          style={{ borderColor: files.length > 0 ? "#0f1f42" : "#d8d5c9" }}
        >
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="hidden"
            onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); setError(null); }}
          />
          {files.length > 0 ? (
            <p className="text-[12px] font-semibold" style={{ color: "#0f1f42" }}>
              {files.length} file{files.length > 1 ? "s" : ""} selected
            </p>
          ) : (
            <p className="text-[12px]" style={{ color: "#8b8f9a" }}>Tap to select screenshot</p>
          )}
        </label>
      </div>

      {error && (
        <div className="p-3 rounded-lg border text-[12px]" style={{ background: "#fff5f5", borderColor: "#fca5a5", color: "#991b1b" }}>
          {error}
        </div>
      )}

      <button
        className="w-full py-3 rounded-[8px] text-[12.5px] font-bold text-white disabled:opacity-60"
        style={{ background: "#0f1f42" }}
        onClick={handleSubmit}
        disabled={uploading || files.length === 0 || bankAccounts.length === 0}
      >
        {uploading ? "Submitting..." : "SUBMIT PAYMENT PROOF"}
      </button>
    </div>
  );
}

// ─── HitPay method row (accordion) ────────────────────────────────────────────

function HitPayMethodRow({
  expanded, onToggle, icon, name, badgeLabel, badgeBg, badgeColor, children,
}: {
  expanded: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  name: string;
  badgeLabel: string;
  badgeBg: string;
  badgeColor: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-[10px] overflow-hidden transition-colors"
      style={{ border: expanded ? "1.5px solid #0f1f42" : "1px solid #e3e0d6", background: "#ffffff" }}
    >
      <button type="button" className="w-full flex items-center gap-3 px-3.5 py-3 text-left" onClick={onToggle}>
        <span className="flex items-center justify-center w-8 h-8 rounded-[8px] shrink-0" style={{ background: "#f5f3ec", color: "#0f1f42" }}>
          {icon}
        </span>
        <span className="flex-1 text-[13px] font-semibold" style={{ color: "#0f1f42" }}>{name}</span>
        <span className="text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full" style={{ background: badgeBg, color: badgeColor }}>
          {badgeLabel}
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8b8f9a" strokeWidth="2"
          style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform .15s" }}>
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {expanded && <div className="px-3.5 pb-3.5 pt-1">{children}</div>}
    </div>
  );
}

// ─── HitPay Section ───────────────────────────────────────────────────────────

function HitPaySection({
  enrollmentRef, totalAmount, slug,
}: { enrollmentRef: string; totalAmount: number; slug: string }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<"paynow" | "card" | null>("paynow");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/public/payments/hitpay/status?ref=${enrollmentRef}`);
        const data = await res.json();
        const status = data.enrollmentStatus;
        if (status === "confirmed") {
          clearInterval(pollRef.current!);
          router.push(`/enroll/${slug}/checkout/success/?ref=${enrollmentRef}`);
        } else if (status === "rejected" || status === "cancelled") {
          clearInterval(pollRef.current!);
          setError("Payment failed. Please try again.");
          setQrDataUrl(null);
        }
      } catch { /* keep polling on network error */ }
    }, 3000);
  }

  async function handlePayNow() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/public/payments/hitpay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrollmentRef, method: "paynow_online" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to generate QR. Please try again.");
        setLoading(false);
        return;
      }
      const dataUrl = await QRCode.toDataURL(data.qrCode, { width: 200, margin: 2 });
      setQrDataUrl(dataUrl);
      startPolling();
    } catch {
      setError("Network error. Please try again.");
    }
    setLoading(false);
  }

  async function handleCard() {
    setLoading(true);
    setError(null);
    try {
      const origin = window.location.origin;
      const redirectUrl = `${origin}/enroll/${slug}/checkout/payment?ref=${encodeURIComponent(enrollmentRef)}&hitpay=success`;
      const res = await fetch("/api/public/payments/hitpay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrollmentRef, method: "card", redirectUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to initiate card payment. Please try again.");
        setLoading(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  function handleCancel() {
    if (pollRef.current) clearInterval(pollRef.current);
    setQrDataUrl(null);
    setError(null);
  }

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[10px] font-bold tracking-[1.4px] uppercase mb-0.5" style={{ color: "#8b8f9a" }}>
        Payment Method
      </p>

      {/* PayNow — embedded QR (customer stays on page) */}
      <HitPayMethodRow
        expanded={expanded === "paynow"}
        onToggle={() => setExpanded((p) => (p === "paynow" ? null : "paynow"))}
        name="PayNow"
        badgeLabel="QR"
        badgeBg="#e7f7ef"
        badgeColor="#1a6b3c"
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <path d="M14 14h3v3M20 14v.01M14 20v.01M20 20v.01M17 17v.01" strokeLinecap="round" />
          </svg>
        }
      >
        {qrDataUrl ? (
          <div className="flex flex-col gap-4">
            <div className="rounded-[10px] p-[18px] text-center" style={{ border: "1px solid #e3e0d6" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrDataUrl} alt="PayNow QR" className="w-[130px] h-[130px] mx-auto mb-2" />
              <p className="text-[10.5px]" style={{ color: "#8b8f9a" }}>Scan with your banking app (PayNow)</p>
              <p className="text-[9.5px]" style={{ color: "#aca795" }}>DBS · OCBC · UOB · and most PayNow banks</p>
            </div>
            <div className="flex items-center justify-between px-3 py-2 rounded-[8px]" style={{ background: "#fdf3e0", border: "1px solid #eed9a3" }}>
              <span className="text-[10.5px]" style={{ color: "#8a6a1f" }}>Waiting for payment</span>
              <span className="text-[10px] flex items-center gap-1.5" style={{ color: "#8a6a1f" }}>
                <span className="w-1.5 h-1.5 rounded-full animate-pulse inline-block" style={{ background: "#8a6a1f" }} />
                Confirming
              </span>
            </div>
            <button
              className="w-full py-2.5 rounded-[8px] text-[11.5px] font-semibold"
              style={{ border: "1px solid #d8d5c9", color: "#43485a" }}
              onClick={handleCancel}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[12px]" style={{ color: "#8b8f9a" }}>
              A PayNow QR code will be generated for {totalAmount.toLocaleString()}.
            </p>
            <button
              className="w-full py-3 rounded-[8px] text-[12.5px] font-bold text-white disabled:opacity-60"
              style={{ background: "#0f1f42" }}
              onClick={handlePayNow}
              disabled={loading}
            >
              {loading ? "Generating QR..." : "Pay via PayNow"}
            </button>
          </div>
        )}
      </HitPayMethodRow>

      {/* Cards — redirect to HitPay hosted checkout */}
      <HitPayMethodRow
        expanded={expanded === "card"}
        onToggle={() => setExpanded((p) => (p === "card" ? null : "card"))}
        name="Cards"
        badgeLabel="Redirect"
        badgeBg="#eef2fb"
        badgeColor="#1a3f8a"
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <path d="M2 10h20" strokeLinecap="round" />
          </svg>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-[12px]" style={{ color: "#8b8f9a" }}>
            You&apos;ll be redirected to HitPay to pay securely by Visa or Mastercard.
          </p>
          <button
            className="w-full py-3 rounded-[8px] text-[12.5px] font-bold text-white disabled:opacity-60"
            style={{ background: "#0f1f42" }}
            onClick={handleCard}
            disabled={loading}
          >
            {loading ? "Redirecting..." : "Pay by Card"}
          </button>
          <p className="text-center text-[9.5px]" style={{ color: "#aca795" }}>
            Powered by <span className="font-bold" style={{ color: "#0f1f42" }}>HitPay</span>
          </p>
        </div>
      </HitPayMethodRow>

      {error && (
        <div className="p-3 rounded-lg border text-[12px]" style={{ background: "#fff5f5", borderColor: "#fca5a5", color: "#991b1b" }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ─── Payment Page ─────────────────────────────────────────────────────────────

function PaymentContent() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const ref = searchParams.get("ref") ?? "";
  const piId = searchParams.get("pi") ?? "";

  const [tab, setTab] = useState<"card" | "paynow">("card");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [totalAmount, setTotalAmount] = useState(0);
  const [orgName, setOrgName] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [brandColor, setBrandColor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paymentMode, setPaymentMode] = useState<string | null>(null);
  const [mmqrProvider, setMmqrProvider] = useState<"abank" | "mmpay">("mmpay");
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [studentName, setStudentName] = useState("");
  const [showQRModal, setShowQRModal] = useState(false);
  const [hitpayReturn, setHitpayReturn] = useState(false);
  const hitpayReturnPollRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (searchParams.get("hitpay") !== "success") return;
    setHitpayReturn(true);
    // Poll enrollment status until confirmed — webhook confirms asynchronously
    hitpayReturnPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/public/payments/hitpay/status?ref=${ref}`);
        const data = await res.json();
        if (data.enrollmentStatus === "confirmed") {
          clearInterval(hitpayReturnPollRef.current!);
          router.push(`/enroll/${params.slug}/checkout/success/?ref=${ref}`);
        }
      } catch { /* keep polling */ }
    }, 3000);
    return () => { if (hitpayReturnPollRef.current) clearInterval(hitpayReturnPollRef.current); };
  }, [searchParams, ref, params.slug, router]);

  useEffect(() => {
    const stored = sessionStorage.getItem(`cs_${ref}`);
    if (stored) setClientSecret(stored);

    fetch(`/api/public/enrollment/${ref}`)
      .then((r) => r.json())
      .then((d) => {
        setTotalAmount(d.total_amount ?? 0);
        setOrgName(d.event_name ?? "");
        setLogoUrl(d.logo_url ?? null);
        setBrandColor(d.brand_color ?? null);
        setStudentName(d.student_name_en ?? "");
        const mode = d.payment_mode ?? "bank_transfer";
        setPaymentMode(mode);
        setMmqrProvider(d.mmqr_provider === "abank" ? "abank" : "mmpay");
        setBankAccounts(d.bank_accounts ?? []);
        if (mode === "stripe") {
          if (!stored && d.stripe_client_secret) setClientSecret(d.stripe_client_secret);
          if (!stored && !d.stripe_client_secret) setLoadError("Payment session not found. Please go back and try again.");
        }
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

  // Wait until we know the payment mode (and clientSecret for Stripe)
  if (!paymentMode || (paymentMode === "stripe" && !clientSecret)) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#f7f5ef" }}>
        <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: "#0f1f42", borderTopColor: "transparent" }} />
      </div>
    );
  }

  const isQRMode = paymentMode === "mmqr" || paymentMode === "paypay";
  const qrProvider = paymentMode === "paypay" ? "paypay" : mmqrProvider;

  return (
    <TrustedOfficialShell orgName={orgName} logoUrl={logoUrl} brandColor={brandColor} step={2}>
      {/* HitPay return banner */}
      {hitpayReturn && (
        <div className="mb-4 p-3 rounded-[8px] text-[12px] text-center" style={{ background: "#fdf3e0", border: "1px solid #eed9a3", color: "#8a6a1f" }}>
          Payment received — confirming your enrollment…
        </div>
      )}

      {/* Total due card */}
      <div className="flex items-center justify-between rounded-[10px] px-4 py-3 mb-5" style={{ border: "1px solid #e3e0d6", background: "#fbfaf6" }}>
        <span className="text-[11.5px]" style={{ color: "#8b8f9a" }}>Total due</span>
        <span className="text-[19px] font-extrabold" style={{ color: "#0f1f42" }}>{totalAmount.toLocaleString()}</span>
      </div>

      {paymentMode === "stripe" && clientSecret ? (
        <>
          {/* Stripe: Card + PayNow method toggle */}
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
              totalAmount={totalAmount}
            />
          )}
        </>
      ) : paymentMode === "bank_transfer" ? (
        <BankTransferSection
          enrollmentRef={ref}
          bankAccounts={bankAccounts}
          totalAmount={totalAmount}
          slug={params.slug}
        />
      ) : paymentMode === "hitpay" ? (
        <HitPaySection enrollmentRef={ref} totalAmount={totalAmount} slug={params.slug} />
      ) : isQRMode ? (
        <>
          <button
            className="w-full py-3 rounded-[8px] text-[12.5px] font-bold text-white"
            style={{ background: "#0f1f42" }}
            onClick={() => setShowQRModal(true)}
          >
            {paymentMode === "paypay" ? "Pay via PayPay" : "Pay via MMQR"}
          </button>
          <p className="text-center text-[9.5px] mt-3" style={{ color: "#aca795" }}>
            A QR code will be generated for {totalAmount.toLocaleString()}
          </p>
          {showQRModal && (
            <QRPaymentModal
              enrollmentRef={ref}
              amount={totalAmount}
              studentName={studentName}
              provider={qrProvider as "abank" | "mmpay" | "paypay"}
              onSuccess={() => router.push(`/enroll/${params.slug}/checkout/success/?ref=${ref}`)}
              onClose={() => setShowQRModal(false)}
            />
          )}
        </>
      ) : null}
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
