"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import TrustedOfficialShell from "@/components/enrollment/TrustedOfficialShell";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

interface EnrollmentData {
  enrollment_ref: string;
  status: string;
  student_name_en: string;
  total_amount: number;
  items: { level: string; quantity: number; fee_amount: number }[];
  event_name: string;
  logo_url?: string | null;
  brand_color?: string | null;
  card_brand?: string | null;
  card_last4?: string | null;
  payment_method?: string | null;
}

function SuccessContent() {
  const searchParams = useSearchParams();
  const ref = searchParams.get("ref") ?? "";
  const [data, setData] = useState<EnrollmentData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const receiptRef = useRef<HTMLDivElement>(null);

  async function handleDownload() {
    if (!receiptRef.current || generating || !data) return;
    setGenerating(true);
    try {
      const imgs = receiptRef.current.querySelectorAll("img");
      await Promise.all(
        Array.from(imgs).map(
          (img) =>
            new Promise<void>((resolve) => {
              if (img.complete) return resolve();
              img.onload = () => resolve();
              img.onerror = () => resolve();
            }),
        ),
      );
      const canvas = await html2canvas(receiptRef.current, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#f5f7fa",
        logging: false,
      });
      const imgWidth = 148;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      const pdf = new jsPDF({ unit: "mm", format: [imgWidth, imgHeight + 10] });
      pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 5, imgWidth, imgHeight);
      pdf.save(`eticket-${data.enrollment_ref}.pdf`);
    } catch (err) {
      console.error("[pdf] Failed to generate e-ticket:", err);
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => {
    if (!ref) { setError("Missing order reference."); return; }
    sessionStorage.removeItem(`cs_${ref}`);

    // If Stripe redirected back with ?payment_intent=pi_xxx&redirect_status=succeeded,
    // call the intent/status endpoint first to confirm payment and advance enrollment status.
    const urlParams = new URLSearchParams(window.location.search);
    const piId = urlParams.get("payment_intent");
    const redirectStatus = urlParams.get("redirect_status");

    const verify = piId && redirectStatus === "succeeded"
      ? fetch(`/api/public/payments/stripe/intent/status?pi=${encodeURIComponent(piId)}`).catch(() => null)
      : Promise.resolve(null);

    verify.then(() =>
      fetch(`/api/public/enrollment/${ref}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.error) setError(d.error);
          else setData(d);
        })
        .catch(() => setError("Failed to load order details.")),
    );
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
    : data.payment_method === "bank_transfer"
    ? "Bank Transfer"
    : data.payment_method === "mmqr"
    ? "MMQR"
    : data.payment_method === "paypay"
    ? "PayPay"
    : data.card_brand && data.card_last4
    ? `${data.card_brand.charAt(0).toUpperCase() + data.card_brand.slice(1)} ••${data.card_last4}`
    : data.payment_method
    ? data.payment_method
    : "—";

  const ticketSummary = data.items.map((i) => `${i.level} × ${i.quantity}`).join(", ");

  return (
    <TrustedOfficialShell orgName={data.event_name} logoUrl={data.logo_url} brandColor={data.brand_color} step="complete">
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
          {isPayNow ? "PayNow payment received"
            : data.status === "payment_submitted" ? "Payment proof submitted"
            : "Payment successful"}
        </h1>
        <p className="text-[10.5px] mt-0.5" style={{ color: "#8b8f9a" }}>
          {data.status === "payment_submitted"
            ? "We'll verify and send your e-ticket shortly"
            : "E-tickets sent to your email"}
        </p>
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

      {/* Hidden receipt for PDF capture */}
      <div style={{ position: "absolute", left: "-9999px", top: 0 }}>
        <div
          ref={receiptRef}
          style={{
            width: "520px",
            padding: "32px 20px",
            background: "#f5f7fa",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            color: "#1a1a1a",
          }}
        >
          <div style={{ background: "#fff", borderRadius: "12px", overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
            <div style={{ height: "4px", background: "linear-gradient(90deg, #0f1f42, #d4af5a)" }} />
            <div style={{ padding: "24px 28px 20px" }}>
              {/* Header */}
              <div style={{ textAlign: "center", marginBottom: "16px" }}>
                <div style={{ width: "44px", height: "44px", borderRadius: "50%", background: "#0f1f42", margin: "0 auto 10px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="22" height="18" viewBox="0 0 18 14" fill="none">
                    <path d="M1.5 7L6.5 12L16.5 2" stroke="#d4af5a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <h1 style={{ margin: 0, fontSize: "19px", color: "#0f1f42", fontWeight: 700 }}>Payment Confirmed</h1>
                <p style={{ margin: "3px 0 0", fontSize: "13px", color: "#6b7280" }}>{data.event_name}</p>
              </div>

              {/* Reference */}
              <div style={{ background: "#f0f4ff", border: "1px solid #c7d2fe", borderRadius: "8px", padding: "12px", textAlign: "center", margin: "0 0 16px" }}>
                <p style={{ fontSize: "9px", textTransform: "uppercase" as const, letterSpacing: "1px", color: "#0f1f42", margin: "0 0 4px", fontWeight: 600 }}>Order Reference</p>
                <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "20px", fontWeight: 700, color: "#0f1f42", letterSpacing: "1px", margin: 0 }}>{data.enrollment_ref}</p>
              </div>

              {/* Detail rows */}
              <p style={{ fontSize: "9px", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "1.5px", color: "#9ca3af", margin: "0 0 6px" }}>Details</p>
              <div style={{ margin: "0 0 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f3f4f6", fontSize: "13px" }}>
                  <span style={{ color: "#6b7280" }}>Name</span>
                  <span style={{ fontWeight: 600, color: "#1f2937" }}>{data.student_name_en}</span>
                </div>
                {data.items.map((item, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f3f4f6", fontSize: "13px" }}>
                    <span style={{ color: "#6b7280" }}>{i === 0 ? "Ticket" : ""}</span>
                    <span style={{ fontWeight: 600, color: "#1f2937" }}>{item.level}{item.quantity > 1 ? ` ×${item.quantity}` : ""}</span>
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", fontSize: "13px" }}>
                  <span style={{ color: "#6b7280" }}>Date</span>
                  <span style={{ fontWeight: 600, color: "#1f2937" }}>{new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</span>
                </div>
              </div>

              {/* Total */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "#f9fafb", borderRadius: "8px" }}>
                <span style={{ fontSize: "13px", fontWeight: 600, color: "#6b7280" }}>Total Paid</span>
                <span style={{ fontSize: "17px", fontWeight: 700, color: "#0f1f42" }}>{data.total_amount.toLocaleString()}</span>
              </div>
            </div>
          </div>
          <div style={{ textAlign: "center", marginTop: "12px", fontSize: "11px", color: "#9ca3af" }}>
            <p style={{ margin: 0 }}>&copy; {new Date().getFullYear()} Powered by KuuNyi</p>
          </div>
        </div>
      </div>

      {/* Download CTA */}
      <button
        onClick={handleDownload}
        disabled={generating}
        className="w-full py-3 rounded-[8px] text-[11.5px] font-bold"
        style={{
          border: "1.5px solid #0f1f42",
          color: generating ? "#8b8f9a" : "#0f1f42",
          background: "transparent",
          cursor: generating ? "wait" : "pointer",
          opacity: generating ? 0.6 : 1,
        }}
      >
        {generating ? "Generating..." : "DOWNLOAD E-TICKET"}
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
