"use client";

import { useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import { formatMMK, formatMMKSimple } from "@/lib/utils";
// ─── Types ────────────────────────────────────────────────────────────────────

interface EnrollmentInfo {
  enrollment_ref: string;
  student_name_en: string;
  student_name_mm: string | null;
  class_id: string | null;
  class_level: string | null;
  fee_mmk: number | null;
  fee_formatted: string | null;
  intake_slug: string | null;
  status: string;
  status_label_en: string;
  status_label_mm: string;
}

interface AvailableClass {
  id: string;
  level: string;
  fee_mmk: number;
  fee_formatted: string;
  seat_remaining: number;
  status: string;
}

interface BankAccountInfo {
  bank_name: string;
  account_number: string;
  account_holder: string;
  qr_code_url: string | null;
}

// ─── Myanmar numerals ────────────────────────────────────────────────────────

// Myanmar numerals not needed on this page — fees come pre-formatted from API

// ─── Bank badge colors ───────────────────────────────────────────────────────

const BANK_COLORS: Record<string, string> = {
  KBZ:          "bg-green-100 text-green-800",
  AYA:          "bg-blue-100 text-blue-800",
  CB:           "bg-yellow-100 text-yellow-800",
  UAB:          "bg-purple-100 text-purple-800",
  Yoma:         "bg-orange-100 text-orange-800",
  "Wave Money": "bg-sky-100 text-sky-800",
  KPay:         "bg-green-100 text-green-800",
  "OK$":        "bg-orange-100 text-orange-800",
};

// ─── Copy button ─────────────────────────────────────────────────────────────

function CopyButton({
  text,
  size = "normal",
}: {
  text: string;
  size?: "normal" | "small";
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const input = document.createElement("input");
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const base =
    size === "small"
      ? "rounded px-2 py-1 text-xs font-medium transition-colors"
      : "rounded-lg px-4 py-2 text-sm font-semibold transition-colors";

  return (
    <button
      onClick={handleCopy}
      className={`${base} ${
        copied
          ? "bg-green-100 text-green-700"
          : "bg-white text-gray-600 hover:bg-gray-100 border border-gray-300"
      }`}
    >
      {copied ? (
        <span className="inline-flex items-center gap-1">
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {size === "small" ? "Copied!" : "Copied! / "}
          {size !== "small" && <span className="font-myanmar">ကူးယူပြီး</span>}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1">
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
          Copy
        </span>
      )}
    </button>
  );
}

// ─── Loading skeleton ────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="mx-auto max-w-lg animate-pulse">
      <div className="mx-auto mb-6 h-16 w-16 rounded-full bg-gray-200" />
      <div className="mx-auto mb-4 h-7 w-64 rounded bg-gray-200" />
      <div className="mx-auto mb-8 h-5 w-48 rounded bg-gray-100" />
      <div className="mb-6 h-24 rounded-xl bg-gray-100" />
      <div className="mb-6 space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-5 rounded bg-gray-100" />
        ))}
      </div>
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="h-20 rounded-xl bg-gray-100" />
        ))}
      </div>
    </div>
  );
}

// ─── Error page ──────────────────────────────────────────────────────────────

function ErrorPage({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center py-20 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-50">
        <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <h2 className="mb-2 text-xl font-semibold text-gray-900">Enrollment Not Found</h2>
      <p className="font-myanmar text-gray-500">စာရင်းသွင်းမှု ရှာမတွေ့ပါ</p>
      <p className="mt-4 max-w-sm text-sm text-gray-500">{message}</p>
    </div>
  );
}

// ─── Upload section ──────────────────────────────────────────────────────────

function UploadSection({
  enrollmentRef,
  onUploadSuccess,
}: {
  enrollmentRef: string;
  onUploadSuccess: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<{ en: string; mm: string } | null>(null);
  const [uploadDone, setUploadDone] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);

    // Validate file is an image
    if (!file.type.startsWith("image/")) {
      setUploadError({
        en: "Please select an image file.",
        mm: "ဓာတ်ပုံဖိုင် ရွေးချယ်ပါ။",
      });
      return;
    }
    // Validate size
    if (file.size > 5 * 1024 * 1024) {
      setUploadError({
        en: "File too large. Please use a smaller image (max 5 MB).",
        mm: "ဖိုင်အရွယ်အစား ကြီးလွန်းသည်။ ပိုသေးသော ဓာတ်ပုံ သုံးပါ (အများဆုံး ၅ MB)။",
      });
      return;
    }

    setSelectedFile(file);
    // Revoke previous preview URL to avoid memory leaks
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(file));
  }

  async function handleUpload() {
    if (!selectedFile || uploadingRef.current) return;
    uploadingRef.current = true;
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append("enrollment_ref", enrollmentRef);
      formData.append("proof_image", selectedFile);

      // Use XMLHttpRequest for upload progress tracking
      const result = await new Promise<{ ok: boolean; body: Record<string, string> }>(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();

          xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 100);
              setUploadProgress(pct);
            }
          });

          xhr.addEventListener("load", () => {
            let body = {};
            try { body = JSON.parse(xhr.responseText); } catch { /* empty */ }
            resolve({ ok: xhr.status >= 200 && xhr.status < 300, body: body as Record<string, string> });
          });

          xhr.addEventListener("error", () => reject(new Error("network")));
          xhr.addEventListener("abort", () => reject(new Error("aborted")));

          xhr.open("POST", "/api/public/payments/upload");
          xhr.send(formData);
        },
      );

      if (!result.ok) {
        setUploadError({
          en: result.body.message || "Upload failed. Please try again.",
          mm: result.body.message_mm || "တင်သွင်းမှု မအောင်မြင်ပါ။ ထပ်မံကြိုးစားပါ။",
        });
        return;
      }

      setUploadProgress(100);
      setUploadDone(true);
      onUploadSuccess();
    } catch {
      setUploadError({
        en: "Network error. Please check your connection and try again.",
        mm: "ကွန်ရက်ချိတ်ဆက်မှု မအောင်မြင်ပါ။ ထပ်မံကြိုးစားပါ။",
      });
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  }

  function handleRetry() {
    setUploadError(null);
    setUploadProgress(0);
  }

  // ── Success screen ──────────────────────────────────────────
  if (uploadDone) {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 p-8 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
          <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="text-xl font-bold text-green-800">Payment submitted for review!</h3>
        <p className="font-myanmar mt-1 text-green-700">
          စစ်ဆေးရန် တင်ပြပြီးပါပြီ
        </p>

        <div className="mt-5 rounded-lg bg-white/70 px-4 py-3">
          <p className="text-xs text-gray-500">Enrollment Reference</p>
          <p className="font-mono text-lg font-bold text-[#1a6b3c]">{enrollmentRef}</p>
        </div>

        <p className="mt-5 text-sm text-gray-600">
          We will review your payment and confirm your enrollment shortly.
        </p>
        <p className="font-myanmar mt-1 text-sm text-gray-500">
          သင့်ငွေပေးချေမှုကို စစ်ဆေးပြီး စာရင်းသွင်းမှုကို မကြာမီ အတည်ပြုပေးပါမည်။
        </p>
      </div>
    );
  }

  // ── Upload form ─────────────────────────────────────────────
  return (
    <div id="upload-section">
      <h3 className="mb-2 text-lg font-semibold text-gray-900">
        Upload Transfer Screenshot
      </h3>
      <p className="font-myanmar mb-5 text-sm text-gray-500">
        ငွေလွှဲပြေစာ တင်သွင်းပါ
      </p>

      {/* File picker area */}
      <div
        onClick={() => fileInputRef.current?.click()}
        className={`cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          preview ? "border-[#1a6b3c] bg-green-50/50" : "border-gray-300 hover:border-gray-400 hover:bg-gray-50"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileSelect}
          className="hidden"
        />
        {preview ? (
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="Payment screenshot preview" className="mx-auto mb-3 max-h-56 rounded-lg shadow-sm" />
            <p className="text-sm text-gray-500">Tap to change image</p>
            <p className="font-myanmar text-xs text-gray-400">ဓာတ်ပုံ ပြောင်းရန် နှိပ်ပါ</p>
          </div>
        ) : (
          <div>
            {/* Camera icon */}
            <svg className="mx-auto mb-4 h-14 w-14 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.2}
                d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.2}
                d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <p className="text-base font-medium text-gray-600">
              Tap to select screenshot
            </p>
            <p className="font-myanmar mt-1 text-sm text-gray-400">
              ဓာတ်ပုံ ရွေးချယ်ရန် နှိပ်ပါ
            </p>
            <p className="mt-3 text-xs text-gray-400">
              Supports all image formats (max 5 MB)
            </p>
          </div>
        )}
      </div>

      {/* Error message */}
      {uploadError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-medium text-red-700">{uploadError.en}</p>
          <p className="font-myanmar mt-0.5 text-sm text-red-600">{uploadError.mm}</p>
          {uploading === false && (
            <button
              onClick={handleRetry}
              className="mt-2 text-sm font-semibold text-red-700 underline hover:text-red-800"
            >
              Try again / <span className="font-myanmar">ထပ်မံကြိုးစားပါ</span>
            </button>
          )}
        </div>
      )}

      {/* Progress bar */}
      {uploading && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-xs text-gray-500">
            <span>Uploading...</span>
            <span>{uploadProgress}%</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-gray-200">
            <div
              className="h-full rounded-full bg-[#1a6b3c] transition-all duration-300"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Submit button */}
      <button
        onClick={handleUpload}
        disabled={!selectedFile || uploading}
        className={`mt-5 w-full rounded-lg py-3.5 text-sm font-semibold transition-colors ${
          selectedFile && !uploading
            ? "bg-[#1a6b3c] text-white hover:bg-[#155d33]"
            : "cursor-not-allowed bg-gray-200 text-gray-400"
        }`}
      >
        {uploading ? (
          <span className="inline-flex items-center justify-center gap-2">
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Uploading...
          </span>
        ) : (
          <>
            Submit Payment Proof / <span className="font-myanmar">တင်သွင်းမည်</span>
          </>
        )}
      </button>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function PaymentInstructionsPage() {
  const params = useParams<{ ref: string }>();
  const [enrollment, setEnrollment] = useState<EnrollmentInfo | null>(null);
  const [bankAccounts, setBankAccounts] = useState<BankAccountInfo[]>([]);
  const [availableClasses, setAvailableClasses] = useState<AvailableClass[]>([]);
  const [orgType, setOrgType] = useState<string>("language_school");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch other available classes from the same intake
  async function fetchAvailableClasses(intakeSlug: string, currentClassId: string | null) {
    try {
      const res = await fetch(`/api/public/enroll/${encodeURIComponent(intakeSlug)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.labels?.orgType) setOrgType(data.labels.orgType);
      const classes = (data.classes ?? []) as AvailableClass[];
      // Filter out current class and full classes
      setAvailableClasses(
        classes.filter((c) => c.id !== currentClassId && c.status === "open" && c.seat_remaining > 0),
      );
    } catch {
      // Non-critical — silently ignore
    }
  }

  useEffect(() => {
    async function fetchData() {
      try {
        const [statusRes, banksRes] = await Promise.all([
          fetch(`/api/public/status?ref=${encodeURIComponent(params.ref)}`),
          fetch("/api/public/bank-accounts"),
        ]);

        if (!statusRes.ok) {
          const body = await statusRes.json().catch(() => ({}));
          setError(body.message || "Enrollment not found.");
          return;
        }

        const statusData: EnrollmentInfo = await statusRes.json();
        setEnrollment(statusData);

        if (banksRes.ok) {
          const banksData: BankAccountInfo[] = await banksRes.json();
          setBankAccounts(banksData);
        }

        // Fetch intake data (for orgType labels + available classes)
        if (statusData.intake_slug) {
          try {
            const intakeRes = await fetch(`/api/public/enroll/${encodeURIComponent(statusData.intake_slug)}`);
            if (intakeRes.ok) {
              const intakeData = await intakeRes.json();
              if (intakeData.labels?.orgType) setOrgType(intakeData.labels.orgType);
              if (statusData.status !== "pending_payment") {
                const classes = (intakeData.classes ?? []) as AvailableClass[];
                setAvailableClasses(
                  classes.filter((c) => c.id !== statusData.class_id && c.status === "open" && c.seat_remaining > 0),
                );
              }
            }
          } catch { /* non-critical */ }
        }
      } catch {
        setError("Failed to load payment information. Please try again.");
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [params.ref]);

  function handleUploadSuccess() {
    // Re-fetch enrollment to update status
    fetch(`/api/public/status?ref=${encodeURIComponent(params.ref)}`)
      .then((res) => res.json())
      .then((data: EnrollmentInfo) => {
        setEnrollment(data);
        // Fetch available classes after upload
        if (data.intake_slug) {
          fetchAvailableClasses(data.intake_slug, data.class_id);
        }
      })
      .catch(() => {});
  }

  if (loading) return <LoadingSkeleton />;
  if (error || !enrollment) return <ErrorPage message={error || "Unknown error"} />;

  const feeEn = formatMMKSimple(enrollment.fee_mmk ?? 0);       // "300,000 MMK"
  const feeMm = formatMMK(enrollment.fee_mmk ?? 0).replace(" MMK", ""); // "၃၀၀,၀၀၀"
  const showUpload = enrollment.status === "pending_payment";

  return (
    <div className="mx-auto max-w-lg">
      {/* ── Success header ─────────────────────────────────────── */}
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
          <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">
          {orgType === "event" ? "Order Submitted!" : "Enrollment Submitted!"}
        </h1>
        {orgType !== "event" && (
          <p className="font-myanmar mt-1 text-lg text-gray-600">
            စာရင်းသွင်းမှု အောင်မြင်ပြီ
          </p>
        )}
      </div>

      {/* ── Enrollment reference box ───────────────────────────── */}
      <div className="mb-8 rounded-xl bg-[#1a6b3c]/10 p-5">
        <p className="mb-2 text-center text-xs font-semibold uppercase tracking-wide text-[#1a6b3c]">
          {orgType === "event" ? "Your Order Reference" : "Your Enrollment Reference"}
        </p>
        {orgType !== "event" && (
          <p className="font-myanmar mb-3 text-center text-xs text-gray-500">
            သင့်စာရင်းသွင်းမှု ရည်ညွှန်းကုဒ်
          </p>
        )}
        <div className="flex items-center justify-center gap-3">
          <span className="font-mono text-[2rem] font-bold leading-tight text-[#1a6b3c]">
            {enrollment.enrollment_ref}
          </span>
        </div>
        <div className="mt-3 flex justify-center">
          <CopyButton text={enrollment.enrollment_ref} />
        </div>
      </div>

      {/* ── Payment instructions ───────────────────────────────── */}
      <div className="mb-8">
        <h2 className="mb-5 text-lg font-semibold text-gray-900">
          {orgType === "event"
            ? "How to Pay"
            : <>How to Pay / <span className="font-myanmar">ငွေပေးချေနည်း</span></>}
        </h2>

        <ol className="space-y-4">
          <li className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1a6b3c] text-sm font-bold text-white">
              1
            </span>
            <div className="text-sm text-gray-700">
              <p>
                Transfer <span className="font-semibold text-gray-900">{feeEn}</span> to
                one of the accounts below
              </p>
              {orgType !== "event" && (
                <p className="font-myanmar mt-1 text-gray-500">
                  အောက်ပါ အကောင့်များသို့{" "}
                  <span className="font-semibold text-gray-700">
                    {feeMm} ကျပ်
                  </span>{" "}
                  လွှဲပါ
                </p>
              )}
            </div>
          </li>

          <li className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1a6b3c] text-sm font-bold text-white">
              2
            </span>
            <div className="text-sm text-gray-700">
              <p>
                Use your enrollment ref{" "}
                <span className="font-mono font-bold text-red-600">{enrollment.enrollment_ref}</span>{" "}
                as the transfer note
              </p>
              {orgType !== "event" && (
                <p className="font-myanmar mt-1 text-gray-500">
                  ငွေလွှဲမှတ်ချက်တွင်{" "}
                  <span className="font-mono font-bold text-red-600">{enrollment.enrollment_ref}</span>{" "}
                  ကို ထည့်ပါ
                </p>
              )}
            </div>
          </li>

          <li className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1a6b3c] text-sm font-bold text-white">
              3
            </span>
            <div className="text-sm text-gray-700">
              <p>Take a screenshot of the transfer confirmation</p>
              {orgType !== "event" && (
                <p className="font-myanmar mt-1 text-gray-500">
                  ငွေလွှဲပြီးကြောင်း ဓာတ်ပုံ ရိုက်ပါ
                </p>
              )}
            </div>
          </li>

          <li className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1a6b3c] text-sm font-bold text-white">
              4
            </span>
            <div className="text-sm text-gray-700">
              <p>Upload the screenshot below</p>
              {orgType !== "event" && (
                <p className="font-myanmar mt-1 text-gray-500">
                  အောက်တွင် ဓာတ်ပုံ တင်သွင်းပါ
                </p>
              )}
            </div>
          </li>
        </ol>
      </div>

      {/* ── Bank accounts ──────────────────────────────────────── */}
      {bankAccounts.length > 0 && (
        <div className="mb-8">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Bank Accounts{orgType !== "event" && <> / <span className="font-myanmar normal-case">ဘဏ်အကောင့်များ</span></>}
          </h3>
          <div className="space-y-3">
            {bankAccounts.map((account, i) => (
              <div
                key={i}
                className="rounded-xl border border-gray-200 bg-white p-4"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span
                      className={`mb-1.5 inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        BANK_COLORS[account.bank_name] ?? "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {account.bank_name}
                    </span>
                    <p className="text-sm font-medium text-gray-900">{account.account_holder}</p>
                    {account.account_number && (
                      <p className="font-mono text-sm text-gray-600">{account.account_number}</p>
                    )}
                  </div>
                  {!account.qr_code_url && account.account_number && (
                    <CopyButton text={account.account_number} size="small" />
                  )}
                </div>
                {account.qr_code_url && (
                  <div className="mt-3 flex flex-col items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={account.qr_code_url}
                      alt={`${account.bank_name} QR Code`}
                      className="w-full max-w-xs rounded-lg border border-gray-100 object-contain bg-white"
                    />
                    {account.account_number && (
                      <CopyButton text={account.account_number} size="small" />
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Upload payment screenshot button / section ─────────── */}
      {showUpload ? (
        <>
          <a
            href="#upload-section"
            className="mb-8 flex w-full items-center justify-center gap-2 rounded-lg border-2 border-[#1a6b3c] bg-white py-3 text-sm font-semibold text-[#1a6b3c] hover:bg-[#1a6b3c]/5 transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            {orgType === "event"
            ? "Upload Payment Screenshot"
            : <>Upload Payment Screenshot / <span className="font-myanmar">ငွေလွှဲပြေစာ တင်သွင်းမည်</span></>}
          </a>

          <div className="border-t border-gray-200 pt-8">
            <UploadSection
              enrollmentRef={enrollment.enrollment_ref}
              onUploadSuccess={handleUploadSuccess}
            />
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-5 text-center">
          <p className="font-semibold text-blue-800">{enrollment.status_label_en}</p>
          <p className="font-myanmar mt-1 text-sm text-blue-700">{enrollment.status_label_mm}</p>
        </div>
      )}

      {/* ── Other available classes ────────────────────────────────── */}
      {!showUpload && availableClasses.length > 0 && enrollment.intake_slug && (
        <div className="mt-10 border-t border-gray-200 pt-8">
          <h3 className="mb-2 text-center text-lg font-semibold text-gray-900">
            {orgType === "event" ? "Buy Another Ticket" : "Enroll in Another Class"}
          </h3>
          {orgType !== "event" && (
            <p className="font-myanmar mb-6 text-center text-sm text-gray-500">
              အခြားသင်တန်းတစ်ခု ထပ်မံစာရင်းသွင်းမည်
            </p>
          )}
          <div className="space-y-3">
            {availableClasses.map((cls) => (
              <a
                key={cls.id}
                href={`/enroll/${enrollment.intake_slug}`}
                className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4 transition-colors hover:border-[#1a3f8a] hover:bg-blue-50/50"
              >
                <div>
                  <p className="text-base font-semibold text-gray-900">{cls.level}</p>
                  <p className="text-sm text-gray-500">{cls.fee_formatted}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-400">
                    {cls.seat_remaining} {orgType === "event" ? "left" : "seats left"}
                  </span>
                  <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
