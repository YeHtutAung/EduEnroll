"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import TrustedOfficialShell from "@/components/enrollment/TrustedOfficialShell";

interface EnrollmentData {
  enrollment_ref: string;
  status: string;
  student_name_en: string;
  total_amount: number;
  items: { level: string; quantity: number; fee_amount: number }[];
  event_name: string;
  card_brand?: string | null;
  card_last4?: string | null;
  payment_method?: string | null;
}

function SuccessContent() {
  const searchParams = useSearchParams();
  const ref = searchParams.get("ref") ?? "";
  const [data, setData] = useState<EnrollmentData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ref) { setError("Missing order reference."); return; }
    sessionStorage.removeItem(`cs_${ref}`);

    fetch(`/api/public/enrollment/${ref}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch(() => setError("Failed to load order details."));
  }, [ref]);

  if (error || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-5" style={{ background: "#f7f5ef" }}>
        <p className="text-[13px]" style={{ color: "#0f1f42" }}>{error ?? "Loading..."}</p>
      </div>
    );
  }

  const isPayNow = data.payment_method === "paynow";
  const paymentLabel = isPayNow
    ? "PayNow"
    : data.card_brand && data.card_last4
    ? `${data.card_brand.charAt(0).toUpperCase() + data.card_brand.slice(1)} ••${data.card_last4}`
    : "Credit Card";

  const ticketSummary = data.items.map((i) => `${i.level} × ${i.quantity}`).join(", ");

  return (
    <TrustedOfficialShell orgName={data.event_name} step="complete">
      {/* Checkmark badge */}
      <div className="flex flex-col items-center mb-5 mt-2">
        <div
          className="w-[42px] h-[42px] rounded-full flex items-center justify-center mb-3"
          style={{ background: "#0f1f42" }}
        >
          <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
            <path d="M1.5 7L6.5 12L16.5 2" stroke="#d4af5a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1 className="text-[14px] font-extrabold" style={{ color: "#0f1f42" }}>
          {isPayNow ? "PayNow payment received" : "Payment successful"}
        </h1>
        <p className="text-[10.5px] mt-0.5" style={{ color: "#8b8f9a" }}>E-tickets sent to your email</p>
      </div>

      {/* Ticket stub */}
      <div
        className="rounded-[12px] p-4 mb-4 relative overflow-hidden"
        style={{ background: "#0f1f42" }}
      >
        {/* Perforation strip — right edge */}
        <div
          className="absolute right-0 top-0 bottom-0 w-[6px]"
          style={{
            background: "repeating-linear-gradient(to bottom, #f7f5ef 0px, #f7f5ef 8px, #0f1f42 8px, #0f1f42 14px)",
          }}
        />
        <p className="text-[9px] font-bold tracking-[1.8px] uppercase mb-2" style={{ color: "#d4af5a" }}>
          {data.event_name}
        </p>
        <p className="text-[14px] font-extrabold text-white mb-1">{ticketSummary}</p>
        <hr className="my-3" style={{ borderColor: "rgba(255,255,255,.25)", borderStyle: "dashed" }} />
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[8.5px] mb-0.5" style={{ color: "#8a90a5" }}>ORDER REF</p>
            <p className="text-[13px] font-extrabold text-white">{data.enrollment_ref}</p>
          </div>
          {/* QR placeholder */}
          <div
            className="w-[42px] h-[42px] rounded-[4px]"
            style={{
              background: "repeating-linear-gradient(45deg, #fff 0px, #fff 4px, #0f1f42 4px, #0f1f42 8px)",
              opacity: 0.2,
            }}
          />
        </div>
      </div>

      {/* Payment summary */}
      <div className="rounded-[9px] p-4 mb-5" style={{ background: "#ffffff", border: "1px solid #e3e0d6" }}>
        <div className="flex justify-between text-[12px] mb-2">
          <span style={{ color: "#8b8f9a" }}>Amount paid</span>
          <span className="font-bold" style={{ color: "#0f1f42" }}>{data.total_amount.toLocaleString()}</span>
        </div>
        <div className="flex justify-between text-[12px]">
          <span style={{ color: "#8b8f9a" }}>Payment method</span>
          <span className="font-bold" style={{ color: "#0f1f42" }}>{paymentLabel}</span>
        </div>
      </div>

      {/* Download CTA */}
      <button
        className="w-full py-3 rounded-[8px] text-[11.5px] font-bold cursor-not-allowed"
        style={{ border: "1.5px solid #0f1f42", color: "#0f1f42", background: "transparent" }}
        disabled
        title="Coming soon"
      >
        DOWNLOAD E-TICKET
      </button>
    </TrustedOfficialShell>
  );
}

export default function SuccessPage() {
  return (
    <Suspense>
      <SuccessContent />
    </Suspense>
  );
}
