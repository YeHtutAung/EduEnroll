"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { EvTrustedOfficialTemplate } from "@/components/enrollment/templates";
import type { ClassStatus } from "@/types/database";
import { applyPriorityUnlock, capturePriorityToken } from "@/lib/interest/priorityUnlock";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClassData {
  id: string;
  level: string;
  fee_amount: number;
  fee_formatted: string;
  seat_remaining: number;
  seat_total: number;
  status: ClassStatus;
  enrollment_open_at: string | null;
  enrollment_close_at: string | null;
  max_tickets_per_person?: number;
}

interface IntakeData {
  id: string;
  name: string;
  year: number;
  status: string;
  priority_open_at?: string | null;
}

interface PageData {
  intake: IntakeData;
  classes: ClassData[];
  appearance: Record<string, unknown>;
  labels: { currency: string; orgType: string; intake: string; class: string; student: string; seat: string; fee: string };
  /** Tiers still behind a future enrollment_open_at — see the API route. */
  priority_covered_class_ids?: string[];
}

interface ApiError {
  error: string;
  code?: string;
  intake?: IntakeData;
  opens_at?: string | null;
}

// ─── State screens ────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-5 text-center" style={{ background: "#f7f5ef" }}>
      {children}
    </div>
  );
}

function ComingSoon({ intake, opensAt }: { intake?: IntakeData; opensAt?: string | null }) {
  const formatted = opensAt
    ? new Date(opensAt).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })
    : null;
  return (
    <Shell>
      <div className="w-[48px] h-[48px] rounded-full flex items-center justify-center mb-4" style={{ background: "#fbf8ee", border: "1.5px solid #d4af5a" }}>
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#b7912b" strokeWidth={2}>
          <circle cx="12" cy="12" r="10" /><path strokeLinecap="round" d="M12 6v6l4 2" />
        </svg>
      </div>
      {intake && (
        <p className="text-[11px] font-bold tracking-[1.5px] uppercase mb-1" style={{ color: "#b7912b" }}>
          {intake.name}
        </p>
      )}
      <h1 className="text-[19px] font-extrabold mb-1" style={{ color: "#0f1f42" }}>Coming Soon</h1>
      <p className="text-[12px]" style={{ color: "#8b8f9a" }}>Ticket sales are not open yet.</p>
      {formatted && (
        <div className="mt-4 px-4 py-2 rounded-full text-[11px] font-semibold" style={{ background: "#fbf8ee", border: "1px solid #d4af5a", color: "#b7912b" }}>
          Opens {formatted}
        </div>
      )}
    </Shell>
  );
}

function SalesClosed({ intake }: { intake?: IntakeData }) {
  return (
    <Shell>
      <div className="w-[48px] h-[48px] rounded-full flex items-center justify-center mb-4" style={{ background: "#f5f5f5", border: "1px solid #e3e0d6" }}>
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#8b8f9a" strokeWidth={2}>
          <rect x="3" y="11" width="18" height="11" rx="2" /><path strokeLinecap="round" d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
      </div>
      {intake && (
        <p className="text-[11px] font-bold tracking-[1.5px] uppercase mb-1" style={{ color: "#b7912b" }}>
          {intake.name}
        </p>
      )}
      <h1 className="text-[19px] font-extrabold mb-1" style={{ color: "#0f1f42" }}>Sales Closed</h1>
      <p className="text-[12px]" style={{ color: "#8b8f9a" }}>Ticket sales for this event have ended.</p>
    </Shell>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TicketsPage() {
  const params = useParams<{ slug: string }>();
  const [data, setData] = useState<PageData | null>(null);
  const [apiError, setApiError] = useState<ApiError | null>(null);

  // This page is reached two ways: directly, and by the redirect on
  // /enroll/<slug> for the ev-trusted-official template. The priority link
  // points at /enroll/<slug>, so on the redirect path the fragment is captured
  // there and only read back here — but capturePriorityToken also handles a
  // fragment arriving on this URL, so a link that ever points straight here
  // keeps working without a second code path.
  const [priorityToken, setPriorityToken] = useState<string | null>(null);
  useEffect(() => {
    setPriorityToken(capturePriorityToken(params.slug));
  }, [params.slug]);

  useEffect(() => {
    fetch(`/api/public/enroll/${params.slug}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) setApiError(body as ApiError);
        else setData(body as PageData);
      })
      .catch(() => setApiError({ error: "Failed to load event." }));
  }, [params.slug]);

  if (apiError) {
    if (apiError.code === "INTAKE_DRAFT") return <ComingSoon intake={apiError.intake} opensAt={apiError.opens_at} />;
    if (apiError.code === "INTAKE_CLOSED") return <SalesClosed intake={apiError.intake} />;
    return (
      <Shell>
        <p className="text-[13px]" style={{ color: "#8b8f9a" }}>{apiError.error}</p>
      </Shell>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#f7f5ef" }}>
        <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: "#0f1f42", borderTopColor: "transparent" }} />
      </div>
    );
  }

  return (
    <EvTrustedOfficialTemplate
      appearance={data.appearance as never}
      intake={data.intake}
      classes={applyPriorityUnlock(data.classes, {
        priorityOpenAt: data.intake.priority_open_at,
        coveredClassIds: data.priority_covered_class_ids ?? [],
        token: priorityToken,
      })}
      labels={data.labels}
      slug={params.slug}
      currency={data.labels.currency}
    />
  );
}
