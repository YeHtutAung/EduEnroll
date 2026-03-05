"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import type { User, UserRole } from "@/types/database";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StaffMember extends User {
  role: UserRole;
}

// ─── Role badge ───────────────────────────────────────────────────────────────

const ROLE_STYLES: Record<UserRole, { bg: string; text: string }> = {
  superadmin: { bg: "bg-red-100", text: "text-red-800" },
  owner: { bg: "bg-purple-100", text: "text-purple-800" },
  staff: { bg: "bg-blue-100", text: "text-blue-800" },
};

function RoleBadge({ role }: { role: UserRole }) {
  const style = ROLE_STYLES[role] ?? ROLE_STYLES.staff;
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize ${style.bg} ${style.text}`}
    >
      {role}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function Pulse({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-gray-200 ${className}`} />;
}

// ─── Invite Modal ─────────────────────────────────────────────────────────────

function InviteModal({
  onClose,
  onInvited,
}: {
  onClose: () => void;
  onInvited: () => void;
}) {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    try {
      const res = await fetch("/api/admin/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? `${res.status}`);
      }
      toast.success(`Invite sent to ${email.trim()}`);
      onInvited();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send invite.");
    } finally {
      setSending(false);
    }
  }

  const inputClass =
    "w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-xl p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-1">
          Invite Staff Member
        </h2>
        <p className="text-sm text-gray-500 font-myanmar mb-5">
          ဝန်ထမ်းအသစ် ဖိတ်ကြားရန်
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Email Address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="staff@example.com"
              className={inputClass}
            />
            <p className="mt-1.5 text-xs text-gray-400">
              They will receive an invite link to join as staff.
            </p>
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
              disabled={sending}
              className="flex-1 px-4 py-2.5 bg-[#1a3f8a] text-white rounded-xl text-sm font-medium hover:bg-blue-900 disabled:opacity-50 transition-colors"
            >
              {sending ? "Sending…" : "Send Invite"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function StaffPage() {
  const toast = useToast();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);

  const fetchStaff = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/staff");
      if (res.status === 403) {
        // Staff user trying to access — redirect
        window.location.href = "/admin/dashboard";
        return;
      }
      if (!res.ok) throw new Error(`${res.status}`);
      setStaff((await res.json()) as StaffMember[]);
    } catch {
      toast.error("Failed to load staff.");
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchStaff();
  }, [fetchStaff]);

  return (
    <div className="min-h-screen bg-[#f0f4ff] px-6 py-8 lg:px-8 space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Staff Members</h1>
          <p className="text-sm font-myanmar text-gray-400 mt-0.5">
            ဝန်ထမ်းများ စီမံခန့်ခွဲရန်
          </p>
        </div>
        <button
          onClick={() => setShowInvite(true)}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-[#1a3f8a] text-white text-sm font-medium rounded-xl hover:bg-blue-900 transition-colors shadow-sm shrink-0"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 4.5v15m7.5-7.5h-15"
            />
          </svg>
          Invite Staff Member
        </button>
      </div>

      {/* Staff table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4">
                <Pulse className="h-10 w-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Pulse className="h-4 w-32" />
                  <Pulse className="h-3 w-48" />
                </div>
                <Pulse className="h-6 w-16 rounded-full" />
              </div>
            ))}
          </div>
        ) : staff.length === 0 ? (
          <div className="py-16 text-center">
            <div className="w-14 h-14 rounded-full bg-[#f0f4ff] flex items-center justify-center text-2xl mx-auto mb-3">
              👥
            </div>
            <p className="text-base font-semibold text-gray-700">
              No staff members yet
            </p>
            <p className="text-sm text-gray-400 mt-1">
              Invite your first staff member to get started.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100 text-left">
                  <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Name
                  </th>
                  <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Email
                  </th>
                  <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Role
                  </th>
                  <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Joined
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {staff.map((member) => (
                  <tr key={member.id} className="hover:bg-gray-50/50">
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-[#1a3f8a] flex items-center justify-center shrink-0">
                          <span className="text-white text-xs font-bold uppercase">
                            {(member.full_name ?? member.email).charAt(0)}
                          </span>
                        </div>
                        <span className="font-medium text-gray-900">
                          {member.full_name ?? "—"}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-gray-600">{member.email}</td>
                    <td className="px-5 py-4">
                      <RoleBadge role={member.role} />
                    </td>
                    <td className="px-5 py-4 text-gray-500 text-xs">
                      {fmtDate(member.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Invite modal */}
      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onInvited={() => {
            setShowInvite(false);
            fetchStaff();
          }}
        />
      )}
    </div>
  );
}
