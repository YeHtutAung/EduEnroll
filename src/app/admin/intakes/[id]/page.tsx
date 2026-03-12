"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import StatusBadge from "@/components/ui/StatusBadge";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { useToast } from "@/components/ui/Toast";
import { formatMMKSimple } from "@/lib/utils";
import { useTenantLabels } from "@/components/admin/TenantLabelsContext";
import { useRole } from "@/components/admin/RoleContext";
import { createClient } from "@/lib/supabase/client";
import type { Class, ClassMode, ClassStatus, Intake, IntakeStatus } from "@/types/database";

// ── Constants ─────────────────────────────────────────────────────────────────

const JLPT_LEVELS: string[] = ["N5", "N4", "N3", "N2", "N1"];

const DEFAULT_FEES: Record<string, number> = {
  N5: 300_000,
  N4: 350_000,
  N3: 400_000,
  N2: 450_000,
  N1: 500_000,
};

const LEVEL_COLORS: Record<string, string> = {
  N5: "#1a6b3c",
  N4: "#0891b2",
  N3: "#1a3f8a",
  N2: "#b07d2a",
  N1: "#c0392b",
};

const DEFAULT_LEVEL_COLOR = "#6b7280";

// ── Helpers ───────────────────────────────────────────────────────────────────

function intakeToSlug(intake: Intake): string {
  // Use stored slug if available, otherwise derive from name
  if (intake.slug) return intake.slug;
  const firstWord = intake.name.split(" ")[0].toLowerCase();
  return `${firstWord}-${intake.year}`;
}

function fmtDate(isoStr: string | null | undefined): string {
  if (!isoStr) return "—";
  return new Date(isoStr).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function toDatetimeLocal(isoStr: string | null | undefined): string {
  if (!isoStr) return "";
  // Convert UTC ISO string to local datetime-local format (YYYY-MM-DDTHH:mm)
  const d = new Date(isoStr);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocal(val: string): string | null {
  if (!val) return null;
  return new Date(val).toISOString();
}

function seatColor(remaining: number, total: number): string {
  if (total === 0) return "text-gray-400";
  const pct = ((total - remaining) / total) * 100;
  if (remaining === 0) return "text-[#c0392b] font-semibold";
  if (pct > 80) return "text-[#b07d2a] font-semibold";
  return "text-[#1a6b3c]";
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Pulse({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-gray-200 ${className}`} />;
}

function ClassRowSkeleton() {
  return (
    <tr>
      <td className="px-5 py-4"><Pulse className="h-6 w-10 rounded-lg" /></td>
      <td className="px-5 py-4"><Pulse className="h-4 w-28" /></td>
      <td className="px-5 py-4"><Pulse className="h-4 w-12" /></td>
      <td className="px-5 py-4"><Pulse className="h-4 w-40" /></td>
      <td className="px-5 py-4"><Pulse className="h-5 w-16 rounded-full" /></td>
      <td className="px-5 py-4"><Pulse className="h-8 w-16 rounded-lg" /></td>
    </tr>
  );
}

// ── Edit Class Modal ──────────────────────────────────────────────────────────

interface EditForm {
  fee_mmk: string;
  seat_total: string;
  enrollment_open_at: string;
  enrollment_close_at: string;
  status: ClassStatus;
  mode: ClassMode;
  event_date: string;
  start_time: string;
  end_time: string;
  venue: string;
  max_tickets_per_person: string;
}

function classToForm(cls: Class): EditForm {
  return {
    fee_mmk: String(cls.fee_mmk),
    seat_total: String(cls.seat_total),
    enrollment_open_at: toDatetimeLocal(cls.enrollment_open_at),
    enrollment_close_at: toDatetimeLocal(cls.enrollment_close_at),
    status: cls.status,
    mode: cls.mode ?? "offline",
    event_date: cls.event_date ?? "",
    start_time: cls.start_time ?? "",
    end_time: cls.end_time ?? "",
    venue: cls.venue ?? "",
    max_tickets_per_person: String(cls.max_tickets_per_person ?? 1),
  };
}

function EditClassModal({
  cls,
  onClose,
  onSaved,
  showEventFields,
}: {
  cls: Class;
  onClose: () => void;
  onSaved: (updated: Class) => void;
  showEventFields: boolean;
}) {
  const toast = useToast();
  const tl = useTenantLabels();
  const [form, setForm] = useState<EditForm>(() => classToForm(cls));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(cls.image_url ?? null);
  const [removeImageFlag, setRemoveImageFlag] = useState(false);

  function set(key: keyof EditForm, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast.error("Image must be under 5 MB."); return; }
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
    setRemoveImageFlag(false);
  }

  function removeImage() {
    setImageFile(null);
    setImagePreview(null);
    setRemoveImageFlag(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    const fee = Number(form.fee_mmk);
    const seats = Number(form.seat_total);
    if (!fee || fee <= 0) { toast.error("Fee must be a positive number."); return; }
    if (!seats || seats < 1 || !Number.isInteger(seats)) { toast.error("Seats must be a positive integer."); return; }

    savingRef.current = true;
    setSaving(true);
    try {
      // Upload new image if provided
      let image_url: string | null | undefined = undefined;
      if (imageFile) {
        const supabase = createClient();
        const ext = imageFile.name.split(".").pop() ?? "png";
        const path = `${cls.intake_id}/${cls.level.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}.${ext}`;
        const { error: uploadErr } = await supabase.storage
          .from("class-images")
          .upload(path, imageFile, { upsert: true });
        if (uploadErr) throw new Error("Image upload failed: " + uploadErr.message);
        const { data: urlData } = supabase.storage
          .from("class-images")
          .getPublicUrl(path);
        image_url = urlData.publicUrl;
      } else if (removeImageFlag) {
        image_url = null;
      }

      const maxTix = Number(form.max_tickets_per_person);
      const payload: Record<string, unknown> = {
        fee_mmk: fee,
        seat_total: seats,
        status: form.status,
        mode: form.mode,
        enrollment_open_at: fromDatetimeLocal(form.enrollment_open_at),
        enrollment_close_at: fromDatetimeLocal(form.enrollment_close_at),
        event_date: form.event_date || null,
        start_time: form.start_time || null,
        end_time: form.end_time || null,
        venue: form.venue || null,
        max_tickets_per_person: maxTix >= 1 ? maxTix : 1,
      };
      if (image_url !== undefined) {
        payload.image_url = image_url;
      }

      const res = await fetch(`/api/classes/${cls.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to update class.");
      }
      const updated = (await res.json()) as Class;
      toast.success(`${cls.level} class updated.`);
      onSaved(updated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update class.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const labelClass = "block text-sm font-medium text-gray-700 mb-1.5";
  const inputClass =
    "w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-xl p-6 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <span
            className="inline-flex items-center justify-center w-10 h-10 rounded-xl text-white text-sm font-bold shrink-0"
            style={{ backgroundColor: LEVEL_COLORS[cls.level] ?? DEFAULT_LEVEL_COLOR }}
          >
            {cls.level}
          </span>
          <div>
            <h2 className="text-lg font-bold text-gray-900">Edit {cls.level} Class</h2>
            <p className="text-xs text-gray-400 mt-0.5">PATCH /api/classes/{cls.id.slice(0, 8)}…</p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Fee + Seats row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Fee (MMK)</label>
              <input
                type="number"
                value={form.fee_mmk}
                onChange={(e) => set("fee_mmk", e.target.value)}
                min={1}
                required
                className={inputClass}
                placeholder="300000"
              />
              {form.fee_mmk && Number(form.fee_mmk) > 0 && (
                <p className="mt-1 text-xs text-gray-400">
                  = {formatMMKSimple(Number(form.fee_mmk))}
                </p>
              )}
            </div>
            <div>
              <label className={labelClass}>Total Seats</label>
              <input
                type="number"
                value={form.seat_total}
                onChange={(e) => set("seat_total", e.target.value)}
                min={1}
                step={1}
                required
                className={inputClass}
                placeholder="30"
              />
              <p className="mt-1 text-xs text-gray-400">
                {cls.seat_total - cls.seat_remaining} taken · {cls.seat_remaining} remaining
              </p>
            </div>
          </div>

          {/* Enrollment window */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Enrollment Opens</label>
              <input
                type="datetime-local"
                value={form.enrollment_open_at}
                onChange={(e) => set("enrollment_open_at", e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Enrollment Closes</label>
              <input
                type="datetime-local"
                value={form.enrollment_close_at}
                onChange={(e) => set("enrollment_close_at", e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          {/* Status */}
          <div>
            <label className={labelClass}>Status</label>
            <select
              value={form.status}
              onChange={(e) => set("status", e.target.value)}
              className={`${inputClass} bg-white`}
            >
              <option value="draft">Draft — not visible to public</option>
              <option value="open">Open — accepting enrollments</option>
              <option value="full">Full — no seats remaining</option>
              <option value="closed">Closed — enrollment ended</option>
            </select>
          </div>

          {/* Mode toggle — hidden for event org */}
          {tl.orgType !== "event" && (
            <div>
              <label className={labelClass}>Class Mode</label>
              <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                <button
                  type="button"
                  onClick={() => set("mode", "offline")}
                  className={`px-4 py-2 text-sm font-medium transition-colors ${
                    form.mode === "offline"
                      ? "bg-[#6d28d9] text-white"
                      : "bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  🏫 Offline
                </button>
                <button
                  type="button"
                  onClick={() => set("mode", "online")}
                  className={`px-4 py-2 text-sm font-medium transition-colors ${
                    form.mode === "online"
                      ? "bg-[#6d28d9] text-white"
                      : "bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  💻 Online
                </button>
              </div>
            </div>
          )}

          {/* Event fields — shown for non-language-school org types */}
          {showEventFields && (
            <>
              <div className="border-t border-gray-100 pt-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Event Details</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>Start Date</label>
                    <input
                      type="date"
                      value={form.event_date}
                      onChange={(e) => set("event_date", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>End Date</label>
                    <input
                      type="date"
                      value={form.end_time}
                      onChange={(e) => set("end_time", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>
              </div>
              <div>
                <label className={labelClass}>Venue</label>
                <input
                  type="text"
                  value={form.venue}
                  onChange={(e) => set("venue", e.target.value)}
                  className={inputClass}
                  placeholder="e.g. Room 101, Main Building"
                />
              </div>
              <div>
                <label className={labelClass}>Max Tickets Per Person</label>
                <input
                  type="number"
                  min={1}
                  value={form.max_tickets_per_person}
                  onChange={(e) => set("max_tickets_per_person", e.target.value)}
                  className={inputClass}
                  placeholder="1"
                />
                <p className="text-xs text-gray-400 mt-1">How many tickets one person can buy at once.</p>
              </div>
            </>
          )}

          {/* Image upload (optional) */}
          <div>
            <label className={labelClass}>Image (optional)</label>
            {imagePreview ? (
              <div className="relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imagePreview}
                  alt="Preview"
                  className="h-32 w-auto rounded-lg border border-gray-200 object-cover"
                />
                <button
                  type="button"
                  onClick={removeImage}
                  className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white text-xs hover:bg-red-600 transition-colors"
                >
                  ✕
                </button>
              </div>
            ) : (
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-gray-300 px-4 py-3 text-sm text-gray-500 hover:border-[#1a3f8a] hover:text-[#1a3f8a] transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
                </svg>
                Upload image (max 5 MB)
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleImageChange}
                  className="hidden"
                />
              </label>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 px-4 py-2.5 bg-[#1a3f8a] text-white rounded-xl text-sm font-medium hover:bg-blue-900 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Add Custom Class Modal ───────────────────────────────────────────────────

interface AddCustomForm {
  level: string;
  fee_mmk: string;
  seat_total: string;
  mode: ClassMode;
  event_date: string;
  start_time: string;
  end_time: string;
  venue: string;
}

function AddCustomClassModal({
  intakeId,
  onClose,
  onCreated,
  showEventFields,
}: {
  intakeId: string;
  onClose: () => void;
  onCreated: () => void;
  showEventFields: boolean;
}) {
  const toast = useToast();
  const tl = useTenantLabels();
  const [form, setForm] = useState<AddCustomForm>({
    level: "",
    fee_mmk: "",
    seat_total: "30",
    mode: "offline",
    event_date: "",
    start_time: "",
    end_time: "",
    venue: "",
  });
  const [saving, setSaving] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  function set(key: keyof AddCustomForm, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file) { setImageFile(null); setImagePreview(null); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error("Image must be under 5 MB."); return; }
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  }

  function removeImage() {
    setImageFile(null);
    setImagePreview(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const level = form.level.trim();
    const fee = Number(form.fee_mmk);
    const seats = Number(form.seat_total);
    if (!level) { toast.error("Level name is required."); return; }
    if (!fee || fee <= 0) { toast.error("Fee must be a positive number."); return; }
    if (!seats || seats < 1 || !Number.isInteger(seats)) { toast.error("Seats must be a positive integer."); return; }

    setSaving(true);
    try {
      // Upload image if provided
      let image_url: string | null = null;
      if (imageFile) {
        const supabase = createClient();
        const ext = imageFile.name.split(".").pop() ?? "png";
        const path = `${intakeId}/${level.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}.${ext}`;
        const { error: uploadErr } = await supabase.storage
          .from("class-images")
          .upload(path, imageFile, { upsert: true });
        if (uploadErr) throw new Error("Image upload failed: " + uploadErr.message);
        const { data: urlData } = supabase.storage
          .from("class-images")
          .getPublicUrl(path);
        image_url = urlData.publicUrl;
      }

      const res = await fetch(`/api/intakes/${intakeId}/classes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level,
          fee_mmk: fee,
          seat_total: seats,
          status: "draft",
          mode: form.mode,
          event_date: form.event_date || null,
          start_time: form.start_time || null,
          end_time: form.end_time || null,
          venue: form.venue || null,
          image_url,
        }),
      });
      if (res.status === 409) {
        toast.error(`A "${level}" class already exists for this intake.`);
        return;
      }
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to create class.");
      }
      toast.success(`"${level}" class created.`);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create class.");
    } finally {
      setSaving(false);
    }
  }

  const labelClass = "block text-sm font-medium text-gray-700 mb-1.5";
  const inputClass =
    "w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-[#1a3f8a] flex items-center justify-center text-white shrink-0">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-900">Add Custom {tl.class}</h2>
            <p className="text-xs text-gray-400 mt-0.5">Create a {tl.class.toLowerCase()} with any name</p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className={labelClass}>{tl.class} Name</label>
            <input
              type="text"
              value={form.level}
              onChange={(e) => set("level", e.target.value)}
              required
              className={inputClass}
              placeholder={tl.orgType === "language_school"
                ? "e.g. Beginner A, Business Japanese, N5-Prep"
                : tl.orgType === "event"
                  ? "e.g. VIP, Standard, Early Bird"
                  : "e.g. Basic, Premium, Group"}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Fee (MMK)</label>
              <input
                type="number"
                value={form.fee_mmk}
                onChange={(e) => set("fee_mmk", e.target.value)}
                min={1}
                required
                className={inputClass}
                placeholder="300000"
              />
              {form.fee_mmk && Number(form.fee_mmk) > 0 && (
                <p className="mt-1 text-xs text-gray-400">
                  = {formatMMKSimple(Number(form.fee_mmk))}
                </p>
              )}
            </div>
            <div>
              <label className={labelClass}>Total Seats</label>
              <input
                type="number"
                value={form.seat_total}
                onChange={(e) => set("seat_total", e.target.value)}
                min={1}
                step={1}
                required
                className={inputClass}
                placeholder="30"
              />
            </div>
          </div>

          {tl.orgType !== "event" && (
            <div>
              <label className={labelClass}>Class Mode</label>
              <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                <button
                  type="button"
                  onClick={() => set("mode", "offline")}
                  className={`px-4 py-2 text-sm font-medium transition-colors ${
                    form.mode === "offline"
                      ? "bg-[#6d28d9] text-white"
                      : "bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  🏫 Offline
                </button>
                <button
                  type="button"
                  onClick={() => set("mode", "online")}
                  className={`px-4 py-2 text-sm font-medium transition-colors ${
                    form.mode === "online"
                      ? "bg-[#6d28d9] text-white"
                      : "bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  💻 Online
                </button>
              </div>
            </div>
          )}

          {/* Event fields — shown for non-language-school org types */}
          {showEventFields && (
            <>
              <div className="border-t border-gray-100 pt-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Event Details</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>Start Date</label>
                    <input
                      type="date"
                      value={form.event_date}
                      onChange={(e) => set("event_date", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>End Date</label>
                    <input
                      type="date"
                      value={form.end_time}
                      onChange={(e) => set("end_time", e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>
              </div>
              <div>
                <label className={labelClass}>Venue</label>
                <input
                  type="text"
                  value={form.venue}
                  onChange={(e) => set("venue", e.target.value)}
                  className={inputClass}
                  placeholder="e.g. Room 101, Main Building"
                />
              </div>
            </>
          )}

          {/* Image upload (optional) */}
          <div>
            <label className={labelClass}>Image (optional)</label>
            {imagePreview ? (
              <div className="relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imagePreview}
                  alt="Preview"
                  className="h-32 w-auto rounded-lg border border-gray-200 object-cover"
                />
                <button
                  type="button"
                  onClick={removeImage}
                  className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white text-xs hover:bg-red-600 transition-colors"
                >
                  ✕
                </button>
              </div>
            ) : (
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-gray-300 px-4 py-3 text-sm text-gray-500 hover:border-[#1a3f8a] hover:text-[#1a3f8a] transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
                </svg>
                Upload image (max 5 MB)
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleImageChange}
                  className="hidden"
                />
              </label>
            )}
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 px-4 py-2.5 bg-[#1a3f8a] text-white rounded-xl text-sm font-medium hover:bg-blue-900 disabled:opacity-50 transition-colors"
            >
              {saving ? "Creating…" : `Create ${tl.class}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Intake Detail Page ────────────────────────────────────────────────────────

export default function IntakeDetailPage({
  params,
}: {
  params: { id: string };
}) {
  if (params.id === "new") redirect("/admin/intakes/new");

  const toast = useToast();
  const tl = useTenantLabels();
  const role = useRole();
  const isOwner = role === "owner";
  const [intake, setIntake] = useState<Intake | null>(null);
  const [classes, setClasses] = useState<Class[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingClass, setEditingClass] = useState<Class | null>(null);
  const [addingClasses, setAddingClasses] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmAddAll, setConfirmAddAll] = useState(false);
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editingIntake, setEditingIntake] = useState(false);
  const [editName, setEditName] = useState("");
  const [editYear, setEditYear] = useState(new Date().getFullYear());
  const [savingIntake, setSavingIntake] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [iRes, cRes] = await Promise.all([
        fetch(`/api/intakes/${params.id}`),
        fetch(`/api/intakes/${params.id}/classes`),
      ]);
      if (!iRes.ok) throw new Error(`Failed to fetch intake (${iRes.status})`);
      if (!cRes.ok) throw new Error(`Failed to fetch classes (${cRes.status})`);
      const [intakeData, classesData] = await Promise.all([iRes.json(), cRes.json()]);
      setIntake(intakeData as Intake);
      setClasses(classesData as Class[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data.");
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Add All 5 Classes ───────────────────────────────────────────────────────

  async function handleAddAllClasses() {
    setAddingClasses(true);
    setConfirmAddAll(false);
    const results = await Promise.allSettled(
      JLPT_LEVELS.map((level) =>
        fetch(`/api/intakes/${params.id}/classes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            level,
            fee_mmk: DEFAULT_FEES[level],
            seat_total: 30,
            status: "draft",
          }),
        }).then(async (r) => {
          if (r.status === 409) return { skipped: true, level };
          if (!r.ok) throw new Error(`${level}: ${r.status}`);
          return { skipped: false, level };
        }),
      ),
    );

    const created = results.filter(
      (r) => r.status === "fulfilled" && !r.value.skipped,
    ).length;
    const skipped = results.filter(
      (r) => r.status === "fulfilled" && r.value.skipped,
    ).length;
    const failed  = results.filter((r) => r.status === "rejected").length;

    if (failed > 0) {
      toast.error(`${failed} class(es) failed to create.`);
    } else if (skipped > 0 && created === 0) {
      toast.info("All classes already exist.");
    } else if (skipped > 0) {
      toast.success(`${created} class(es) created. ${skipped} already existed.`);
    } else {
      toast.success("All 5 classes created with default fees and 30 seats each.");
    }

    await fetchData();
    setAddingClasses(false);
  }

  // ── Copy Enrollment Link ────────────────────────────────────────────────────

  async function handleCopyLink() {
    if (!intake) return;
    const slug = intakeToSlug(intake);
    const url = `${window.location.origin}/enroll/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Enrollment link copied!");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy. Try manually: " + url);
    }
  }

  async function handleCopyClassLink(level: string) {
    if (!intake) return;
    const slug = intakeToSlug(intake);
    const url = `${window.location.origin}/enroll/${slug}?level=${level}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(`${level} enrollment link copied!`);
    } catch {
      toast.error("Failed to copy. Try manually: " + url);
    }
  }

  // ── Change Intake Status ────────────────────────────────────────────────────

  async function handleStatusChange(newStatus: IntakeStatus) {
    setUpdatingStatus(true);
    setConfirmOpen(false);
    try {
      const res = await fetch(`/api/intakes/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to update status.");
      }
      const updated = (await res.json()) as Intake;
      setIntake(updated);
      toast.success(`Status changed to "${newStatus}".`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update status.");
    } finally {
      setUpdatingStatus(false);
    }
  }

  function requestStatusChange(newStatus: IntakeStatus) {
    if (newStatus === "open") {
      setConfirmOpen(true);
    } else {
      handleStatusChange(newStatus);
    }
  }

  // ── Edit Intake ─────────────────────────────────────────────────────────────

  function openEditIntake() {
    if (!intake) return;
    setEditName(intake.name);
    setEditYear(intake.year);
    setEditingIntake(true);
  }

  async function handleSaveIntake(e: React.FormEvent) {
    e.preventDefault();
    if (!editName.trim()) { toast.error("Name is required."); return; }
    if (!editYear || editYear < 2020 || editYear > 2100) { toast.error("Year must be between 2020 and 2100."); return; }
    setSavingIntake(true);
    try {
      const res = await fetch(`/api/intakes/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim(), year: editYear }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to update.");
      }
      const updated = (await res.json()) as Intake;
      setIntake(updated);
      setEditingIntake(false);
      toast.success(`${tl.intake} updated.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update.");
    } finally {
      setSavingIntake(false);
    }
  }

  // ── Error state ─────────────────────────────────────────────────────────────
  if (!loading && error) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 p-8">
        <p className="text-gray-500 text-sm">{error}</p>
        <div className="flex gap-3">
          <Link
            href="/admin/intakes"
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 transition-colors"
          >
            ← Back to Intakes
          </Link>
          <button
            onClick={fetchData}
            className="px-4 py-2 bg-[#1a3f8a] text-white rounded-lg text-sm"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const allDefaultsExist = JLPT_LEVELS.every((l) => classes.some((c) => c.level === l));

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#f0f4ff] px-6 py-8 lg:px-8">

      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-6">
        <Link href="/admin/intakes" className="hover:text-[#1a3f8a] transition-colors">
          {tl.intake}s
        </Link>
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
        <span className="text-gray-600 font-medium">
          {loading ? "…" : (intake?.name ?? tl.intake)}
        </span>
      </div>

      {/* Intake header card */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-6 py-5 mb-6">
        {loading ? (
          <div className="flex items-center justify-between">
            <div className="space-y-2">
              <Pulse className="h-6 w-56" />
              <Pulse className="h-4 w-20 rounded-full" />
            </div>
            <div className="flex gap-2">
              <Pulse className="h-9 w-36 rounded-xl" />
              <Pulse className="h-9 w-32 rounded-xl" />
            </div>
          </div>
        ) : intake ? (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div
                className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-white font-bold text-lg"
                style={{ backgroundColor: "#1a3f8a" }}
              >
                {intake.name.charAt(0)}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-bold text-gray-900 leading-tight">
                    {intake.name}
                  </h1>
                  {isOwner && (
                    <button
                      onClick={openEditIntake}
                      title={`Edit ${tl.intake}`}
                      className="p-1 rounded-md text-gray-400 hover:text-[#1a3f8a] hover:bg-blue-50 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                      </svg>
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <StatusBadge status={intake.status} />
                  {isOwner && <select
                    value={intake.status}
                    onChange={(e) => requestStatusChange(e.target.value as IntakeStatus)}
                    disabled={updatingStatus}
                    className={`text-xs font-medium rounded-lg border px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent transition-colors disabled:opacity-50 ${
                      intake.status === "open"
                        ? "border-emerald-300 text-emerald-700"
                        : intake.status === "closed"
                          ? "border-red-300 text-red-600"
                          : "border-gray-300 text-gray-600"
                    }`}
                  >
                    <option value="draft">Draft</option>
                    <option value="open">Open</option>
                    <option value="closed">Closed</option>
                  </select>}
                  <span className="text-xs text-gray-400">·</span>
                  <span className="text-xs text-gray-500">{intake.year}</span>
                  <span className="text-xs text-gray-400">·</span>
                  <span className="text-xs text-gray-500">
                    {classes.length} {tl.class.toLowerCase()}{classes.length !== 1 ? "s" : ""} configured
                  </span>
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Copy Enrollment Link */}
              <button
                onClick={handleCopyLink}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border transition-all ${
                  copied
                    ? "bg-[#1a6b3c] border-[#1a6b3c] text-white"
                    : "bg-white border-gray-300 text-gray-700 hover:border-[#0891b2] hover:text-[#0891b2]"
                }`}
              >
                {copied ? (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                    Copied!
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
                    </svg>
                    Copy Enrollment Link
                  </>
                )}
              </button>

              {/* Add Default Classes (N5–N1) — language_school only, owner only */}
              {isOwner && tl.orgType === "language_school" && !allDefaultsExist && (
                <button
                  onClick={() => setConfirmAddAll(true)}
                  disabled={addingClasses}
                  className="flex items-center gap-2 px-4 py-2 bg-[#1a3f8a] text-white rounded-xl text-sm font-medium hover:bg-blue-900 disabled:opacity-60 transition-colors shadow-sm"
                >
                  {addingClasses ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Adding Classes…
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                      </svg>
                      Add Default Classes (N5–N1)
                    </>
                  )}
                </button>
              )}

              {/* Add Custom Class — owner only */}
              {isOwner && (
                <button
                  onClick={() => setShowAddCustom(true)}
                  className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm font-medium hover:border-[#1a3f8a] hover:text-[#1a3f8a] transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  + Add Custom {tl.class}
                </button>
              )}
            </div>
          </div>
        ) : null}

        {/* Enrollment link hint */}
        {intake && (
          <div className="mt-4 pt-4 border-t border-gray-100 flex items-center gap-2">
            <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
            </svg>
            <p className="text-xs text-gray-400">
              Public enrollment URL:{" "}
              <code className="font-mono text-[#0891b2]">
                {typeof window !== "undefined" ? window.location.origin : ""}/enroll/{intakeToSlug(intake)}
              </code>
              {intake.status !== "open" && (
                <span className="ml-1.5 text-amber-600">(only works when intake is Open)</span>
              )}
            </p>
          </div>
        )}
      </div>

      {/* Classes table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wider">
            {tl.class}s
          </h2>
          <p className="text-xs text-gray-400 font-myanmar mt-0.5">
            {classes.length > 0
              ? classes.map((c) => c.level).join(" · ")
              : `No ${tl.class.toLowerCase()}s yet`}
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100 text-left">
                <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">{tl.class}</th>
                {tl.orgType !== "event" && (
                  <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Mode</th>
                )}
                <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">{tl.fee}</th>
                <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">{tl.seat}s</th>
                <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Enrollment Window</th>
                <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                Array.from({ length: 3 }).map((_, i) => <ClassRowSkeleton key={i} />)
              ) : classes.length === 0 ? (
                <tr>
                  <td colSpan={tl.orgType === "event" ? 6 : 7} className="px-5 py-12 text-center text-sm text-gray-400">
                    No {tl.class.toLowerCase()}s yet.{" "}
                    {tl.orgType === "language_school"
                      ? <>Use &ldquo;Add Default Classes (N5–N1)&rdquo; or &ldquo;+ Add Custom {tl.class}&rdquo; to get started.</>
                      : <>Use &ldquo;+ Add Custom {tl.class}&rdquo; to get started.</>}
                  </td>
                </tr>
              ) : (
                classes.map((cls) => {
                  const taken = cls.seat_total - cls.seat_remaining;
                  const hasWindow = cls.enrollment_open_at || cls.enrollment_close_at;
                  const color = LEVEL_COLORS[cls.level] ?? DEFAULT_LEVEL_COLOR;

                  return (
                    <tr
                      key={cls.id}
                      className="hover:bg-[#f0f4ff]/40 transition-colors"
                    >
                      {/* Level */}
                      <td className="px-5 py-4">
                        <span
                          className="inline-flex items-center justify-center min-w-[2.5rem] h-8 px-2 rounded-lg text-xs font-bold text-white"
                          style={{ backgroundColor: color }}
                        >
                          {cls.level}
                        </span>
                      </td>

                      {/* Mode — hidden for event org */}
                      {tl.orgType !== "event" && (
                        <td className="px-5 py-4">
                          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            (cls.mode ?? "offline") === "online"
                              ? "bg-blue-50 text-blue-700"
                              : "bg-emerald-50 text-emerald-700"
                          }`}>
                            {(cls.mode ?? "offline") === "online" ? "💻 Online" : "🏫 Offline"}
                          </span>
                        </td>
                      )}

                      {/* Fee */}
                      <td className="px-5 py-4 tabular-nums text-gray-700 font-medium">
                        {formatMMKSimple(cls.fee_mmk)}
                      </td>

                      {/* Seats */}
                      <td className={`px-5 py-4 tabular-nums ${seatColor(cls.seat_remaining, cls.seat_total)}`}>
                        {taken}
                        <span className="text-gray-300 mx-0.5">/</span>
                        {cls.seat_total}
                        {cls.seat_remaining === 0 && (
                          <span className="ml-1.5 text-xs">(Full)</span>
                        )}
                      </td>

                      {/* Enrollment Window */}
                      <td className="px-5 py-4 text-gray-500 text-xs">
                        {hasWindow ? (
                          <span>
                            {fmtDate(cls.enrollment_open_at)}
                            <span className="mx-1.5 text-gray-300">→</span>
                            {fmtDate(cls.enrollment_close_at)}
                          </span>
                        ) : (
                          <span className="text-gray-300 italic">Not set</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="px-5 py-4">
                        <StatusBadge status={cls.status} />
                      </td>

                      {/* Actions */}
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-1.5">
                          {isOwner && (
                            <button
                              onClick={() => setEditingClass(cls)}
                              className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 text-gray-600 text-xs font-medium rounded-lg hover:border-[#1a3f8a] hover:text-[#1a3f8a] transition-colors"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                              </svg>
                              Edit
                            </button>
                          )}
                          <button
                            onClick={() => handleCopyClassLink(cls.level)}
                            title={`Copy ${cls.level} enrollment link`}
                            className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 text-gray-600 text-xs font-medium rounded-lg hover:border-[#0891b2] hover:text-[#0891b2] transition-colors"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
                            </svg>
                            Link
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit class modal */}
      {editingClass && (
        <EditClassModal
          cls={editingClass}
          onClose={() => setEditingClass(null)}
          onSaved={(updated) => {
            setClasses((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
            setEditingClass(null);
          }}
          showEventFields={tl.orgType !== "language_school"}
        />
      )}

      {/* Confirm "Add Default Classes (N5–N1)" */}
      {confirmAddAll && (
        <ConfirmModal
          variant="success"
          title="Add Default Classes (N5–N1)?"
          message="This will create N5, N4, N3, N2, N1 classes with default fees (300,000 – 500,000 MMK) and 30 seats each. Any levels that already exist will be skipped."
          confirmLabel="Add Classes"
          onConfirm={handleAddAllClasses}
          onCancel={() => setConfirmAddAll(false)}
        />
      )}

      {/* Add Custom Class modal */}
      {showAddCustom && (
        <AddCustomClassModal
          intakeId={params.id}
          onClose={() => setShowAddCustom(false)}
          onCreated={() => {
            setShowAddCustom(false);
            fetchData();
          }}
          showEventFields={tl.orgType !== "language_school"}
        />
      )}

      {/* Edit Intake modal */}
      {editingIntake && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setEditingIntake(false)}
            aria-hidden="true"
          />
          <div className="relative w-full max-w-md bg-white rounded-2xl shadow-xl p-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-[#1a3f8a] flex items-center justify-center text-white shrink-0">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-bold text-gray-900">Edit {tl.intake}</h2>
                <p className="text-xs text-gray-400 mt-0.5">Update name or year</p>
              </div>
              <button
                onClick={() => setEditingIntake(false)}
                className="ml-auto p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSaveIntake} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">{tl.intake} Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Year</label>
                <input
                  type="number"
                  value={editYear}
                  onChange={(e) => setEditYear(Number(e.target.value))}
                  min={2020}
                  max={2100}
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent"
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingIntake(false)}
                  className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingIntake}
                  className="flex-1 px-4 py-2.5 bg-[#1a3f8a] text-white rounded-xl text-sm font-medium hover:bg-blue-900 disabled:opacity-50 transition-colors"
                >
                  {savingIntake ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirm opening intake */}
      {confirmOpen && (
        <ConfirmModal
          variant="success"
          title={`Open "${intake?.name}"?`}
          message="This will make the enrollment portal live. Students can start enrolling immediately."
          confirmLabel="Open Enrollment"
          onConfirm={() => handleStatusChange("open")}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
