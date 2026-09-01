"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import QRCode from "qrcode";
import { formatCurrencySimple } from "@/lib/utils";
import MmqrCard from "@/components/payments/MmqrCard";

// ─── Types ────────────────────────────────────────────────────────────────────

type QRProvider = "mmpay" | "abank" | "paypay" | "kbzpay";

// ─── Creation-response interpretation ───────────────────────────────────────
// Exported and pure so the decision can be tested without a DOM (this project
// has no jsdom; component tests use renderToStaticMarkup and cannot run
// effects).
//
// KBZPay's creation route has TWO success shapes, discriminated by `status`
// (spec §5.1a). The already_paid one carries no qr and no orderId, and it MUST
// be recognised before anything reads data.qr: treating it as a QR response
// sets qrData/orderId to undefined, renders an empty QR panel, and then polls
// /status?ref=undefined every 5s for 10 minutes before declaring the code
// expired — showing a blank code, then an expiry error, to a student who has
// already paid.
//
// ABank, MMPay and PayPay never send `status`, so they fall through unchanged.
export type CreateResponse =
  | { kind: "already_paid" }
  | { kind: "qr"; qrSource: string; orderId: string };

export function interpretCreateResponse(data: {
  status?: string;
  qr?: string;
  url?: string;
  orderId?: string;
}): CreateResponse | null {
  if (data?.status === "already_paid") return { kind: "already_paid" };

  const qrSource = data?.qr ?? data?.url;
  if (!qrSource || !data?.orderId) return null;

  return { kind: "qr", qrSource, orderId: data.orderId };
}

interface QRPaymentModalProps {
  enrollmentRef: string;
  amount: number;
  currency?: string;
  studentName: string;
  /**
   * Who receives the money — the merchant, never the payer. Required because
   * MyanmarPay's brand guideline puts the receiver on the card, and defaulting
   * it would risk quietly printing the student's name in that slot.
   */
  receiverName: string;
  onSuccess: () => void;
  onClose: () => void;
  provider?: QRProvider;
}

type ModalState = "loading" | "qr" | "success" | "error";

// ─── Component ────────────────────────────────────────────────────────────────

export default function QRPaymentModal({
  enrollmentRef,
  amount,
  currency = "MMK",
  studentName,
  receiverName,
  onSuccess,
  onClose,
  provider = "mmpay",
}: QRPaymentModalProps) {
  const apiBase =
    provider === "abank" ? "/api/public/payments/abank"
    : provider === "paypay" ? "/api/public/payments/paypay"
    : provider === "kbzpay" ? "/api/public/payments/kbzpay"
    : "/api/public/payments/mmpay";
  const [state, setState] = useState<ModalState>("loading");
  const [qrData, setQrData] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [paypayUrl, setPaypayUrl] = useState<string | null>(null);
  const [paypayDeeplink, setPaypayDeeplink] = useState<string | null>(null);

  // ── Close on Escape ────────────────────────────────────────
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // ── Cleanup polling + timers on unmount ────────────────────
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    };
  }, []);

  // ── Smart polling: 5s for 2min → 15s until 10min → stop ────

  const startPolling = useCallback(
    (paymentRef: string) => {
      const pollFn = async () => {
        try {
          const res = await fetch(
            `${apiBase}/status?ref=${encodeURIComponent(paymentRef)}`,
          );
          if (!res.ok) return;
          const data = await res.json();

          // PayPay returns paypay_status, MMQR returns mmqr_status
          const status = data.paypay_status ?? data.mmqr_status;

          if (status === "SUCCESS" || status === "COMPLETED") {
            if (pollRef.current) clearInterval(pollRef.current);
            if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
            if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
            setState("success");
            onSuccess();
          } else if (status === "FAILED" || status === "CANCELED" || status === "EXPIRED") {
            if (pollRef.current) clearInterval(pollRef.current);
            if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
            if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
            setState("error");
            setErrorMsg(
              status === "EXPIRED"
                ? "Payment has expired. Please try again."
                : "Payment was declined. Please try again.",
            );
          }
        } catch {
          // Ignore polling errors — will retry next interval
        }
      };

      // Phase 1: poll every 5s
      pollRef.current = setInterval(pollFn, 5000);

      // Phase 2: after 2 min, slow down to 15s
      slowTimerRef.current = setTimeout(() => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(pollFn, 15000);
      }, 2 * 60 * 1000);

      // Phase 3: after 10 min, stop and show expiry
      pollTimerRef.current = setTimeout(() => {
        if (pollRef.current) clearInterval(pollRef.current);
        if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
        setState("error");
        setErrorMsg("QR code has expired. Please try again.");
      }, 10 * 60 * 1000);
    },
    [onSuccess, apiBase],
  );

  // ── Create payment on mount ────────────────────────────────
  useEffect(() => {
    async function createPayment() {
      setState("loading");
      try {
        const res = await fetch(apiBase, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enrollmentRef }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setErrorMsg(body.message || "Failed to generate QR code.");
          setState("error");
          return;
        }

        const data = await res.json();
        console.log("[QRPaymentModal] API response:", data);

        const interpreted = interpretCreateResponse(data);

        // The previous order turned out to be paid (spec §5.1a). Show success
        // and start NO poller — there is no order to poll for.
        if (interpreted?.kind === "already_paid") {
          setState("success");
          onSuccess();
          return;
        }

        if (!interpreted) {
          setErrorMsg("Failed to generate QR code.");
          setState("error");
          return;
        }

        // PayPay returns a URL, MMQR returns a QR string
        const qrSource = interpreted.qrSource;
        setQrData(qrSource);
        setOrderId(interpreted.orderId);

        // Generate QR image from either EMVCo string or PayPay URL
        if (qrSource) {
          try {
            const dataUrl = await QRCode.toDataURL(qrSource, { width: 280, margin: 2 });
            setQrImageUrl(dataUrl);
          } catch {
            console.error("[QRPaymentModal] QR render failed");
          }
        }

        // Store PayPay-specific URLs for direct-open button
        if (data.url) setPaypayUrl(data.url);
        if (data.deeplink) setPaypayDeeplink(data.deeplink);

        setState("qr");
        startPolling(interpreted.orderId);
      } catch {
        setErrorMsg("Network error. Please check your connection.");
        setState("error");
      }
    }

    createPayment();
    // onSuccess is listed because the already_paid branch calls it directly.
    // This does not change when the effect re-runs: startPolling is already a
    // dependency and is itself a useCallback over [onSuccess, apiBase], so an
    // unstable onSuccess already re-triggered this effect through it.
  }, [enrollmentRef, startPolling, apiBase, onSuccess]);

  function handleRetry() {
    if (pollRef.current) clearInterval(pollRef.current);
    setQrData(null);
    setOrderId(null);
    setErrorMsg("");
    setState("loading");

    // Re-trigger by re-mounting effect — force with key change
    // Instead, just call createPayment inline
    (async () => {
      try {
        const res = await fetch(apiBase, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enrollmentRef }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setErrorMsg(body.message || "Failed to generate QR code.");
          setState("error");
          return;
        }

        const data = await res.json();
        const interpreted = interpretCreateResponse(data);

        // Same already-paid branch as the mount effect. Retry is a second
        // entry point into the identical decision, and omitting it here would
        // leave the blank-QR-then-expiry path alive for anyone who pressed
        // "Try again" (spec §5.1a).
        if (interpreted?.kind === "already_paid") {
          setState("success");
          onSuccess();
          return;
        }

        if (!interpreted) {
          setErrorMsg("Failed to generate QR code.");
          setState("error");
          return;
        }

        const qrSource = interpreted.qrSource;
        setQrData(qrSource);
        setOrderId(interpreted.orderId);
        if (qrSource) {
          try {
            const dataUrl = await QRCode.toDataURL(qrSource, { width: 280, margin: 2 });
            setQrImageUrl(dataUrl);
          } catch {
            console.error("[QRPaymentModal] QR render failed");
          }
        }
        if (data.url) setPaypayUrl(data.url);
        if (data.deeplink) setPaypayDeeplink(data.deeplink);
        setState("qr");
        startPolling(interpreted.orderId);
      } catch {
        setErrorMsg("Network error. Please check your connection.");
        setState("error");
      }
    })();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      {/* max-h + scroll: the panel is vertically centred in a fixed shell, so
          without them a panel taller than the viewport is clipped at BOTH ends
          and the close button, Save QR and the reference all become
          unreachable. The MMQR card is roughly twice the height of the bare QR
          it replaced, which turns that latent bug into a routine one on short
          phones. */}
      <div className="relative max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          aria-label="Close"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* ── Loading state ─────────────────────────────────── */}
        {state === "loading" && (
          <div className="flex flex-col items-center py-8">
            <svg className="mb-4 h-10 w-10 animate-spin text-[#1a6b3c]" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="text-sm font-medium text-gray-700">Generating QR code...</p>
            <p className="font-myanmar mt-1 text-xs text-gray-500">QR ကုဒ် ထုတ်ယူနေသည်...</p>
          </div>
        )}

        {/* ── QR state ──────────────────────────────────────── */}
        {state === "qr" && (
          <div className="flex flex-col items-center">
            {/* PayPay is not an MMQR scheme, so it keeps its own presentation.
                Everything else is an MMQR code and must be shown in the card
                layout MyanmarPay's Digital & POS brand guideline specifies —
                see MmqrCard, which carries the figures. */}
            {provider === "paypay" ? (
              <>
                <div className="mb-2 flex h-14 items-center justify-center">
                  <span className="text-3xl font-bold text-[#ff0033]">PayPay</span>
                </div>
                <h3 className="text-lg font-semibold text-gray-900">Pay with PayPay</h3>

                {/* Amount */}
                <div className="mt-3 rounded-lg bg-gray-50 px-4 py-2 text-center">
                  <p className="text-xs text-gray-500">Amount / <span className="font-myanmar">ပမာဏ</span></p>
                  <p className="text-xl font-bold text-gray-900">{formatCurrencySimple(amount, currency)}</p>
                </div>

                {/* Student name */}
                <p className="mt-2 text-xs text-gray-500">{studentName}</p>

                {/* QR Image */}
                {qrImageUrl ? (
                  <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={qrImageUrl}
                      alt="PayPay Payment Code"
                      className="h-56 w-56 object-contain"
                    />
                  </div>
                ) : qrData ? (
                  <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3">
                    <p className="text-xs text-gray-500 text-center">Rendering QR...</p>
                  </div>
                ) : (
                  <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-6 text-center">
                    <p className="text-sm text-amber-800">QR code not available from payment gateway.</p>
                    <p className="font-myanmar mt-1 text-xs text-amber-700">QR ကုဒ် မရရှိနိုင်သေးပါ။</p>
                  </div>
                )}
              </>
            ) : qrImageUrl || qrData ? (
              <>
                <MmqrCard
                  qrImageUrl={qrImageUrl}
                  receiverName={receiverName}
                  amount={amount}
                  currency={currency}
                />

                {/* The payer, kept outside the card: the guideline's card shows
                    the RECEIVER, and adding a second name inside it would
                    misrepresent who is being paid. */}
                <p className="mt-2 text-xs text-gray-500">{studentName}</p>
              </>
            ) : (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-6 text-center">
                <p className="text-sm text-amber-800">QR code not available from payment gateway.</p>
                <p className="font-myanmar mt-1 text-xs text-amber-700">QR ကုဒ် မရရှိနိုင်သေးပါ။</p>
              </div>
            )}

            {/* Save QR button */}
            {qrImageUrl && (
              <button
                onClick={async () => {
                  const fileName = `MMQR-${orderId ?? "payment"}.png`;
                  const byteString = atob(qrImageUrl.split(",")[1]);
                  const ab = new ArrayBuffer(byteString.length);
                  const ia = new Uint8Array(ab);
                  for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
                  const blob = new Blob([ab], { type: "image/png" });
                  const file = new File([blob], fileName, { type: "image/png" });

                  // Mobile: use Web Share API (triggers native share sheet → Save to Photos)
                  if (navigator.share) {
                    try {
                      if (navigator.canShare?.({ files: [file] })) {
                        await navigator.share({ files: [file], title: "MMQR Payment Code" });
                        return;
                      }
                    } catch {
                      // User cancelled or share failed — fall through to download
                    }
                  }

                  // Desktop fallback: blob download
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = fileName;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }}
                className="mt-3 flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Save QR / <span className="font-myanmar">QR သိမ်းမည်</span>
              </button>
            )}

            {/* Open in PayPay app (mobile) */}
            {provider === "paypay" && paypayUrl && (
              <a
                href={paypayDeeplink || paypayUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-[#ff0033] px-4 py-3 text-sm font-semibold text-white hover:bg-[#e6002e] transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Open in PayPay App
              </a>
            )}

            {/* Instructions — provider-specific */}
            {provider === "paypay" ? (
              <div className="mt-4 w-full rounded-lg bg-red-50 border border-red-200 px-4 py-3">
                <div className="flex items-start gap-2">
                  <svg className="mt-0.5 h-4 w-4 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                  </svg>
                  <div>
                    <p className="text-xs font-medium text-red-800">
                      Scan with the <span className="font-semibold">PayPay</span> app, or tap &quot;Open in PayPay App&quot; below
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-4 w-full rounded-lg bg-blue-50 border border-blue-200 px-4 py-3">
                <div className="flex items-start gap-2">
                  <svg className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                  </svg>
                  <div>
                    <p className="text-xs font-medium text-blue-800">
                      Scan with <span className="font-semibold">KBZPay</span>, <span className="font-semibold">Wave</span>, <span className="font-semibold">CB Pay</span>, <span className="font-semibold">A+ wallet</span> or any MMQR-supported app
                    </p>
                    <p className="font-myanmar mt-1 text-xs text-blue-600">
                      KBZPay, Wave, CB Pay, A+ wallet သို့မဟုတ် MMQR ပံ့ပိုးသော app ဖြင့် စကင်ဖတ်ပါ
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Order reference */}
            {orderId && (
              <div className="mt-3 w-full rounded-lg bg-gray-50 px-3 py-2 text-center">
                <p className="text-[10px] uppercase tracking-wider text-gray-400">Reference</p>
                <p className="font-mono text-xs font-medium text-gray-600">{orderId}</p>
              </div>
            )}

            {/* Polling indicator */}
            <div className="mt-4 flex items-center gap-2 text-xs text-gray-400">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#1a6b3c] opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#1a6b3c]" />
              </span>
              Waiting for payment...
            </div>
          </div>
        )}

        {/* ── Success state ─────────────────────────────────── */}
        {state === "success" && (
          <div className="flex flex-col items-center py-4">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
              <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-green-800">Payment Successful!</h3>
            <p className="font-myanmar mt-1 text-sm text-green-700">ငွေပေးချေမှု အောင်မြင်ပါပြီ</p>
            <p className="mt-2 text-sm text-gray-600">{formatCurrencySimple(amount, currency)}</p>
            <button
              onClick={onClose}
              className="mt-6 w-full rounded-lg bg-[#1a6b3c] py-3 text-sm font-semibold text-white hover:bg-[#155d33] transition-colors"
            >
              Done / <span className="font-myanmar">ပြီးပါပြီ</span>
            </button>
          </div>
        )}

        {/* ── Error state ───────────────────────────────────── */}
        {state === "error" && (
          <div className="flex flex-col items-center py-4">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-50">
              <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900">Payment Failed</h3>
            <p className="font-myanmar mt-1 text-sm text-gray-500">ငွေပေးချေမှု မအောင်မြင်ပါ</p>
            <p className="mt-2 text-center text-sm text-gray-600">{errorMsg}</p>
            <div className="mt-6 flex w-full gap-3">
              <button
                onClick={onClose}
                className="flex-1 rounded-lg border border-gray-300 bg-white py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRetry}
                className="flex-1 rounded-lg bg-[#1a6b3c] py-2.5 text-sm font-semibold text-white hover:bg-[#155d33] transition-colors"
              >
                Retry / <span className="font-myanmar">ပြန်ကြိုးစားပါ</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
