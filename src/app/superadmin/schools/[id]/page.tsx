"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import LoadingSpinner from "@/components/ui/LoadingSpinner";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { formatMMK } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Tenant {
  id: string;
  name: string;
  subdomain: string;
  plan: string;
  created_at: string;
}

interface Owner {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  created_at: string;
}

interface Intake {
  id: string;
  name: string;
  year: number;
  status: string;
  created_at: string;
}

interface SchoolDetail {
  tenant: Tenant;
  owner: Owner | null;
  intakes: Intake[];
  total_students: number;
  total_revenue_mmk: number;
  last_activity: string | null;
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function SchoolDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [data, setData] = useState<SchoolDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSuspend, setShowSuspend] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/superadmin/schools/${id}`);
        if (res.ok) setData(await res.json());
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  async function handleToggle() {
    if (!data) return;
    setToggling(true);
    const isSuspended = data.tenant.plan === "suspended";
    const newPlan = isSuspended ? "starter" : "suspended";
    try {
      const res = await fetch(`/api/superadmin/schools/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: newPlan }),
      });
      if (res.ok) {
        setData((prev) =>
          prev ? { ...prev, tenant: { ...prev.tenant, plan: newPlan } } : prev
        );
      }
    } catch {
      /* ignore */
    } finally {
      setToggling(false);
      setShowSuspend(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-16 text-center text-gray-400">
        School not found.
      </div>
    );
  }

  const { tenant, owner, intakes, total_students, total_revenue_mmk, last_activity } = data;
  const isSuspended = tenant.plan === "suspended";

  const statusBadge = isSuspended ? (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700">
      <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
      Suspended
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
      Active
    </span>
  );

  const intakeStatusColors: Record<string, string> = {
    open: "bg-emerald-100 text-emerald-700",
    draft: "bg-gray-100 text-gray-600",
    closed: "bg-red-100 text-red-700",
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      {/* Back link */}
      <button
        onClick={() => router.push("/superadmin")}
        className="flex items-center gap-1 text-sm text-[#4c1d95] hover:underline"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Back to Schools
      </button>

      {/* School header */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-xl font-bold text-gray-900">{tenant.name}</h1>
              {statusBadge}
            </div>
            <p className="text-sm text-[#4c1d95] font-mono">
              {tenant.subdomain}.eduenroll.com
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Created {new Date(tenant.created_at).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </p>
          </div>
          <button
            onClick={() => setShowSuspend(true)}
            disabled={toggling}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 ${
              isSuspended
                ? "text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
                : "text-red-700 bg-red-50 hover:bg-red-100"
            }`}
          >
            {isSuspended ? "Activate School" : "Suspend School"}
          </button>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Owner</p>
          <p className="text-sm font-semibold text-gray-900 mt-1 truncate">
            {owner?.full_name ?? "—"}
          </p>
          <p className="text-xs text-gray-400 truncate">{owner?.email ?? "—"}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Total Students</p>
          <p className="text-xl font-bold text-gray-900 mt-1">{total_students}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Total Revenue</p>
          <p className="text-xl font-bold text-gray-900 mt-1">
            {formatMMK(total_revenue_mmk)}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Last Activity</p>
          <p className="text-sm font-semibold text-gray-900 mt-1">
            {last_activity
              ? new Date(last_activity).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })
              : "None"}
          </p>
        </div>
      </div>

      {/* Intakes table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-bold text-gray-900">Intakes</h2>
        </div>
        {intakes.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">No intakes created.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500 uppercase tracking-wider">
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Year</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {intakes.map((intake) => (
                <tr key={intake.id} className="hover:bg-gray-50/50">
                  <td className="px-6 py-3 font-medium text-gray-900">{intake.name}</td>
                  <td className="px-6 py-3 text-gray-600">{intake.year}</td>
                  <td className="px-6 py-3">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                        intakeStatusColors[intake.status] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {intake.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-gray-500">
                    {new Date(intake.created_at).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Suspend/Activate Modal */}
      {showSuspend && (
        <ConfirmModal
          variant={isSuspended ? "success" : "danger"}
          title={isSuspended ? "Activate School?" : "Suspend School?"}
          message={
            isSuspended
              ? `This will reactivate "${tenant.name}" and restore access to their admin panel and enrollment pages.`
              : `This will suspend "${tenant.name}". Their admin panel and enrollment pages will become inaccessible until reactivated.`
          }
          confirmLabel={isSuspended ? "Activate" : "Suspend"}
          onConfirm={handleToggle}
          onCancel={() => setShowSuspend(false)}
        />
      )}
    </div>
  );
}
