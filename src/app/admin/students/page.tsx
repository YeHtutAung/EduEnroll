"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import StatusBadge from "@/components/ui/StatusBadge";
import LoadingSpinner from "@/components/ui/LoadingSpinner";
import { useToast } from "@/components/ui/Toast";
import { formatMMKSimple } from "@/lib/utils";
import type { EnrollmentStatus, Intake, JlptLevel, PaymentStatus } from "@/types/database";

// ── Types ─────────────────────────────────────────────────────────────────────

interface StudentRow {
  enrollment_id: string;
  enrollment_ref: string;
  student_name_en: string;
  student_name_mm: string | null;
  phone: string;
  status: EnrollmentStatus;
  enrolled_at: string;
  class_level: JlptLevel;
  intake_name: string;
  fee_mmk: number;
}

interface StudentDetail {
  enrollment_id: string;
  enrollment_ref: string;
  student_name_en: string;
  student_name_mm: string | null;
  nrc_number: string | null;
  phone: string;
  email: string | null;
  status: EnrollmentStatus;
  enrolled_at: string;
  class_level: JlptLevel | null;
  intake_name: string | null;
  fee_mmk: number | null;
  payment: {
    id: string;
    status: PaymentStatus;
    amount_mmk: number;
    bank_reference: string | null;
    submitted_at: string;
    verified_at: string | null;
    proof_signed_url: string | null;
  } | null;
}

interface Pagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

interface Filters {
  intakeId: string;
  level: string;
  status: string;
  search: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const JLPT_LEVELS: JlptLevel[] = ["N5", "N4", "N3", "N2", "N1"];

const ENROLLMENT_STATUSES: { value: EnrollmentStatus; label: string }[] = [
  { value: "pending_payment",   label: "Pending Payment"   },
  { value: "payment_submitted", label: "Payment Submitted" },
  { value: "confirmed",         label: "Confirmed"         },
  { value: "rejected",          label: "Rejected"          },
];

const LEVEL_COLORS: Record<JlptLevel, string> = {
  N5: "#1a6b3c",
  N4: "#0891b2",
  N3: "#1a3f8a",
  N2: "#b07d2a",
  N1: "#c0392b",
};

const PAYMENT_STATUS_LABELS: Record<PaymentStatus, { label: string; cls: string }> = {
  pending:  { label: "Pending",  cls: "bg-amber-50 text-amber-800 border border-amber-300" },
  verified: { label: "Verified", cls: "bg-emerald-50 text-emerald-800 border border-emerald-300" },
  rejected: { label: "Rejected", cls: "bg-red-50 text-red-700 border border-red-300" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(isoStr: string | null | undefined): string {
  if (!isoStr) return "—";
  return new Date(isoStr).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function buildQS(filters: Filters, page: number): string {
  const p = new URLSearchParams({ page: String(page), page_size: "20" });
  if (filters.intakeId) p.set("intake_id", filters.intakeId);
  if (filters.level)    p.set("class_level", filters.level);
  if (filters.status)   p.set("status", filters.status);
  if (filters.search)   p.set("search", filters.search.trim());
  return p.toString();
}

function pageRange(cur: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | "…")[] = [1];
  if (cur > 3) pages.push("…");
  const s = Math.max(2, cur - 1);
  const e = Math.min(total - 1, cur + 1);
  for (let i = s; i <= e; i++) pages.push(i);
  if (cur < total - 2) pages.push("…");
  pages.push(total);
  return pages;
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Pulse({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-gray-200 ${className}`} />;
}

function RowSkeleton() {
  return (
    <tr>
      {[24, 48, 28, 32, 36, 16, 32, 28, 28, 24].map((w, i) => (
        <td key={i} className="px-4 py-3.5">
          <Pulse className={`h-4 w-${w}`} />
        </td>
      ))}
    </tr>
  );
}

// ── Student Detail Modal ──────────────────────────────────────────────────────

function StudentDetailModal({
  row,
  onClose,
}: {
  row: StudentRow;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<StudentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fullscreenImg, setFullscreenImg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/admin/students/${row.enrollment_id}`);
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        if (!cancelled) setDetail(data as StudentDetail);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [row.enrollment_id]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (fullscreenImg) { setFullscreenImg(null); return; }
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, fullscreenImg]);

  const level = row.class_level;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          onClick={onClose}
          aria-hidden="true"
        />
        <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">

          {/* Modal header */}
          <div
            className="px-6 py-4 flex items-center gap-3 border-b border-gray-100"
            style={{ borderTop: `4px solid ${level ? LEVEL_COLORS[level] : "#1a3f8a"}` }}
          >
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm shrink-0"
              style={{ backgroundColor: level ? LEVEL_COLORS[level] : "#1a3f8a" }}
            >
              {level || "?"}
            </div>
            <div className="min-w-0">
              <p className="font-bold text-gray-900 truncate">{row.student_name_en}</p>
              {row.student_name_mm && (
                <p className="text-xs font-myanmar text-gray-400 truncate">{row.student_name_mm}</p>
              )}
            </div>
            <div className="ml-auto flex items-center gap-2 shrink-0">
              <StatusBadge status={row.status} />
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Modal body */}
          <div className="overflow-y-auto flex-1 p-6">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <LoadingSpinner size="lg" />
              </div>
            ) : error ? (
              <div className="text-center py-8 text-sm text-red-500">{error}</div>
            ) : detail ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">

                {/* ── Left: Student info ─────────────────────── */}
                <div className="space-y-4">
                  <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                    Student Information
                  </h3>

                  <DetailRow label="Name (English)" value={detail.student_name_en} />
                  <DetailRow
                    label="Name (Myanmar)"
                    value={
                      detail.student_name_mm ? (
                        <span className="font-myanmar">{detail.student_name_mm}</span>
                      ) : "—"
                    }
                  />
                  <DetailRow label="NRC Number" value={detail.nrc_number ?? "—"} />
                  <DetailRow label="Phone" value={<code className="text-sm">{detail.phone}</code>} />
                  <DetailRow label="Email" value={detail.email ?? "—"} />
                  <DetailRow
                    label="Enrollment Ref"
                    value={
                      <code className="text-sm font-mono text-[#1a3f8a] font-semibold">
                        {detail.enrollment_ref}
                      </code>
                    }
                  />
                  <DetailRow label="Enrolled Date" value={fmtDate(detail.enrolled_at)} />
                </div>

                {/* ── Right: Class + Payment ────────────────── */}
                <div className="space-y-4">
                  <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                    Class &amp; Payment
                  </h3>

                  <DetailRow
                    label="Level"
                    value={
                      detail.class_level ? (
                        <span
                          className="inline-flex items-center justify-center w-10 h-7 rounded-lg text-xs font-bold text-white"
                          style={{ backgroundColor: LEVEL_COLORS[detail.class_level] }}
                        >
                          {detail.class_level}
                        </span>
                      ) : "—"
                    }
                  />
                  <DetailRow label="Intake" value={detail.intake_name ?? "—"} />
                  <DetailRow
                    label="Fee"
                    value={
                      detail.fee_mmk != null
                        ? <span className="font-semibold text-[#1a3f8a]">{formatMMKSimple(detail.fee_mmk)}</span>
                        : "—"
                    }
                  />

                  {/* Payment block */}
                  {detail.payment ? (
                    <div className="rounded-xl border border-gray-100 bg-gray-50 p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Payment</span>
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${PAYMENT_STATUS_LABELS[detail.payment.status].cls}`}>
                          {PAYMENT_STATUS_LABELS[detail.payment.status].label}
                        </span>
                      </div>
                      <div className="space-y-1.5 text-sm">
                        <p className="text-gray-500">
                          Amount: <span className="font-medium text-gray-800">{formatMMKSimple(detail.payment.amount_mmk)}</span>
                        </p>
                        {detail.payment.bank_reference && (
                          <p className="text-gray-500">
                            Ref: <code className="text-xs">{detail.payment.bank_reference}</code>
                          </p>
                        )}
                        <p className="text-gray-500">
                          Submitted: <span className="text-gray-800">{fmtDate(detail.payment.submitted_at)}</span>
                        </p>
                        {detail.payment.verified_at && (
                          <p className="text-gray-500">
                            Verified: <span className="text-gray-800">{fmtDate(detail.payment.verified_at)}</span>
                          </p>
                        )}
                      </div>

                      {/* Proof image thumbnail */}
                      {detail.payment.proof_signed_url ? (
                        <div>
                          <p className="text-xs text-gray-400 mb-2">Payment Proof</p>
                          <button
                            onClick={() => setFullscreenImg(detail.payment!.proof_signed_url)}
                            className="block relative group"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={detail.payment.proof_signed_url}
                              alt="Payment proof"
                              className="w-full max-h-36 object-cover rounded-lg border border-gray-200 group-hover:opacity-90 transition-opacity"
                            />
                            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                              <div className="bg-black/60 rounded-full p-2">
                                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                                </svg>
                              </div>
                            </div>
                          </button>
                          <p className="text-xs text-gray-400 mt-1 text-center">Click to view fullscreen</p>
                        </div>
                      ) : (
                        <p className="text-xs text-gray-400 italic">No proof image uploaded</p>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-gray-200 p-4 text-center text-sm text-gray-400">
                      No payment submitted yet
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Fullscreen image overlay */}
      {fullscreenImg && (
        <div
          className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4 cursor-zoom-out"
          onClick={() => setFullscreenImg(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={fullscreenImg}
            alt="Payment proof fullscreen"
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="absolute top-4 right-4 p-2 bg-white/20 hover:bg-white/30 rounded-full text-white transition-colors"
            onClick={() => setFullscreenImg(null)}
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

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs text-gray-400 mb-0.5">{label}</p>
      <div className="text-sm text-gray-800">{value}</div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function StudentsPage() {
  const toast = useToast();

  // Filters
  const [filters, setFilters] = useState<Filters>({
    intakeId: "",
    level: "",
    status: "",
    search: "",
  });
  const [searchInput, setSearchInput] = useState(""); // debounced separately
  const [page, setPage] = useState(1);

  // Data
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Intakes for filter dropdown
  const [intakes, setIntakes] = useState<Intake[]>([]);

  // Modal
  const [selectedStudent, setSelectedStudent] = useState<StudentRow | null>(null);

  // Export
  const [exporting, setExporting] = useState(false);

  // Debounce search
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function handleSearchChange(val: string) {
    setSearchInput(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFilters((f) => ({ ...f, search: val }));
      setPage(1);
    }, 400);
  }

  function setFilter<K extends keyof Filters>(key: K, val: Filters[K]) {
    setFilters((f) => ({ ...f, [key]: val }));
    setPage(1);
  }

  // ── Fetch intakes (once) ───────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/intakes")
      .then((r) => r.json())
      .then((data: Intake[]) => setIntakes(data))
      .catch(() => {/* non-critical */});
  }, []);

  // ── Fetch students ─────────────────────────────────────────────────────────
  const fetchStudents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = buildQS(filters, page);
      const res = await fetch(`/api/admin/students?${qs}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json();
      setStudents(json.data ?? []);
      setPagination(json.pagination ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load students.");
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    fetchStudents();
  }, [fetchStudents]);

  // ── Export Excel ───────────────────────────────────────────────────────────
  async function handleExport() {
    setExporting(true);
    try {
      // Fetch all matching records (up to API max of 100)
      const qs = buildQS({ ...filters, search: filters.search }, 1);
      const res = await fetch(`/api/admin/students?${qs}&page_size=100`);
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json();
      const rows = (json.data ?? []) as StudentRow[];

      const XLSX = await import("xlsx");

      const headers = [
        "No",
        "Name (English)",
        "Name (Myanmar)",
        "NRC",
        "Phone",
        "Enrollment Ref",
        "Level",
        "Intake",
        "Status",
        "Fee (MMK)",
        "Enrolled Date",
      ];

      const wsData = [
        headers,
        ...rows.map((s, i) => [
          i + 1,
          s.student_name_en,
          s.student_name_mm ?? "",
          "", // NRC not available in list API; visible in detail modal
          s.phone,
          s.enrollment_ref,
          s.class_level,
          s.intake_name,
          s.status,
          s.fee_mmk,
          fmtDate(s.enrolled_at),
        ]),
      ];

      const ws = XLSX.utils.aoa_to_sheet(wsData);

      // Column widths
      ws["!cols"] = [
        { wch: 5 },  // No
        { wch: 25 }, // Name EN
        { wch: 20 }, // Name MM
        { wch: 18 }, // NRC
        { wch: 16 }, // Phone
        { wch: 16 }, // Ref
        { wch: 8 },  // Level
        { wch: 22 }, // Intake
        { wch: 20 }, // Status
        { wch: 14 }, // Fee
        { wch: 14 }, // Date
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Students");
      const date = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `NihonMoment-Students-${date}.xlsx`);
      toast.success(`Exported ${rows.length} student${rows.length !== 1 ? "s" : ""} to Excel.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const total = pagination?.total ?? 0;
  const totalPages = pagination?.total_pages ?? 1;
  const offset = (page - 1) * 20;

  return (
    <div className="min-h-screen bg-[#f0f4ff] px-6 py-8 lg:px-8">

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 leading-tight">Students</h1>
          <p className="text-sm font-myanmar text-gray-400 mt-0.5">ကျောင်းသားများ</p>
        </div>
        <button
          onClick={handleExport}
          disabled={exporting || loading}
          className="flex items-center gap-2 px-4 py-2.5 bg-[#1a6b3c] text-white text-sm font-medium rounded-xl hover:bg-green-800 disabled:opacity-50 transition-colors shadow-sm shrink-0"
        >
          {exporting ? (
            <>
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Exporting…
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Export Excel
            </>
          )}
        </button>
      </div>

      {/* ── Filter bar ──────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-5 py-4 mb-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Search */}
          <div className="sm:col-span-2 lg:col-span-1 relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <input
              type="text"
              placeholder="Search name or phone…"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent"
            />
          </div>

          {/* Intake */}
          <select
            value={filters.intakeId}
            onChange={(e) => setFilter("intakeId", e.target.value)}
            className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] bg-white text-gray-700"
          >
            <option value="">All Intakes</option>
            {intakes.map((i) => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </select>

          {/* Level */}
          <select
            value={filters.level}
            onChange={(e) => setFilter("level", e.target.value)}
            className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] bg-white text-gray-700"
          >
            <option value="">All Levels</option>
            {JLPT_LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>

          {/* Status */}
          <select
            value={filters.status}
            onChange={(e) => setFilter("status", e.target.value)}
            className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] bg-white text-gray-700"
          >
            <option value="">All Statuses</option>
            {ENROLLMENT_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        {/* Active filter chips + clear */}
        {(filters.intakeId || filters.level || filters.status || filters.search) && (
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <span className="text-xs text-gray-400">Filters:</span>
            {filters.intakeId && (
              <FilterChip
                label={intakes.find((i) => i.id === filters.intakeId)?.name ?? "Intake"}
                onRemove={() => setFilter("intakeId", "")}
              />
            )}
            {filters.level && <FilterChip label={`Level ${filters.level}`} onRemove={() => setFilter("level", "")} />}
            {filters.status && <FilterChip label={filters.status.replace(/_/g, " ")} onRemove={() => setFilter("status", "")} />}
            {filters.search && <FilterChip label={`"${filters.search}"`} onRemove={() => { setSearchInput(""); setFilter("search", ""); }} />}
            <button
              onClick={() => {
                setFilters({ intakeId: "", level: "", status: "", search: "" });
                setSearchInput("");
                setPage(1);
              }}
              className="text-xs text-[#c0392b] hover:underline ml-1"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* ── Count + Table ────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">

        {/* Count bar */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          {loading ? (
            <Pulse className="h-4 w-36" />
          ) : (
            <p className="text-sm text-gray-500">
              Showing{" "}
              <span className="font-semibold text-gray-800">
                {students.length > 0 ? `${offset + 1}–${offset + students.length}` : "0"}
              </span>{" "}
              of{" "}
              <span className="font-semibold text-gray-800">{total}</span>{" "}
              student{total !== 1 ? "s" : ""}
            </p>
          )}
          {!loading && total > 0 && (
            <p className="text-xs text-gray-400">
              Page {page} of {totalPages}
            </p>
          )}
        </div>

        {/* Error */}
        {!loading && error && (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-red-500 mb-3">{error}</p>
            <button
              onClick={fetchStudents}
              className="px-4 py-2 bg-[#1a3f8a] text-white text-sm rounded-lg"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && students.length === 0 && (
          <div className="py-16 flex flex-col items-center gap-2 text-center">
            <div className="w-14 h-14 rounded-full bg-[#f0f4ff] flex items-center justify-center text-2xl mb-1">👥</div>
            <p className="text-base font-semibold text-gray-700">No students found</p>
            <p className="text-sm text-gray-400 max-w-xs">
              {filters.intakeId || filters.level || filters.status || filters.search
                ? "Try adjusting your filters."
                : "No enrollments yet."}
            </p>
          </div>
        )}

        {/* Table */}
        {(loading || students.length > 0) && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100 text-left">
                  {["No.", "Student Name", "NRC Number", "Phone", "Enrollment Ref", "Level", "Intake", "Fee (MMK)", "Status", "Enrolled"].map(
                    (h) => (
                      <th
                        key={h}
                        className="px-4 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading
                  ? Array.from({ length: 8 }).map((_, i) => <RowSkeleton key={i} />)
                  : students.map((student, idx) => (
                      <tr
                        key={student.enrollment_id}
                        onClick={() => setSelectedStudent(student)}
                        className="hover:bg-[#f0f4ff]/60 cursor-pointer transition-colors"
                      >
                        {/* No. */}
                        <td className="px-4 py-3.5 text-gray-400 tabular-nums text-xs">
                          {offset + idx + 1}
                        </td>

                        {/* Student Name */}
                        <td className="px-4 py-3.5">
                          <p className="font-medium text-gray-800 whitespace-nowrap">
                            {student.student_name_en}
                          </p>
                          {student.student_name_mm && (
                            <p className="text-xs font-myanmar text-gray-400 mt-0.5">
                              {student.student_name_mm}
                            </p>
                          )}
                        </td>

                        {/* NRC — not in list API */}
                        <td className="px-4 py-3.5 text-gray-400 text-xs italic">
                          See detail
                        </td>

                        {/* Phone */}
                        <td className="px-4 py-3.5 text-gray-600 whitespace-nowrap tabular-nums text-xs">
                          {student.phone}
                        </td>

                        {/* Enrollment Ref */}
                        <td className="px-4 py-3.5">
                          <code className="text-xs font-mono text-[#1a3f8a] font-semibold whitespace-nowrap">
                            {student.enrollment_ref}
                          </code>
                        </td>

                        {/* Level */}
                        <td className="px-4 py-3.5">
                          <span
                            className="inline-flex items-center justify-center w-9 h-7 rounded-lg text-xs font-bold text-white"
                            style={{
                              backgroundColor:
                                LEVEL_COLORS[student.class_level] ?? "#1a3f8a",
                            }}
                          >
                            {student.class_level}
                          </span>
                        </td>

                        {/* Intake */}
                        <td className="px-4 py-3.5 text-gray-600 text-xs whitespace-nowrap max-w-[140px]">
                          <span className="truncate block">{student.intake_name}</span>
                        </td>

                        {/* Fee */}
                        <td className="px-4 py-3.5 text-gray-700 tabular-nums text-xs whitespace-nowrap">
                          {formatMMKSimple(student.fee_mmk)}
                        </td>

                        {/* Status */}
                        <td className="px-4 py-3.5">
                          <StatusBadge status={student.status} />
                        </td>

                        {/* Enrolled Date */}
                        <td className="px-4 py-3.5 text-gray-500 text-xs whitespace-nowrap">
                          {fmtDate(student.enrolled_at)}
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Pagination ──────────────────────────────────────────────── */}
        {!loading && totalPages > 1 && (
          <div className="flex items-center justify-center gap-1.5 px-5 py-4 border-t border-gray-100">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
              Prev
            </button>

            {pageRange(page, totalPages).map((p, i) =>
              p === "…" ? (
                <span key={`ellipsis-${i}`} className="px-2 text-gray-400 text-sm select-none">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`w-9 h-9 rounded-lg text-sm font-medium transition-colors ${
                    p === page
                      ? "bg-[#1a3f8a] text-white shadow-sm"
                      : "text-gray-600 border border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  {p}
                </button>
              ),
            )}

            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Next
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* ── Student Detail Modal ─────────────────────────────────────── */}
      {selectedStudent && (
        <StudentDetailModal
          row={selectedStudent}
          onClose={() => setSelectedStudent(null)}
        />
      )}
    </div>
  );
}

// ── Filter chip ───────────────────────────────────────────────────────────────

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#1a3f8a]/10 text-[#1a3f8a] text-xs font-medium">
      {label}
      <button
        onClick={onRemove}
        className="ml-0.5 text-[#1a3f8a]/60 hover:text-[#1a3f8a] transition-colors"
      >
        ×
      </button>
    </span>
  );
}
