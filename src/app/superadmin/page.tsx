"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import LoadingSpinner from "@/components/ui/LoadingSpinner";

// ─── Types ──────────────────────────────────────────────────────────────────

interface School {
  id: string;
  name: string;
  subdomain: string;
  plan: string;
  created_at: string;
  owner_email: string | null;
  owner_name: string | null;
  student_count: number;
  status: "active" | "suspended";
}

interface Stats {
  total_schools: number;
  total_students: number;
  active_this_month: number;
}

// ─── Stat Card ──────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function SuperadminPage() {
  const [schools, setSchools] = useState<School[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    fetchSchools();
  }, []);

  async function fetchSchools() {
    setLoading(true);
    try {
      const res = await fetch("/api/superadmin/schools");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setSchools(data.schools);
      setStats(data.stats);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  async function toggleStatus(school: School) {
    setTogglingId(school.id);
    const newPlan = school.status === "active" ? "suspended" : "starter";
    try {
      const res = await fetch(`/api/superadmin/schools/${school.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: newPlan }),
      });
      if (res.ok) {
        setSchools((prev) =>
          prev.map((s) =>
            s.id === school.id
              ? { ...s, plan: newPlan, status: newPlan === "suspended" ? "suspended" : "active" }
              : s
          )
        );
      }
    } catch {
      /* ignore */
    } finally {
      setTogglingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard label="Total Schools Registered" value={stats.total_schools} />
          <StatCard label="Total Students (All Schools)" value={stats.total_students.toLocaleString()} />
          <StatCard label="Schools Active This Month" value={stats.active_this_month} />
        </div>
      )}

      {/* Schools table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-bold text-gray-900">Registered Schools</h2>
        </div>

        {schools.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-400">
            No schools registered yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs text-gray-500 uppercase tracking-wider">
                  <th className="px-6 py-3 font-medium">School</th>
                  <th className="px-6 py-3 font-medium">Subdomain</th>
                  <th className="px-6 py-3 font-medium">Owner</th>
                  <th className="px-6 py-3 font-medium text-right">Students</th>
                  <th className="px-6 py-3 font-medium">Created</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {schools.map((school) => (
                  <tr key={school.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-6 py-4">
                      <p className="font-medium text-gray-900">{school.name}</p>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-[#4c1d95] font-mono text-xs">
                        {school.subdomain}.eduenroll.com
                      </span>
                    </td>
                    <td className="px-6 py-4 text-gray-600">
                      {school.owner_email ?? "—"}
                    </td>
                    <td className="px-6 py-4 text-right font-mono text-gray-700">
                      {school.student_count}
                    </td>
                    <td className="px-6 py-4 text-gray-500">
                      {new Date(school.created_at).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
                          school.status === "active"
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-red-100 text-red-700"
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            school.status === "active" ? "bg-emerald-500" : "bg-red-500"
                          }`}
                        />
                        {school.status === "active" ? "Active" : "Suspended"}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          href={`/superadmin/schools/${school.id}`}
                          className="px-3 py-1.5 text-xs font-medium text-[#4c1d95] bg-purple-50 rounded-lg hover:bg-purple-100 transition-colors"
                        >
                          View Details
                        </Link>
                        <button
                          onClick={() => toggleStatus(school)}
                          disabled={togglingId === school.id}
                          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 ${
                            school.status === "active"
                              ? "text-red-700 bg-red-50 hover:bg-red-100"
                              : "text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
                          }`}
                        >
                          {school.status === "active" ? "Suspend" : "Activate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
