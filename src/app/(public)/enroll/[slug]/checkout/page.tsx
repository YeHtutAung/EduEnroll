"use client";

import { useEffect, useState, Suspense } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import TrustedOfficialShell from "@/components/enrollment/TrustedOfficialShell";

// ─── Types ────────────────────────────────────────────────────────────────────

interface EnrollmentSummary {
  enrollment_ref: string;
  status: string;
  total_amount: number;
  items: { level: string; quantity: number; fee_amount: number }[];
  event_name: string;
  intake_id: string | null;
  logo_url: string | null;
  brand_color: string | null;
}

interface FormField {
  id: string;
  field_key: string;
  field_label: string;
  field_type: string;
  is_required: boolean;
  options: string[] | null;
  sort_order: number;
  is_default: boolean;
}

// ─── Dynamic field renderer ───────────────────────────────────────────────────

function DynamicField({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string;
  onChange: (v: string) => void;
}) {
  const isEmail = field.field_key === "email";
  const baseInput = "w-full h-[33px] px-3 rounded-[7px] text-[12px] outline-none";

  // Colour and background are stated, never inherited. Tailwind's preflight puts
  // `color: inherit` on form controls, so an input that sets only a border takes
  // whatever the body happens to carry. When a dark-mode override flipped the
  // body colour to near-white, that rendered invisible text on these hardcoded
  // white fields — buyers could not read what they typed at the payment step.
  // globals.css no longer flips it, and stating both here means a future theme
  // change cannot blank the checkout form again.
  const borderStyle = (v: string) => ({
    border: `1.5px solid ${v ? "#0f1f42" : "#d8d5c9"}`,
    color: "#0f1f42",
    background: "#ffffff",
  });

  const label = (
    <label className="block text-[11px] font-semibold mb-1" style={{ color: "#43485a" }}>
      {field.field_label}
      {!field.is_required && <span className="font-normal ml-1" style={{ color: "#9a9484" }}>(optional)</span>}
    </label>
  );

  switch (field.field_type) {
    case "select":
      return (
        <div>
          {label}
          <select
            className="w-full h-[33px] px-3 rounded-[7px] text-[12px] outline-none bg-white"
            style={borderStyle(value)}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required={field.is_required}
          >
            <option value="">Select...</option>
            {(field.options ?? []).map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </div>
      );

    case "radio":
      return (
        <div>
          {label}
          <div className="flex flex-col gap-1.5 mt-1">
            {(field.options ?? []).map((o) => (
              <label key={o} className="flex items-center gap-2 text-[12px]" style={{ color: "#43485a" }}>
                <input
                  type="radio"
                  name={field.field_key}
                  value={o}
                  checked={value === o}
                  onChange={() => onChange(o)}
                  required={field.is_required && !value}
                  className="accent-[#0f1f42]"
                />
                {o}
              </label>
            ))}
          </div>
        </div>
      );

    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-[12px]" style={{ color: "#43485a" }}>
          <input
            type="checkbox"
            checked={value === "true"}
            onChange={(e) => onChange(e.target.checked ? "true" : "")}
            className="accent-[#0f1f42] w-4 h-4"
          />
          {field.field_label}
          {field.is_required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      );

    case "date":
      return (
        <div>
          {label}
          <input
            type="date"
            className={baseInput}
            style={borderStyle(value)}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required={field.is_required}
          />
        </div>
      );

    case "address":
      return (
        <div>
          {label}
          <textarea
            className="w-full px-3 py-2 rounded-[7px] text-[12px] outline-none resize-none"
            style={{ ...borderStyle(value), minHeight: "64px" }}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.field_label}
            required={field.is_required}
            rows={2}
          />
        </div>
      );

    case "phone":
      return (
        <div>
          {label}
          <input
            type="tel"
            className={baseInput}
            style={borderStyle(value)}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="09xxxxxxxxx"
            required={field.is_required}
          />
        </div>
      );

    case "email":
      return (
        <div>
          {label}
          <input
            type="email"
            className={baseInput}
            style={borderStyle(value)}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="you@example.com"
            required={field.is_required}
          />
          {isEmail && (
            <p className="text-[9.5px] mt-1" style={{ color: "#9a9484" }}>E-ticket will be sent to this address.</p>
          )}
        </div>
      );

    default: // text and anything else
      return (
        <div>
          {label}
          <input
            type="text"
            className={baseInput}
            style={borderStyle(value)}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.field_label}
            required={field.is_required}
          />
        </div>
      );
  }
}

// ─── Checkout form ────────────────────────────────────────────────────────────

function CheckoutForm() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const ref = searchParams.get("ref") ?? "";

  const [summary, setSummary] = useState<EnrollmentSummary | null>(null);
  const [fields, setFields] = useState<FormField[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // field_key → value map
  const [values, setValues] = useState<Record<string, string>>({});
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
      .then((d: EnrollmentSummary) => setSummary(d))
      .catch((e: Error) => setLoadError(e.message));
  }, [ref]);

  useEffect(() => {
    if (!summary) return;

    const DEFAULT_FIELDS: FormField[] = [
      { id: "name_en", field_key: "name_en", field_label: "Full Name", field_type: "text",  is_required: true, options: null, sort_order: 1, is_default: true },
      { id: "email",   field_key: "email",   field_label: "Email",     field_type: "email", is_required: true, options: null, sort_order: 2, is_default: true },
    ];

    const applyFields = (f: FormField[]) => {
      setFields(f);
      const init: Record<string, string> = {};
      f.forEach((field) => { init[field.field_key] = ""; });
      setValues(init);
    };

    if (!summary.intake_id) {
      applyFields(DEFAULT_FIELDS);
      return;
    }

    fetch(`/api/public/form-fields?intake_id=${summary.intake_id}`)
      .then((r) => r.json())
      .then((f: FormField[]) => applyFields(f.length > 0 ? f : DEFAULT_FIELDS))
      .catch(() => applyFields(DEFAULT_FIELDS));
  }, [summary]);

  function setValue(key: string, val: string) {
    setValues((prev) => ({ ...prev, [key]: val }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);

    // Derive the two DB columns + extra form_data
    const nameField =
      fields.find((f) => f.field_key === "name_en") ??
      fields.find((f) => f.field_type === "text" && f.is_default) ??
      fields.find((f) => f.field_type === "text");
    const emailField = fields.find((f) => f.field_key === "email" || f.field_type === "email");

    const student_name_en = nameField ? (values[nameField.field_key] ?? "").trim() : "";
    const email = emailField ? (values[emailField.field_key] ?? "").trim() : "";

    if (!student_name_en || !email) {
      setFormError("Name and email are required.");
      setSubmitting(false);
      return;
    }

    // Save all field values to form_data (including name/email) so admin listing can display them
    const form_data: Record<string, string> = {};
    fields.forEach((f) => {
      const v = (values[f.field_key] ?? "").trim();
      if (v) form_data[f.field_key] = v;
    });

    // Priority-access token captured earlier from the URL fragment (see
    // `[slug]/page.tsx`) and stashed in sessionStorage, keyed per slug. Sent
    // only in this POST body — never as a query param or link href.
    const priorityToken = sessionStorage.getItem(`pa_${params.slug}`);

    try {
      // 1. Save attendee details
      const patchRes = await fetch(`/api/public/enrollment/${ref}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          student_name_en,
          email,
          form_data,
          ...(priorityToken ? { priority_token: priorityToken } : {}),
        }),
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
      const intentData = await intentRes.json();

      // Discriminated result (Plan v18 §3c) — never mistake one shape for
      // another, and never mount the payment UI without a client secret.
      if (intentData.kind === "settlement_conflict") {
        throw new Error(
          `This payment needs attention. Contact support and quote reference ${intentData.reference ?? ref}.`,
        );
      }
      if (intentData.kind === "succeeded") {
        router.push(`/enroll/${params.slug}/checkout/success/?ref=${ref}`);
        return;
      }
      if (intentData.kind === "processing") {
        // A payment is already in flight — the payment screen polls status.
        router.push(`/enroll/${params.slug}/checkout/payment/?ref=${ref}&pi=${intentData.paymentIntentId}&processing=1`);
        return;
      }
      if (intentData.kind !== "requires_payment" || !intentData.clientSecret) {
        throw new Error("Payment setup failed. Please try again.");
      }

      // 3. Store clientSecret in sessionStorage for Screen 3
      sessionStorage.setItem(`cs_${ref}`, intentData.clientSecret);

      router.push(`/enroll/${params.slug}/checkout/payment/?ref=${ref}&pi=${intentData.paymentIntentId}`);
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
    <TrustedOfficialShell orgName={summary.event_name} logoUrl={summary.logo_url} brandColor={summary.brand_color} step={1}>
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
        {fields.length > 0 ? (
          fields.map((field) => (
            <DynamicField
              key={field.id}
              field={field}
              value={values[field.field_key] ?? ""}
              onChange={(v) => setValue(field.field_key, v)}
            />
          ))
        ) : (
          /* Fallback while fields load or if intake has no fields */
          <div className="flex items-center justify-center py-4">
            <div className="w-4 h-4 border-2 rounded-full animate-spin" style={{ borderColor: "#0f1f42", borderTopColor: "transparent" }} />
          </div>
        )}

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
          disabled={submitting || fields.length === 0}
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
