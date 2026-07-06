"use client";

import { useEffect, useState, Suspense } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import TrustedOfficialShell from "@/components/enrollment/TrustedOfficialShell";

interface EnrollmentSummary {
  enrollment_ref: string;
  status: string;
  total_amount: number;
  items: { level: string; quantity: number; fee_amount: number }[];
  event_name: string;
}

function CheckoutForm() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const ref = searchParams.get("ref") ?? "";

  const [summary, setSummary] = useState<EnrollmentSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!ref) { setLoadError("Missing order reference."); return; }
    fetch(`/api/public/enrollment/${ref}`)
      .then((r) => {
        if (r.status === 404) throw new Error("Order not found.");
        if (r.status === 410) throw new Error("This order has expired.");
        return r.json();
      })
      .then((d) => setSummary(d))
      .catch((e: Error) => setLoadError(e.message));
  }, [ref]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim()) {
      setFormError("Name and email are required.");
      return;
    }
    setSubmitting(true);
    setFormError(null);

    try {
      // 1. Save attendee details
      const patchRes = await fetch(`/api/public/enrollment/${ref}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ student_name_en: name.trim(), company: company.trim(), email: email.trim() }),
      });
      if (!patchRes.ok) {
        const d = await patchRes.json();
        if (patchRes.status === 409) throw new Error("This order has expired. Please start again.");
        throw new Error(d.message ?? "Failed to save details.");
      }

      // 2. Create PaymentIntent
      const intentRes = await fetch("/api/public/payments/stripe/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrollmentRef: ref }),
      });
      if (!intentRes.ok) {
        const d = await intentRes.json();
        throw new Error(d.message ?? "Payment setup failed. Please try again.");
      }
      const { clientSecret, paymentIntentId } = await intentRes.json();

      // 3. Store clientSecret in sessionStorage for Screen 3
      sessionStorage.setItem(`cs_${ref}`, clientSecret);

      router.push(`/enroll/${params.slug}/checkout/payment/?ref=${ref}&pi=${paymentIntentId}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-5" style={{ background: "#f7f5ef" }}>
        <p className="text-[13px] text-center" style={{ color: "#0f1f42" }}>{loadError}</p>
        <a href={`/enroll/${params.slug}/tickets/`} className="text-[12px] underline" style={{ color: "#b7912b" }}>
          Return to event page
        </a>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#f7f5ef" }}>
        <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: "#0f1f42", borderTopColor: "transparent" }} />
      </div>
    );
  }

  return (
    <TrustedOfficialShell orgName={summary.event_name} step={1}>
      {/* Order summary card */}
      <div className="rounded-[10px] p-4 mb-5" style={{ background: "#fbf8ee", border: "1px solid rgba(212,175,90,.33)" }}>
        {summary.items.map((item, i) => (
          <div key={i} className="flex justify-between text-[12.5px] font-bold" style={{ color: "#0f1f42" }}>
            <span>{item.quantity} × {item.level}</span>
            <span>{(item.fee_amount * item.quantity).toLocaleString()}</span>
          </div>
        ))}
        <p className="text-[10px] mt-1" style={{ color: "#9a9484" }}>{summary.event_name}</p>
      </div>

      {/* Attendee details form */}
      <p className="text-[11px] font-bold tracking-[1.2px] uppercase pb-1.5 mb-4" style={{ color: "#0f1f42", borderBottom: "1.5px solid #eee9dc" }}>
        Your Details
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="block text-[11px] font-semibold mb-1" style={{ color: "#43485a" }}>Full Name</label>
          <input
            className="w-full h-[33px] px-3 rounded-[7px] text-[12px] outline-none"
            style={{ border: `1.5px solid ${name ? "#0f1f42" : "#d8d5c9"}` }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your full name"
            required
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold mb-1" style={{ color: "#43485a" }}>
            Company <span className="font-normal" style={{ color: "#9a9484" }}>(optional)</span>
          </label>
          <input
            className="w-full h-[33px] px-3 rounded-[7px] text-[12px] outline-none"
            style={{ border: "1.5px solid #d8d5c9" }}
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Your company"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold mb-1" style={{ color: "#43485a" }}>Email Address</label>
          <input
            type="email"
            className="w-full h-[33px] px-3 rounded-[7px] text-[12px] outline-none"
            style={{ border: "1.5px solid #d8d5c9" }}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
          <p className="text-[9.5px] mt-1" style={{ color: "#9a9484" }}>E-ticket will be sent to this address.</p>
        </div>

        {formError && (
          <div className="p-3 rounded-lg border text-[12px]" style={{ background: "#fff5f5", borderColor: "#fca5a5", color: "#991b1b" }}>
            {formError}{" "}
            {formError.includes("expired") && (
              <a href={`/enroll/${params.slug}/tickets/`} className="underline">Start again</a>
            )}
          </div>
        )}

        <button
          type="submit"
          className="w-full py-3 rounded-[8px] text-[12.5px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          style={{ background: "#0f1f42" }}
          disabled={submitting}
        >
          {submitting ? "Please wait..." : "CONTINUE TO PAYMENT →"}
        </button>
      </form>
    </TrustedOfficialShell>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense>
      <CheckoutForm />
    </Suspense>
  );
}
