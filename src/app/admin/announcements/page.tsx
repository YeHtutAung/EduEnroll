"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import LoadingSpinner from "@/components/ui/LoadingSpinner";
import EmptyState from "@/components/ui/EmptyState";
import type { AnnouncementRow } from "@/app/api/admin/announcements/route";
import { useTenantLabels } from "@/components/admin/TenantLabelsContext";
import { mm } from "@/lib/mm-labels";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Intake {
  id: string;
  name: string;
  year: number;
  status: string;
}

interface ClassRow {
  id: string;
  level: string;
  status: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncate(text: string, max = 120) {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AnnouncementsPage() {
  const toast = useToast();
  const tl = useTenantLabels();

  // ── Intakes list ──────────────────────────────────────────────────────────
  const [intakes, setIntakes] = useState<Intake[]>([]);
  const [intakesLoading, setIntakesLoading] = useState(true);

  // ── Composer state ────────────────────────────────────────────────────────
  const [selectedIntakeId, setSelectedIntakeId] = useState("");
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [classesLoading, setClassesLoading] = useState(false);
  const [selectedLevel, setSelectedLevel] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  // ── History ───────────────────────────────────────────────────────────────
  const [history, setHistory] = useState<AnnouncementRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const sendingRef = useRef(false);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  // ── Load intakes on mount ─────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/intakes")
      .then((r) => r.json())
      .then((data: unknown) => {
        const list = Array.isArray(data) ? (data as Intake[]) : [];
        setIntakes(list);
        const first = list.find((i) => i.status === "open") ?? list[0];
        if (first) setSelectedIntakeId(first.id);
      })
      .catch(() => toast.error("Failed to load intakes."))
      .finally(() => setIntakesLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load history on mount ─────────────────────────────────────────────────
  const loadHistory = useCallback(() => {
    setHistoryLoading(true);
    fetch("/api/admin/announcements")
      .then((r) => r.json())
      .then((data: unknown) => setHistory(Array.isArray(data) ? (data as AnnouncementRow[]) : []))
      .catch(() => toast.error("Failed to load announcement history."))
      .finally(() => setHistoryLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // ── Load classes when intake changes ─────────────────────────────────────
  useEffect(() => {
    if (!selectedIntakeId) {
      setClasses([]);
      setSelectedLevel("");
      return;
    }
    setClassesLoading(true);
    setSelectedLevel("");
    fetch(`/api/intakes/${selectedIntakeId}/classes`)
      .then((r) => r.json())
      .then((data: unknown) => setClasses(Array.isArray(data) ? (data as ClassRow[]) : []))
      .catch(() => toast.error("Failed to load classes."))
      .finally(() => setClassesLoading(false));
  }, [selectedIntakeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Send ──────────────────────────────────────────────────────────────────
  async function handleSend() {
    if (sendingRef.current) return;
    if (!selectedIntakeId) {
      toast.error("Please select an intake.");
      return;
    }
    if (!message.trim()) {
      toast.error("Message cannot be empty.");
      messageRef.current?.focus();
      return;
    }

    sendingRef.current = true;
    setSending(true);
    try {
      const body: Record<string, unknown> = {
        intake_id: selectedIntakeId,
        message: message.trim(),
      };
      if (selectedLevel) body.class_level = selectedLevel;

      const res = await fetch("/api/admin/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error((err as { message?: string }).message ?? "Failed to send announcement.");
        return;
      }

      const created = (await res.json()) as AnnouncementRow;
      toast.success("Announcement saved successfully.");
      setMessage("");
      setSelectedLevel("");
      // Prepend to history
      setHistory((prev) => [created, ...prev]);
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const selectedIntake = intakes.find((i) => i.id === selectedIntakeId);
  const availableLevels = Array.from(new Set(classes.map((c) => c.level)));
  const targetPreview = selectedIntake
    ? selectedLevel
      ? `${selectedLevel} — ${selectedIntake.name}`
      : `All Classes — ${selectedIntake.name}`
    : "—";

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="p-4 lg:p-6 space-y-6 max-w-5xl mx-auto">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-bold text-[#0f1225]">Announcements</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Compose and send announcements to students. Email dispatch will be enabled in a future update.
        </p>
      </div>

      {/* ── Composer card ──────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <span className="text-lg">📢</span>
          <h2 className="text-base font-semibold text-[#0f1225]">New Announcement</h2>
        </div>

        <div className="px-5 py-5 space-y-4">
          {/* Row 1: Intake + Level */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Intake */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">
                Intake <span className="text-red-500">*</span>
              </label>
              {intakesLoading ? (
                <div className="h-9 bg-gray-100 rounded-lg animate-pulse" />
              ) : (
                <select
                  value={selectedIntakeId}
                  onChange={(e) => setSelectedIntakeId(e.target.value)}
                  className="w-full h-9 px-3 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1a3f8a]/30 focus:border-[#1a3f8a] text-[#0f1225] disabled:opacity-50"
                  disabled={sending}
                >
                  <option value="">Select intake…</option>
                  {intakes.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Class Level */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">
                Class Level
                <span className="ml-1 text-gray-400 font-normal">(leave blank for all classes)</span>
              </label>
              {classesLoading ? (
                <div className="h-9 bg-gray-100 rounded-lg animate-pulse" />
              ) : (
                <select
                  value={selectedLevel}
                  onChange={(e) => setSelectedLevel(e.target.value)}
                  className="w-full h-9 px-3 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1a3f8a]/30 focus:border-[#1a3f8a] text-[#0f1225] disabled:opacity-50"
                  disabled={sending || !selectedIntakeId}
                >
                  <option value="">All Classes</option>
                  {availableLevels.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Target preview */}
          {selectedIntakeId && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span className="font-medium text-gray-700">Target:</span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#1a3f8a]/8 text-[#1a3f8a] font-medium border border-[#1a3f8a]/20">
                {targetPreview}
              </span>
            </div>
          )}

          {/* Message */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">
              Message <span className="text-red-500">*</span>
              <span className="ml-1 text-gray-400 font-normal">(supports Myanmar & English)</span>
            </label>
            <textarea
              ref={messageRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              placeholder={mm(tl.orgType, "announcementPlaceholder")}
              className="w-full px-3 py-2.5 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1a3f8a]/30 focus:border-[#1a3f8a] text-[#0f1225] placeholder-gray-300 resize-none font-myanmar leading-relaxed disabled:opacity-50"
              disabled={sending}
            />
            <div className="mt-1 flex justify-between items-center">
              <span className="text-xs text-gray-400">
                {message.length} character{message.length !== 1 ? "s" : ""}
              </span>
              {message.length > 1000 && (
                <span className="text-xs text-amber-600 font-medium">Long message — consider splitting</span>
              )}
            </div>
          </div>

          {/* Note about dispatch */}
          <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
            <span className="mt-0.5 shrink-0">ℹ️</span>
            <span>
              <strong>Sprint 4 note:</strong> Announcements are saved to history now. Email and SMS dispatch will be wired in the next sprint.
            </span>
          </div>

          {/* Send button */}
          <div className="flex justify-end">
            <button
              onClick={handleSend}
              disabled={sending || !selectedIntakeId || !message.trim()}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#1a3f8a] text-white text-sm font-semibold hover:bg-[#15337a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? (
                <>
                  <LoadingSpinner size="sm" />
                  Saving…
                </>
              ) : (
                <>
                  <span>📤</span>
                  Save Announcement
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ── Sent History ───────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg">📋</span>
            <h2 className="text-base font-semibold text-[#0f1225]">Sent History</h2>
            {!historyLoading && (
              <span className="text-xs text-gray-400 font-normal ml-1">
                ({history.length} record{history.length !== 1 ? "s" : ""})
              </span>
            )}
          </div>
          <button
            onClick={loadHistory}
            disabled={historyLoading}
            className="text-xs text-[#1a3f8a] hover:underline disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        {historyLoading ? (
          <HistorySkeleton />
        ) : history.length === 0 ? (
          <div className="px-5 py-10">
            <EmptyState
              icon="📭"
              title="No announcements yet"
              description="Announcements you compose will appear here after saving."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-40">
                    Date
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-52">
                    Target
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Message
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-36">
                    Sent by
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {history.map((row) => (
                  <HistoryRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── History Row ──────────────────────────────────────────────────────────────

function HistoryRow({ row }: { row: AnnouncementRow }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <tr
      className="hover:bg-gray-50/70 transition-colors cursor-pointer"
      onClick={() => setExpanded((v) => !v)}
    >
      <td className="px-5 py-3.5 align-top">
        <span className="text-xs text-gray-500 whitespace-nowrap">
          {formatDate(row.created_at)}
        </span>
      </td>
      <td className="px-4 py-3.5 align-top">
        <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-[#1a3f8a]/8 text-[#1a3f8a] text-xs font-medium border border-[#1a3f8a]/15">
          {row.target_label}
        </span>
      </td>
      <td className="px-4 py-3.5 align-top">
        <p className="text-gray-700 font-myanmar leading-relaxed whitespace-pre-wrap break-words">
          {expanded ? row.message : truncate(row.message)}
        </p>
        {row.message.length > 120 && (
          <button className="mt-1 text-xs text-[#1a3f8a] hover:underline">
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </td>
      <td className="px-4 py-3.5 align-top">
        <span className="text-xs text-gray-600 truncate block max-w-[9rem]">
          {row.sent_by_name ?? "—"}
        </span>
      </td>
    </tr>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function HistorySkeleton() {
  return (
    <div className="divide-y divide-gray-50">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex gap-4 px-5 py-4 animate-pulse">
          <div className="h-4 w-36 bg-gray-100 rounded" />
          <div className="h-5 w-44 bg-gray-100 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="h-4 bg-gray-100 rounded w-full" />
            <div className="h-4 bg-gray-100 rounded w-3/4" />
          </div>
          <div className="h-4 w-24 bg-gray-100 rounded" />
        </div>
      ))}
    </div>
  );
}
