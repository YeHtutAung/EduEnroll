"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import TrustedOfficialShell from "@/components/enrollment/TrustedOfficialShell";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import QRCode from "qrcode";

interface TicketData {
  jti: string;
  tier: string;
  admits: number;
  jwt: string;
}

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
  tickets?: TicketData[];
}

function SuccessContent() {
  const searchParams = useSearchParams();
  const ref = searchParams.get("ref") ?? "";
  const [data, setData] = useState<EnrollmentData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [savingImg, setSavingImg] = useState(false);
  const [ticketQrUrls, setTicketQrUrls] = useState<Record<string, string>>({});
  const receiptRef = useRef<HTMLDivElement>(null);
  const ticketRefs = useRef<(HTMLDivElement | null)[]>([]);

  async function waitForImages(el: HTMLElement) {
    const imgs = el.querySelectorAll("img");
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
  }

  function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Render a single e-ticket to a PNG blob (canvas), mirroring the PDF layout.
  async function renderTicketBlob(
    ticket: TicketData,
    i: number,
    n: number,
    qrUrl: string,
  ): Promise<Blob | null> {
    if (!data) return null;
    const S = 6;
    const W = 100 * S;
    const H = 132 * S;
    const m = 8 * S;
    const cardW = W - 2 * m;
    const cardH = H - 2 * m;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const font = (px: number, weight = "normal") => `${weight} ${px * S}px Helvetica, Arial, sans-serif`;

    ctx.fillStyle = "#f7f5ef";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#0f1f42";
    roundRectPath(ctx, m, m, cardW, cardH, 4 * S);
    ctx.fill();

    const padX = m + 8 * S;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#d4af5a";
    ctx.font = font(8, "bold");
    ctx.textAlign = "left";
    ctx.fillText((data.event_name || "").toUpperCase(), padX, m + 12 * S);
    ctx.fillStyle = "#8a90a5";
    ctx.font = font(7, "bold");
    ctx.textAlign = "right";
    ctx.fillText(`Ticket ${i + 1}/${n}`, W - padX, m + 12 * S);

    ctx.fillStyle = "#ffffff";
    ctx.font = font(20, "bold");
    ctx.textAlign = "left";
    ctx.fillText(ticket.tier, padX, m + 26 * S);

    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 0.5 * S;
    ctx.setLineDash([1.5 * S, 1.5 * S]);
    ctx.beginPath();
    ctx.moveTo(padX, m + 31 * S);
    ctx.lineTo(W - padX, m + 31 * S);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#8a90a5";
    ctx.font = font(7);
    ctx.fillText("ORDER REF", padX, m + 40 * S);
    ctx.fillStyle = "#ffffff";
    ctx.font = font(13, "bold");
    ctx.fillText(data.enrollment_ref, padX, m + 47 * S);
    ctx.fillStyle = "#8a90a5";
    ctx.font = font(7);
    ctx.fillText(`Ticket #${ticket.jti.slice(0, 8)}`, padX, m + 53 * S);

    const qs = 44 * S;
    const qx = (W - qs) / 2;
    const qy = m + cardH - qs - 14 * S;
    ctx.fillStyle = "#ffffff";
    roundRectPath(ctx, qx - 3 * S, qy - 3 * S, qs + 6 * S, qs + 6 * S, 2 * S);
    ctx.fill();
    const qrImg = await loadImage(qrUrl);
    ctx.drawImage(qrImg, qx, qy, qs, qs);
    ctx.fillStyle = "#8a90a5";
    ctx.font = font(6.5);
    ctx.textAlign = "center";
    ctx.fillText("Scan at entry", W / 2, qy + qs + 7 * S);

    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
  }

  // Mobile-friendly save: PNG per ticket via the native share sheet
  // (Save to Photos / Files), falling back to a direct image download.
  async function handleSaveImage() {
    if (savingImg || !data) return;
    const tickets = data.tickets ?? [];
    if (tickets.length === 0) return;

    setSavingImg(true);
    try {
      const qrMap: Record<string, string> = { ...ticketQrUrls };
      await Promise.all(
        tickets.map(async (t) => {
          if (!qrMap[t.jti]) qrMap[t.jti] = await QRCode.toDataURL(t.jwt, { width: 240, margin: 1 });
        }),
      );

      const files: File[] = [];
      for (let i = 0; i < tickets.length; i++) {
        const blob = await renderTicketBlob(tickets[i], i, tickets.length, qrMap[tickets[i].jti]);
        if (!blob) continue;
        const suffix = tickets.length > 1 ? `-${i + 1}` : "";
        files.push(new File([blob], `eticket-${data.enrollment_ref}${suffix}.png`, { type: "image/png" }));
      }
      if (files.length === 0) return;

      const nav = navigator as Navigator & {
        canShare?: (d?: ShareData) => boolean;
        share?: (d: ShareData) => Promise<void>;
      };
      if (nav.canShare && nav.share && nav.canShare({ files })) {
        await nav.share({ files, title: "E-Ticket", text: `${data.event_name} e-ticket` });
      } else {
        for (const file of files) {
          const url = URL.createObjectURL(file);
          const a = document.createElement("a");
          a.href = url;
          a.download = file.name;
          a.click();
          URL.revokeObjectURL(url);
        }
      }
    } catch (err) {
      // User cancelling the share sheet rejects with AbortError — not an error.
      if ((err as { name?: string })?.name !== "AbortError") {
        console.error("[ticket] Failed to save e-ticket image:", err);
      }
    } finally {
      setSavingImg(false);
    }
  }

  async function handleDownload() {
    if (generating || !data) return;
    const tickets = data.tickets ?? [];

    setGenerating(true);
    try {
      if (tickets.length > 0) {
        // Ensure a QR data URL exists for every ticket (in case download was
        // clicked before the render effect populated ticketQrUrls). html2canvas
        // cannot reliably rasterize a data-URI <img>, so we draw each ticket
        // with jsPDF primitives and place the QR via addImage instead.
        const qrMap: Record<string, string> = { ...ticketQrUrls };
        await Promise.all(
          tickets.map(async (t) => {
            if (!qrMap[t.jti]) qrMap[t.jti] = await QRCode.toDataURL(t.jwt, { width: 240, margin: 1 });
          }),
        );

        const W = 100;
        const H = 132;
        const m = 8;
        const cardW = W - 2 * m;
        const cardH = H - 2 * m;
        const pdf = new jsPDF({ unit: "mm", format: [W, H] });

        tickets.forEach((ticket, i) => {
          if (i > 0) pdf.addPage([W, H]);

          // Navy card
          pdf.setFillColor(15, 31, 66);
          pdf.roundedRect(m, m, cardW, cardH, 4, 4, "F");

          const padX = m + 8;
          // Event name (gold) + ticket index (right)
          pdf.setFont("helvetica", "bold");
          pdf.setTextColor(212, 175, 90);
          pdf.setFontSize(8);
          pdf.text((data.event_name || "").toUpperCase(), padX, m + 12);
          pdf.setTextColor(138, 144, 165);
          pdf.setFontSize(7);
          pdf.text(`Ticket ${i + 1}/${tickets.length}`, W - padX, m + 12, { align: "right" });

          // Tier (white, large)
          pdf.setTextColor(255, 255, 255);
          pdf.setFontSize(20);
          pdf.text(ticket.tier, padX, m + 25);

          // Dashed divider
          pdf.setDrawColor(255, 255, 255);
          pdf.setLineWidth(0.2);
          pdf.setLineDashPattern([1, 1], 0);
          pdf.line(padX, m + 31, W - padX, m + 31);
          pdf.setLineDashPattern([], 0);

          // Order ref + ticket id
          pdf.setFont("helvetica", "normal");
          pdf.setTextColor(138, 144, 165);
          pdf.setFontSize(7);
          pdf.text("ORDER REF", padX, m + 40);
          pdf.setFont("helvetica", "bold");
          pdf.setTextColor(255, 255, 255);
          pdf.setFontSize(13);
          pdf.text(data.enrollment_ref, padX, m + 47);
          pdf.setFont("helvetica", "normal");
          pdf.setTextColor(138, 144, 165);
          pdf.setFontSize(7);
          pdf.text(`Ticket #${ticket.jti.slice(0, 8)}`, padX, m + 53);

          // QR on a white chip, centered near the bottom of the card
          const qr = qrMap[ticket.jti];
          if (qr) {
            const qs = 44;
            const qx = (W - qs) / 2;
            const qy = m + cardH - qs - 14;
            pdf.setFillColor(255, 255, 255);
            pdf.roundedRect(qx - 3, qy - 3, qs + 6, qs + 6, 2, 2, "F");
            pdf.addImage(qr, "PNG", qx, qy, qs, qs);
            pdf.setTextColor(138, 144, 165);
            pdf.setFontSize(6.5);
            pdf.text("Scan at entry", W / 2, qy + qs + 7, { align: "center" });
          }
        });

        pdf.save(`eticket-${data.enrollment_ref}.pdf`);
        return;
      }

      if (!receiptRef.current) return;
      await waitForImages(receiptRef.current);
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

  useEffect(() => {
    const tickets = data?.tickets ?? [];
    if (tickets.length === 0) return;
    let cancelled = false;

    (async () => {
      const entries = await Promise.all(
        tickets.map(async (t) => {
          const dataUrl = await QRCode.toDataURL(t.jwt, { width: 240, margin: 1 });
          return [t.jti, dataUrl] as const;
        }),
      );
      if (!cancelled) setTicketQrUrls(Object.fromEntries(entries));
    })();

    return () => {
      cancelled = true;
    };
  }, [data]);

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
  const tickets = data.tickets ?? [];

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

      {/* Ticket stub(s) — one real, scannable e-ticket per admission when confirmed */}
      {tickets.length > 0 ? (
        <div className="mb-4 space-y-3">
          {tickets.map((ticket, i) => (
            <div
              key={ticket.jti}
              ref={(el) => {
                ticketRefs.current[i] = el;
              }}
              className="rounded-[12px] p-4 relative overflow-hidden"
              style={{ background: "#0f1f42" }}
            >
              {/* Perforation strip — right edge */}
              <div
                className="absolute right-0 top-0 bottom-0 w-[6px]"
                style={{
                  background:
                    "repeating-linear-gradient(to bottom, #f7f5ef 0px, #f7f5ef 8px, #0f1f42 8px, #0f1f42 14px)",
                }}
              />
              <div className="flex items-center justify-between mb-2">
                <p className="text-[9px] font-bold tracking-[1.8px] uppercase" style={{ color: "#d4af5a" }}>
                  {data.event_name}
                </p>
                <p className="text-[8.5px] font-bold" style={{ color: "#8a90a5" }}>
                  Ticket {i + 1}/{tickets.length}
                </p>
              </div>
              <p className="text-[14px] font-extrabold text-white mb-1">{ticket.tier}</p>
              <hr className="my-3" style={{ borderColor: "rgba(255,255,255,.25)", borderStyle: "dashed" }} />
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[8.5px] mb-0.5" style={{ color: "#8a90a5" }}>ORDER REF</p>
                  <p className="text-[13px] font-extrabold text-white">{data.enrollment_ref}</p>
                  <p className="text-[8.5px] mt-1.5" style={{ color: "#8a90a5" }}>
                    Ticket #{ticket.jti.slice(0, 8)}
                  </p>
                </div>
                {ticketQrUrls[ticket.jti] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={ticketQrUrls[ticket.jti]}
                    alt={`QR code for ticket ${ticket.jti.slice(0, 8)}`}
                    className="w-[64px] h-[64px] rounded-[4px] bg-white p-1 shrink-0"
                  />
                ) : (
                  <div
                    className="w-[64px] h-[64px] rounded-[4px] shrink-0"
                    style={{
                      background:
                        "repeating-linear-gradient(45deg, #fff 0px, #fff 4px, #0f1f42 4px, #0f1f42 8px)",
                      opacity: 0.2,
                    }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
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
      )}

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

      {/* Hidden receipt for PDF capture — fallback when no per-ticket QR data is available */}
      {tickets.length === 0 && (
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
      )}

      {/* Save to Photos / Files (mobile-friendly, image via native share sheet) */}
      {tickets.length > 0 && (
        <button
          onClick={handleSaveImage}
          disabled={savingImg}
          className="w-full py-3 rounded-[8px] text-[11.5px] font-bold text-white mb-2.5"
          style={{
            background: "#0f1f42",
            cursor: savingImg ? "wait" : "pointer",
            opacity: savingImg ? 0.6 : 1,
          }}
        >
          {savingImg ? "Preparing…" : "SAVE E-TICKET"}
        </button>
      )}

      {/* Download CTA (PDF) */}
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
        {generating ? "Generating..." : "DOWNLOAD PDF"}
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
