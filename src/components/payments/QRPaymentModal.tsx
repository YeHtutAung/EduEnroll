"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import QRCode from "qrcode";
import { formatMMKSimple } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type QRProvider = "mmpay" | "abank";

interface QRPaymentModalProps {
  enrollmentRef: string;
  amount: number;
  studentName: string;
  onSuccess: () => void;
  onClose: () => void;
  provider?: QRProvider;
}

type ModalState = "loading" | "qr" | "success" | "error";

// ─── Component ────────────────────────────────────────────────────────────────

export default function QRPaymentModal({
  enrollmentRef,
  amount,
  studentName,
  onSuccess,
  onClose,
  provider = "mmpay",
}: QRPaymentModalProps) {
  const apiBase = provider === "abank" ? "/api/public/payments/abank" : "/api/public/payments/mmpay";
  const [state, setState] = useState<ModalState>("loading");
  const [qrData, setQrData] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Close on Escape ────────────────────────────────────────
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // ── Cleanup polling on unmount ─────────────────────────────
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // ── Start polling for payment status ───────────────────────
  const startPolling = useCallback(
    (paymentRef: string) => {
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(
            `${apiBase}/status?ref=${encodeURIComponent(paymentRef)}`,
          );
          if (!res.ok) return;
          const data: { mmqr_status: string } = await res.json();

          if (data.mmqr_status === "SUCCESS") {
            if (pollRef.current) clearInterval(pollRef.current);
            setState("success");
            onSuccess();
          } else if (data.mmqr_status === "FAILED") {
            if (pollRef.current) clearInterval(pollRef.current);
            setState("error");
            setErrorMsg("Payment was declined. Please try again.");
          }
        } catch {
          // Ignore polling errors — will retry next interval
        }
      }, 10000);
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
        setQrData(data.qr);
        setOrderId(data.orderId);
        // Generate QR image from EMVCo string
        if (data.qr) {
          try {
            const dataUrl = await QRCode.toDataURL(data.qr, { width: 280, margin: 2 });
            setQrImageUrl(dataUrl);
          } catch {
            console.error("[QRPaymentModal] QR render failed");
          }
        }
        setState("qr");
        startPolling(data.orderId);
      } catch {
        setErrorMsg("Network error. Please check your connection.");
        setState("error");
      }
    }

    createPayment();
  }, [enrollmentRef, startPolling]);

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
        setQrData(data.qr);
        setOrderId(data.orderId);
        setState("qr");
        startPolling(data.orderId);
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
      <div className="relative w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
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
            {/* Header */}
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-[#1a6b3c]/10">
              <svg className="h-5 w-5 text-[#1a6b3c]" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.375v-4.5z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 6.75h.75v.75h-.75v-.75zM6.75 16.5h.75v.75h-.75v-.75zM16.5 6.75h.75v.75h-.75v-.75zM13.5 13.5h.75v.75h-.75v-.75zM13.5 19.5h.75v.75h-.75v-.75zM19.5 13.5h.75v.75h-.75v-.75zM19.5 19.5h.75v.75h-.75v-.75zM16.5 16.5h.75v.75h-.75v-.75z" />
              </svg>
            </div>

            <h3 className="text-lg font-semibold text-gray-900">Pay with MMQR</h3>
            <p className="font-myanmar mt-0.5 text-sm text-gray-500">MMQR ဖြင့် ငွေပေးချေပါ</p>

            {/* Amount */}
            <div className="mt-3 rounded-lg bg-gray-50 px-4 py-2 text-center">
              <p className="text-xs text-gray-500">Amount / <span className="font-myanmar">ပမာဏ</span></p>
              <p className="text-xl font-bold text-gray-900">{formatMMKSimple(amount)}</p>
            </div>

            {/* Student name */}
            <p className="mt-2 text-xs text-gray-500">
              {studentName}
            </p>

            {/* QR Image */}
            {qrImageUrl ? (
              <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrImageUrl}
                  alt="MMQR Payment Code"
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

            {/* Instructions */}
            <p className="mt-4 text-center text-xs text-gray-500">
              Scan with KBZPay, Wave, CB Pay or any MMQR-supported app
            </p>
            <p className="font-myanmar mt-0.5 text-center text-xs text-gray-400">
              KBZPay, Wave, CB Pay သို့မဟုတ် MMQR ပံ့ပိုးသော app ဖြင့် စကင်ဖတ်ပါ
            </p>

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
            <p className="mt-2 text-sm text-gray-600">{formatMMKSimple(amount)}</p>
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
