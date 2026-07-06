"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { EvTrustedOfficialTemplate } from "@/components/enrollment/templates";
import type { ClassStatus } from "@/types/database";

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

interface PageData {
  intake: { id: string; name: string; year: number; status: string };
  classes: ClassData[];
  appearance: Record<string, unknown>;
  labels: { currency: string; orgType: string; intake: string; class: string; student: string; seat: string; fee: string };
}

export default function TicketsPage() {
  const params = useParams<{ slug: string }>();
  const [data, setData] = useState<PageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/public/enroll/${params.slug}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch(() => setError("Failed to load event."));
  }, [params.slug]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#f7f5ef" }}>
        <p className="text-sm" style={{ color: "#8b8f9a" }}>{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#f7f5ef" }}>
        <div
          className="w-5 h-5 border-2 rounded-full animate-spin"
          style={{ borderColor: "#0f1f42", borderTopColor: "transparent" }}
        />
      </div>
    );
  }

  return (
    <EvTrustedOfficialTemplate
      appearance={data.appearance as never}
      intake={data.intake}
      classes={data.classes}
      labels={data.labels}
      slug={params.slug}
      currency={data.labels.currency}
    />
  );
}
