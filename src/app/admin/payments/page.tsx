"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmModal from "@/components/ui/ConfirmModal";
import EmptyState from "@/components/ui/EmptyState";
import StatusBadge from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { formatMMKSimple } from "@/lib/utils";
import type { Enrollment, Payment } from "@/types/database";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CartItem {
  class_level: string;
  quantity: number;
  fee_mmk: number;
  subtotal_mmk: number;
}

interface PendingItem {
  enrollment: Enrollment;
  payment: Payment | null;
  class_level: string;
  intake_id: string;
  intake_name: string;
  proof_signed_url: string | null;
  proof_signed_urls: string[];
  items: CartItem[] | null;
  total_fee_mmk: number;
}

interface FormFieldDef {
  field_key: string;
  field_label: string;
  field_type: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (s < 60)  return "just now";
  if (m < 60)  return `${m}m ago`;
  if (h < 24)  return `${h}h ago`;
  if (d === 1) return "yesterday";
  return `${d}d ago`;
}

const LEVEL_COLORS: Record<string, string> = {
  N5: "#1a6b3c",
  N4: "#0891b2",
  N3: "#1a3f8a",
  N2: "#b07d2a",
  N1: "#c0392b",
};

// Deterministic color for arbitrary ticket type names (events)
const TICKET_PALETTE = [
  "#1a6b3c", "#0891b2", "#1a3f8a", "#b07d2a", "#c0392b",
  "#7c3aed", "#0d9488", "#be185d", "#ea580c", "#4f46e5",
];

function ticketColor(level: string): string {
  if (LEVEL_COLORS[level]) return LEVEL_COLORS[level];
  let hash = 0;
  for (let i = 0; i < level.length; i++) hash = ((hash << 5) - hash + level.charCodeAt(i)) | 0;
  return TICKET_PALETTE[Math.abs(hash) % TICKET_PALETTE.length];
}

// ── Skeleton card ─────────────────────────────────────────────────────────────

function CardSkeleton() {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden animate-pulse">
      <div className="h-44 bg-gray-200" />
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="h-4 w-8 bg-gray-200 rounded" />
          <div className="h-3 w-16 bg-gray-100 rounded" />
        </div>
        <div className="h-5 w-36 bg-gray-200 rounded" />
        <div className="h-3 w-24 bg-gray-100 rounded" />
        <div className="h-7 w-32 bg-gray-200 rounded" />
      </div>
    </div>
  );
}

// ── Payment card ──────────────────────────────────────────────────────────────

function PaymentCard({
  item,
  onClick,
}: {
  item: PendingItem;
  onClick: () => void;
}) {
  const { enrollment, payment, class_level, proof_signed_url, proof_signed_urls, items } = item;
  const submitted = payment?.created_at ?? enrollment.enrolled_at;
  const imageCount = proof_signed_urls?.length ?? (proof_signed_url ? 1 : 0);
  const isCart = items != null && items.length > 0;
  const totalTickets = isCart ? items.reduce((sum, i) => sum + i.quantity, 0) : null;

  return (
    <button
      onClick={onClick}
      className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden hover:shadow-md hover:border-[#b07d2a]/40 transition-all text-left w-full group"
    >
      {/* Proof thumbnail */}
      <div className="relative h-44 bg-gray-100 overflow-hidden">
        {proof_signed_url ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={proof_signed_url}
            alt="Payment proof"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-gray-300">
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
            </svg>
            <span className="text-xs">No proof uploaded</span>
          </div>
        )}
        {/* Image count badge */}
        {imageCount > 1 && (
          <span className="absolute top-3 left-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/60 text-white text-xs font-medium">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
            </svg>
            {imageCount}
          </span>
        )}
        {/* Cart ticket count badge */}
        {isCart && totalTickets && totalTickets > 1 && (
          <span className="absolute bottom-3 left-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#1a3f8a]/80 text-white text-xs font-medium">
            {totalTickets} tickets
          </span>
        )}
        {/* Pulsing "new" indicator */}
        <div className="absolute top-3 right-3 flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#b07d2a] opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#b07d2a]" />
        </div>
      </div>

      {/* Card body */}
      <div className="p-4 space-y-2">
        {/* Level + time */}
        <div className="flex items-center justify-between">
          {isCart ? (
            <div className="flex items-center gap-1 flex-wrap">
              {items.map((ci, i) => (
                <span
                  key={i}
                  className="inline-flex items-center justify-center px-1.5 h-6 rounded text-[10px] font-bold text-white"
                  style={{ backgroundColor: ticketColor(ci.class_level) }}
                >
                  {ci.class_level}&times;{ci.quantity}
                </span>
              ))}
            </div>
          ) : (
            <span
              className="inline-flex items-center justify-center px-2 h-7 rounded-lg text-xs font-bold text-white whitespace-nowrap"
              style={{ backgroundColor: ticketColor(class_level) }}
            >
              {class_level}
            </span>
          )}
          <span className="text-xs text-gray-400">{timeAgo(submitted)}</span>
        </div>

        {/* Names */}
        <div>
          <p className="font-semibold text-gray-900 leading-tight truncate">
            {enrollment.student_name_en}
          </p>
          {enrollment.student_name_mm && (
            <p className="text-xs font-myanmar text-gray-400 mt-0.5 truncate">
              {enrollment.student_name_mm}
            </p>
          )}
        </div>

        {/* Enrollment ref */}
        <code className="block text-xs font-mono text-gray-400">
          {enrollment.enrollment_ref}
        </code>

        {/* Amount */}
        <p className="text-xl font-bold" style={{ color: "#b07d2a" }}>
          {payment ? formatMMKSimple(payment.amount_mmk) : "—"}
        </p>
      </div>

      {/* Footer hover cue */}
      <div className="px-4 py-2.5 bg-gray-50 border-t border-gray-100 flex items-center gap-1.5 text-xs text-gray-400 group-hover:text-[#1a3f8a] group-hover:bg-[#f0f4ff] transition-colors">
        <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.641 0-8.58-3.007-9.964-7.178z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        Click to review
      </div>
    </button>
  );
}

// ── Reject reason modal ───────────────────────────────────────────────────────

function RejectModal({
  item,
  onClose,
  onRejected,
}: {
  item: PendingItem;
  onClose: () => void;
  onRejected: (id: string) => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [processing, setProcessing] = useState(false);
  const savingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    if (!item.payment) return;
    if (!reason.trim()) return;
    savingRef.current = true;
    setProcessing(true);
    try {
      const res = await fetch(`/api/admin/payments/${item.payment.id}/verify`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", rejection_reason: reason.trim() }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? `${res.status}`);
      }
      toast.info(`Payment rejected for ${item.enrollment.student_name_en}.`);
      onRejected(item.enrollment.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rejection failed.");
    } finally {
      savingRef.current = false;
      setProcessing(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl p-6">
        <div className="w-11 h-11 rounded-full bg-red-100 flex items-center justify-center mb-4">
          <svg className="w-5 h-5 text-[#c0392b]" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>

        <h2 className="text-lg font-bold text-gray-900 mb-0.5">Reject Payment</h2>
        <p className="text-sm text-gray-500 mb-5">
          Rejecting payment for{" "}
          <span className="font-semibold text-gray-800">
            {item.enrollment.student_name_en}
          </span>
          . Please provide a reason.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Rejection Reason <span className="text-[#c0392b]">*</span>
            </label>
            <textarea
              ref={textareaRef}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              rows={3}
              placeholder="e.g. Incorrect amount, blurry image, wrong account…"
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#c0392b] focus:border-transparent"
            />
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={processing || !reason.trim()}
              className="flex-1 px-4 py-2.5 bg-[#c0392b] text-white rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              {processing ? "Rejecting…" : "Reject Payment"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Request Remaining modal ─────────────────────────────────────────────────

function RequestRemainingModal({
  item,
  onClose,
  onDone,
}: {
  item: PendingItem;
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const [receivedAmount, setReceivedAmount] = useState("");
  const [processing, setProcessing] = useState(false);
  const savingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const totalAmount = item.payment?.amount_mmk ?? 0;
  const parsedReceived = parseInt(receivedAmount.replace(/,/g, ""), 10);
  const remainingAmount = !isNaN(parsedReceived) ? totalAmount - parsedReceived : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    if (!item.payment) return;
    if (!note.trim()) return;
    savingRef.current = true;
    setProcessing(true);
    try {
      const body: Record<string, unknown> = {
        action: "request_remaining",
        admin_note: note.trim(),
      };
      if (!isNaN(parsedReceived) && parsedReceived > 0) {
        body.received_amount = parsedReceived;
      }

      const res = await fetch(`/api/admin/payments/${item.payment.id}/verify`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? `${res.status}`);
      }
      toast.success(`Remaining payment requested for ${item.enrollment.student_name_en}.`);
      onDone(item.enrollment.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed.");
    } finally {
      savingRef.current = false;
      setProcessing(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl p-6">
        <div className="w-11 h-11 rounded-full bg-amber-100 flex items-center justify-center mb-4">
          <svg className="w-5 h-5 text-[#b07d2a]" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>

        <h2 className="text-lg font-bold text-gray-900 mb-0.5">Request Remaining Payment</h2>
        <p className="text-sm text-gray-500 mb-5">
          The student will be notified to upload additional payment receipts for{" "}
          <span className="font-semibold text-gray-800">
            {item.enrollment.student_name_en}
          </span>.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Total amount display */}
          <div className="rounded-xl bg-gray-50 border border-gray-200 p-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Total amount</span>
              <span className="font-semibold text-gray-900">{formatMMKSimple(totalAmount)}</span>
            </div>
          </div>

          {/* Received amount */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Amount Received (MMK)
            </label>
            <input
              type="text"
              inputMode="numeric"
              value={receivedAmount}
              onChange={(e) => setReceivedAmount(e.target.value.replace(/[^0-9,]/g, ""))}
              placeholder="e.g. 1,000,000"
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#b07d2a] focus:border-transparent"
            />
            {remainingAmount != null && remainingAmount > 0 && (
              <p className="mt-1 text-xs text-[#c0392b] font-medium">
                Remaining: {formatMMKSimple(remainingAmount)}
              </p>
            )}
          </div>

          {/* Admin note */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Message to Student <span className="text-[#c0392b]">*</span>
            </label>
            <textarea
              ref={textareaRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              required
              rows={3}
              placeholder="e.g. We received 1,000,000 MMK. Please transfer the remaining 500,000 MMK and upload the receipt."
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#b07d2a] focus:border-transparent"
            />
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={processing || !note.trim()}
              className="flex-1 px-4 py-2.5 bg-[#b07d2a] text-white rounded-xl text-sm font-medium hover:bg-amber-700 disabled:opacity-50 transition-colors"
            >
              {processing ? "Sending…" : "Request Remaining"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Image Gallery (prev/next navigation) ────────────────────────────────────

function ImageGallery({
  urls,
  onClickFullscreen,
}: {
  urls: string[];
  onClickFullscreen: (index: number) => void;
}) {
  const [current, setCurrent] = useState(0);

  if (urls.length === 0) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-white/30">
        <svg className="w-16 h-16" fill="none" viewBox="0 0 24 24" strokeWidth={0.75} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
        </svg>
        <p className="text-sm">No proof image uploaded</p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <button
        onClick={() => onClickFullscreen(current)}
        className="w-full h-full flex items-center justify-center p-4 cursor-zoom-in"
        aria-label="View proof fullscreen"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={urls[current]}
          alt={`Payment proof ${current + 1}`}
          className="max-w-full max-h-full object-contain"
          style={{ maxHeight: "calc(100vh - 3rem)" }}
        />
      </button>

      {/* Image counter */}
      {urls.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/60 backdrop-blur-sm rounded-full px-4 py-2">
          <button
            onClick={() => setCurrent((c) => Math.max(0, c - 1))}
            disabled={current === 0}
            className="text-white disabled:text-white/30 hover:text-white/80 transition-colors"
            aria-label="Previous image"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
          <span className="text-white text-xs font-medium tabular-nums">
            {current + 1} / {urls.length}
          </span>
          <button
            onClick={() => setCurrent((c) => Math.min(urls.length - 1, c + 1))}
            disabled={current === urls.length - 1}
            className="text-white disabled:text-white/30 hover:text-white/80 transition-colors"
            aria-label="Next image"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        </div>
      )}

      {/* Click hint */}
      <p className="absolute top-4 left-0 right-0 text-center text-xs text-white/30 pointer-events-none">
        Click image to view fullscreen
      </p>
    </div>
  );
}

// ── Review modal (fullscreen) ─────────────────────────────────────────────────

function ReviewModal({
  item,
  onClose,
  onApprove,
  onReject,
  onRequestRemaining,
}: {
  item: PendingItem;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
  onRequestRemaining: () => void;
}) {
  const [fullscreenImgIndex, setFullscreenImgIndex] = useState<number | null>(null);
  const [formFields, setFormFields] = useState<FormFieldDef[]>([]);
  const { enrollment, payment, class_level, intake_name, proof_signed_urls, items, total_fee_mmk } = item;
  const isCart = items != null && items.length > 0;
  const submitted = payment?.created_at ?? enrollment.enrolled_at;
  const imageUrls = proof_signed_urls?.length ? proof_signed_urls : item.proof_signed_url ? [item.proof_signed_url] : [];

  // Fetch form field definitions for dynamic labels
  useEffect(() => {
    if (!item.intake_id) return;
    fetch(`/api/public/form-fields?intake_id=${item.intake_id}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((fields: FormFieldDef[]) => setFormFields(fields.filter((f) => f.field_type !== "file")))
      .catch(() => {});
  }, [item.intake_id]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (fullscreenImgIndex !== null) { setFullscreenImgIndex(null); return; }
        onClose();
      }
      // Arrow key navigation for gallery in fullscreen
      if (fullscreenImgIndex !== null && imageUrls.length > 1) {
        if (e.key === "ArrowLeft") setFullscreenImgIndex((i) => Math.max(0, (i ?? 0) - 1));
        if (e.key === "ArrowRight") setFullscreenImgIndex((i) => Math.min(imageUrls.length - 1, (i ?? 0) + 1));
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, fullscreenImgIndex, imageUrls.length]);

  return (
    <>
      <div className="fixed inset-0 z-50 flex flex-col lg:flex-row bg-[#0f1225]">

        {/* ── Close button ──────────────────────────────────── */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          aria-label="Close review"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* ── LEFT: Proof image panel with gallery ──────────── */}
        <div className="flex-1 flex flex-col items-center justify-center bg-[#080d1a] relative min-h-[40vh] lg:min-h-full overflow-hidden">
          <ImageGallery
            urls={imageUrls}
            onClickFullscreen={(index) => setFullscreenImgIndex(index)}
          />
        </div>

        {/* ── RIGHT: Student info + actions ─────────────────── */}
        <div className="w-full lg:w-96 lg:shrink-0 flex flex-col bg-[#0f1225] border-t lg:border-t-0 lg:border-l border-white/10 overflow-y-auto">

          {/* Header */}
          <div className="px-6 pt-6 pb-4 border-b border-white/10">
            <div className="flex items-center gap-3">
              {isCart && items ? (
                <div className="flex items-center gap-1 flex-wrap shrink-0">
                  {items.map((ci, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center justify-center px-2 h-8 rounded-lg text-xs font-bold text-white"
                      style={{ backgroundColor: ticketColor(ci.class_level) }}
                    >
                      {ci.class_level}&times;{ci.quantity}
                    </span>
                  ))}
                </div>
              ) : (
                <span
                  className="inline-flex items-center justify-center px-3 h-10 rounded-xl text-white text-sm font-bold shrink-0 whitespace-nowrap"
                  style={{ backgroundColor: ticketColor(class_level) }}
                >
                  {class_level}
                </span>
              )}
              <div className="min-w-0">
                <p className="text-white font-bold truncate">{enrollment.student_name_en}</p>
                {enrollment.student_name_mm && (
                  <p className="text-white/50 text-xs font-myanmar truncate mt-0.5">
                    {enrollment.student_name_mm}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Info rows */}
          <div className="px-6 py-5 space-y-4 flex-1">
            <InfoRow label="Enrollment Ref">
              <code className="font-mono text-sm text-[#0891b2] font-semibold">
                {enrollment.enrollment_ref}
              </code>
            </InfoRow>

            {/* Dynamic form fields OR legacy fallback */}
            {formFields.length > 0 && enrollment.form_data ? (
              formFields.map((f) => {
                const val = enrollment.form_data?.[f.field_key];
                if (!val) return null;
                const isMyanmar = f.field_label.toLowerCase().includes("myanmar");
                return (
                  <InfoRow key={f.field_key} label={f.field_label}>
                    <span className={`${isMyanmar ? "font-myanmar" : ""} ${f.field_type === "phone" ? "tabular-nums" : ""}`}>
                      {f.field_type === "checkbox" ? (val === "true" ? "Yes" : "No") : val}
                    </span>
                  </InfoRow>
                );
              })
            ) : (
              <>
                {enrollment.nrc_number && (
                  <InfoRow label="NRC Number">{enrollment.nrc_number}</InfoRow>
                )}
                <InfoRow label="Phone">
                  <span className="tabular-nums">{enrollment.phone}</span>
                </InfoRow>
                {enrollment.email && (
                  <InfoRow label="Email">{enrollment.email}</InfoRow>
                )}
              </>
            )}

            <div className="border-t border-white/10 pt-4 space-y-4">
              {isCart && items ? (
                <div>
                  <p className="text-xs text-white/35 mb-2">Ticket Breakdown</p>
                  <div className="rounded-lg bg-white/5 border border-white/10 p-3 space-y-1.5">
                    {items.map((ci, i) => (
                      <div key={i} className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1.5 text-white/70">
                          <span
                            className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-bold text-white"
                            style={{ backgroundColor: ticketColor(ci.class_level) }}
                          >
                            {ci.class_level}
                          </span>
                          &times; {ci.quantity}
                        </span>
                        <span className="text-white font-medium">{formatMMKSimple(ci.subtotal_mmk)}</span>
                      </div>
                    ))}
                    <div className="border-t border-white/10 pt-1.5 flex justify-between text-sm font-semibold">
                      <span className="text-white/50">
                        Total ({items.reduce((s, i) => s + i.quantity, 0)} tickets)
                      </span>
                      <span style={{ color: "#b07d2a" }}>{formatMMKSimple(total_fee_mmk)}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <InfoRow label="Class Level">
                  <span
                    className="inline-flex items-center justify-center px-2 h-7 rounded-lg text-xs font-bold text-white whitespace-nowrap"
                    style={{ backgroundColor: ticketColor(class_level) }}
                  >
                    {class_level}
                  </span>
                </InfoRow>
              )}
              <InfoRow label="Intake">{intake_name || "—"}</InfoRow>
              <InfoRow label="Enrollment Status">
                <StatusBadge status={enrollment.status} />
              </InfoRow>
              <InfoRow label="Receipts Uploaded">
                <span className="text-white/70">{imageUrls.length} image{imageUrls.length !== 1 ? "s" : ""}</span>
              </InfoRow>
            </div>

            {payment && (
              <div className="border-t border-white/10 pt-4 space-y-4">
                <InfoRow label="Amount">
                  <span className="text-2xl font-bold" style={{ color: "#b07d2a" }}>
                    {formatMMKSimple(payment.amount_mmk)}
                  </span>
                </InfoRow>
                {payment.bank_reference && (
                  <InfoRow label="Bank Reference">
                    <code className="text-sm text-white/70">{payment.bank_reference}</code>
                  </InfoRow>
                )}
                <InfoRow label="Submitted">
                  <span className="text-white/70">{timeAgo(submitted)}</span>
                </InfoRow>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="px-6 pb-6 pt-2 space-y-3 border-t border-white/10">
            {/* Approve */}
            <button
              onClick={onApprove}
              className="flex items-center justify-center gap-2.5 w-full py-3.5 bg-[#1a6b3c] hover:bg-green-700 text-white text-base font-bold rounded-2xl transition-colors shadow-lg shadow-[#1a6b3c]/30"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              Approve Payment
            </button>

            {/* Request Remaining */}
            <button
              onClick={onRequestRemaining}
              className="flex items-center justify-center gap-2.5 w-full py-3.5 bg-white/5 hover:bg-[#b07d2a] text-[#b07d2a] hover:text-white text-base font-bold rounded-2xl border border-[#b07d2a]/40 hover:border-[#b07d2a] transition-all"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Request Remaining
            </button>

            {/* Reject */}
            <button
              onClick={onReject}
              className="flex items-center justify-center gap-2.5 w-full py-3.5 bg-white/5 hover:bg-[#c0392b] text-white/70 hover:text-white text-base font-bold rounded-2xl border border-white/10 hover:border-[#c0392b] transition-all"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
              Reject Payment
            </button>
          </div>
        </div>
      </div>

      {/* Fullscreen image overlay with gallery navigation */}
      {fullscreenImgIndex !== null && imageUrls[fullscreenImgIndex] && (
        <div
          className="fixed inset-0 z-[60] bg-black flex items-center justify-center"
          onClick={() => setFullscreenImgIndex(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrls[fullscreenImgIndex]}
            alt={`Payment proof ${fullscreenImgIndex + 1} fullscreen`}
            className="max-w-full max-h-full object-contain cursor-zoom-out"
            onClick={(e) => e.stopPropagation()}
          />

          {/* Navigation arrows */}
          {imageUrls.length > 1 && (
            <>
              {fullscreenImgIndex > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); setFullscreenImgIndex(fullscreenImgIndex - 1); }}
                  className="absolute left-4 top-1/2 -translate-y-1/2 p-3 bg-white/20 hover:bg-white/30 rounded-full text-white transition-colors"
                  aria-label="Previous image"
                >
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                  </svg>
                </button>
              )}
              {fullscreenImgIndex < imageUrls.length - 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); setFullscreenImgIndex(fullscreenImgIndex + 1); }}
                  className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-white/20 hover:bg-white/30 rounded-full text-white transition-colors"
                  aria-label="Next image"
                >
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>
                </button>
              )}
              <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-sm rounded-full px-4 py-2 text-white text-sm font-medium tabular-nums">
                {fullscreenImgIndex + 1} / {imageUrls.length}
              </div>
            </>
          )}

          <button
            onClick={() => setFullscreenImgIndex(null)}
            className="absolute top-4 right-4 p-2 bg-white/20 hover:bg-white/30 rounded-full text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-white/35 mb-0.5">{label}</p>
      <div className="text-sm text-white">{children}</div>
    </div>
  );
}

// ── Payments Page ─────────────────────────────────────────────────────────────

export default function PaymentsPage() {
  const toast = useToast();
  const [queue, setQueue] = useState<PendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal states
  const [reviewItem, setReviewItem] = useState<PendingItem | null>(null);
  const [approvingItem, setApprovingItem] = useState<PendingItem | null>(null);
  const [rejectingItem, setRejectingItem] = useState<PendingItem | null>(null);
  const [requestRemainingItem, setRequestRemainingItem] = useState<PendingItem | null>(null);
  const [approving, setApproving] = useState(false);
  const approvingRef = useRef(false);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/payments/pending");
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as PendingItem[];
      setQueue(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load payment queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  // ── Remove item from queue (after approve/reject/request_remaining) ────
  function removeFromQueue(enrollmentId: string) {
    setQueue((prev) => prev.filter((p) => p.enrollment.id !== enrollmentId));
    setReviewItem(null);
    setApprovingItem(null);
    setRejectingItem(null);
    setRequestRemainingItem(null);
  }

  // ── Approve ───────────────────────────────────────────────────────────────
  async function handleApprove() {
    if (approvingRef.current) return;
    if (!approvingItem?.payment) return;
    approvingRef.current = true;
    setApproving(true);
    try {
      const res = await fetch(`/api/admin/payments/${approvingItem.payment.id}/verify`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? `${res.status}`);
      }
      toast.success(`Payment approved for ${approvingItem.enrollment.student_name_en}.`);
      removeFromQueue(approvingItem.enrollment.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approval failed.");
      setApprovingItem(null);
    } finally {
      approvingRef.current = false;
      setApproving(false);
    }
  }

  // ── Open review modal ──────────────────────────────────────────────────────
  function openReview(item: PendingItem) {
    setReviewItem(item);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#f0f4ff] px-6 py-8 lg:px-8">

      {/* Header */}
      <div className="flex items-start justify-between mb-8 gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900 leading-tight">
              Payment Queue
            </h1>
            {!loading && queue.length > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full bg-[#b07d2a] text-white text-xs font-bold">
                {queue.length}
              </span>
            )}
          </div>
          <p className="text-sm font-myanmar text-gray-400 mt-0.5">ငွေပေးချေမှု စစ်ဆေးရန်</p>
        </div>

        <button
          onClick={fetchQueue}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 disabled:opacity-50 transition-colors shadow-sm shrink-0"
        >
          <svg className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Error state */}
      {!loading && error && (
        <div className="bg-white rounded-2xl border border-red-100 shadow-sm p-10 flex flex-col items-center gap-3 text-center">
          <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center">
            <svg className="w-6 h-6 text-[#c0392b]" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
          </div>
          <p className="text-sm text-gray-600">{error}</p>
          <button
            onClick={fetchQueue}
            className="px-4 py-2 bg-[#1a3f8a] text-white text-sm rounded-lg"
          >
            Retry
          </button>
        </div>
      )}

      {/* Card grid */}
      {(loading || (!error && queue.length > 0)) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {loading
            ? Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)
            : queue.map((item) => (
                <PaymentCard
                  key={item.enrollment.id}
                  item={item}
                  onClick={() => openReview(item)}
                />
              ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && queue.length === 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm">
          <EmptyState
            icon="🎉"
            title="No pending payments"
            description="All caught up! New submissions will appear here when students upload payment proof."
            action={
              <button
                onClick={fetchQueue}
                className="px-4 py-2 text-sm text-[#1a3f8a] border border-[#1a3f8a]/30 rounded-lg hover:bg-[#1a3f8a] hover:text-white transition-colors"
              >
                Check again
              </button>
            }
          />
        </div>
      )}

      {/* ── Review modal ──────────────────────────────────────────── */}
      {reviewItem && (
        <ReviewModal
          item={reviewItem}
          onClose={() => setReviewItem(null)}
          onApprove={() => setApprovingItem(reviewItem)}
          onReject={() => setRejectingItem(reviewItem)}
          onRequestRemaining={() => setRequestRemainingItem(reviewItem)}
        />
      )}

      {/* ── Approve confirmation modal ────────────────────────────── */}
      {approvingItem && (
        <ConfirmModal
          variant="success"
          title="Approve this payment?"
          message={`Confirm approval for ${approvingItem.enrollment.student_name_en} — ${approvingItem.payment ? formatMMKSimple(approvingItem.payment.amount_mmk) : "unknown amount"}. This will set their enrollment to Confirmed.`}
          confirmLabel={approving ? "Approving…" : "✓ Approve"}
          onConfirm={handleApprove}
          onCancel={() => setApprovingItem(null)}
        />
      )}

      {/* ── Reject reason modal ───────────────────────────────────── */}
      {rejectingItem && (
        <RejectModal
          item={rejectingItem}
          onClose={() => setRejectingItem(null)}
          onRejected={(enrollmentId) => {
            removeFromQueue(enrollmentId);
          }}
        />
      )}

      {/* ── Request Remaining modal ──────────────────────────────── */}
      {requestRemainingItem && (
        <RequestRemainingModal
          item={requestRemainingItem}
          onClose={() => setRequestRemainingItem(null)}
          onDone={(enrollmentId) => {
            removeFromQueue(enrollmentId);
          }}
        />
      )}
    </div>
  );
}
