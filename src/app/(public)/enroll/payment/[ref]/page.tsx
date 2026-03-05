"use client";

import { useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import { formatMMK } from "@/lib/utils";
import type { MyanmarBank } from "@/types/database";

// ─── Types ────────────────────────────────────────────────────────────────────

interface EnrollmentInfo {
  enrollment_ref: string;
  student_name_en: string;
  student_name_mm: string | null;
  class_level: string | null;
  fee_mmk: number | null;
  fee_formatted: string | null;
  status: string;
  status_label_en: string;
  status_label_mm: string;
}

interface BankAccountInfo {
  bank_name: MyanmarBank;
  account_number: string;
  account_holder: string;
}

// ─── Myanmar numerals ────────────────────────────────────────────────────────

const MM_DIGITS: Record<string, string> = {
  "0": "၀", "1": "၁", "2": "၂", "3": "၃", "4": "၄",
  "5": "၅", "6": "၆", "7": "၇", "8": "၈", "9": "၉",
};

function toMM(str: string): string {
  return str.replace(/[0-9]/g, (d) => MM_DIGITS[d]);
}

// ─── Bank badge colors ───────────────────────────────────────────────────────

const BANK_COLORS: Record<string, string> = {
  KBZ:   "bg-green-100 text-green-800",
  AYA:   "bg-blue-100 text-blue-800",
  CB:    "bg-yellow-100 text-yellow-800",
  UAB:   "bg-purple-100 text-purple-800",
  Yoma:  "bg-orange-100 text-orange-800",
  Other: "bg-gray-100 text-gray-700",
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
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadDone, setUploadDone] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);

    // Validate type + size
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) {
      setUploadError("Only JPEG, PNG, or WebP images are allowed.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError("File must be under 5 MB.");
      return;
    }

    setSelectedFile(file);
    setPreview(URL.createObjectURL(file));
  }

  async function handleUpload() {
    if (!selectedFile) return;
    setUploading(true);
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append("enrollment_ref", enrollmentRef);
      formData.append("proof_image", selectedFile);

      const res = await fetch("/api/public/payments/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setUploadError(body.message || "Upload failed. Please try again.");
        return;
      }

      setUploadDone(true);
      onUploadSuccess();
    } catch {
      setUploadError("Network error. Please check your connection.");
    } finally {
      setUploading(false);
    }
  }

  if (uploadDone) {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 p-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
          <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="font-semibold text-green-800">Payment Proof Uploaded!</p>
        <p className="font-myanmar mt-1 text-sm text-green-700">
          ငွေပေးချေမှု အထောက်အထား တင်သွင်းပြီးပါပြီ
        </p>
        <p className="mt-3 text-sm text-gray-600">
          We will review your payment and confirm your enrollment shortly.
        </p>
        <p className="font-myanmar mt-1 text-sm text-gray-500">
          သင့်ငွေပေးချေမှုကို စစ်ဆေးပြီး စာရင်းသွင်းမှုကို မကြာမီ အတည်ပြုပေးပါမည်။
        </p>
      </div>
    );
  }

  return (
    <div id="upload-section">
      <h3 className="mb-4 text-lg font-semibold text-gray-900">
        Upload Payment Screenshot / <span className="font-myanmar">ငွေလွှဲပြေစာ ဓာတ်ပုံ တင်သွင်းပါ</span>
      </h3>

      {/* File picker area */}
      <div
        onClick={() => fileInputRef.current?.click()}
        className={`cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          preview ? "border-[#1a6b3c] bg-green-50/50" : "border-gray-300 hover:border-gray-400"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileSelect}
          className="hidden"
        />
        {preview ? (
          <div>
            <img src={preview} alt="Preview" className="mx-auto mb-3 max-h-48 rounded-lg" />
            <p className="text-sm text-gray-500">Click to change image</p>
          </div>
        ) : (
          <div>
            <svg className="mx-auto mb-3 h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <p className="text-sm font-medium text-gray-600">
              Tap to select screenshot
            </p>
            <p className="font-myanmar mt-1 text-sm text-gray-400">
              ဓာတ်ပုံ ရွေးချယ်ရန် နှိပ်ပါ
            </p>
            <p className="mt-2 text-xs text-gray-400">JPEG, PNG, or WebP (max 5 MB)</p>
          </div>
        )}
      </div>

      {uploadError && (
        <p className="mt-3 text-sm text-red-600">{uploadError}</p>
      )}

      {selectedFile && (
        <button
          onClick={handleUpload}
          disabled={uploading}
          className="mt-4 w-full rounded-lg bg-[#1a6b3c] py-3 text-sm font-semibold text-white hover:bg-[#155d33] transition-colors disabled:opacity-50"
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
              Upload Screenshot / <span className="font-myanmar">ဓာတ်ပုံ တင်သွင်းမည်</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function PaymentInstructionsPage() {
  const params = useParams<{ ref: string }>();
  const [enrollment, setEnrollment] = useState<EnrollmentInfo | null>(null);
  const [bankAccounts, setBankAccounts] = useState<BankAccountInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      .then((data) => setEnrollment(data))
      .catch(() => {});
  }

  if (loading) return <LoadingSkeleton />;
  if (error || !enrollment) return <ErrorPage message={error || "Unknown error"} />;

  const feeFormatted = enrollment.fee_formatted ?? formatMMK(enrollment.fee_mmk ?? 0);
  const feeMMK = enrollment.fee_mmk ?? 0;
  const feeMyanmarOnly = feeFormatted.replace(" MMK", "");
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
        <h1 className="text-2xl font-bold text-gray-900">Enrollment Submitted!</h1>
        <p className="font-myanmar mt-1 text-lg text-gray-600">
          စာရင်းသွင်းမှု အောင်မြင်ပြီ
        </p>
      </div>

      {/* ── Enrollment reference box ───────────────────────────── */}
      <div className="mb-8 rounded-xl bg-[#1a6b3c]/10 p-5">
        <p className="mb-2 text-center text-xs font-semibold uppercase tracking-wide text-[#1a6b3c]">
          Your Enrollment Reference
        </p>
        <p className="font-myanmar mb-3 text-center text-xs text-gray-500">
          သင့်စာရင်းသွင်းမှု ရည်ညွှန်းကုဒ်
        </p>
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
          How to Pay / <span className="font-myanmar">ငွေပေးချေနည်း</span>
        </h2>

        <ol className="space-y-4">
          <li className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1a6b3c] text-sm font-bold text-white">
              1
            </span>
            <div className="text-sm text-gray-700">
              <p>
                Transfer <span className="font-semibold text-gray-900">{feeFormatted}</span> to
                one of the accounts below
              </p>
              <p className="font-myanmar mt-1 text-gray-500">
                အောက်ပါ အကောင့်များသို့{" "}
                <span className="font-semibold text-gray-700">
                  {feeMyanmarOnly} ကျပ်
                </span>{" "}
                လွှဲပါ
              </p>
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
              <p className="font-myanmar mt-1 text-gray-500">
                ငွေလွှဲမှတ်ချက်တွင်{" "}
                <span className="font-mono font-bold text-red-600">{enrollment.enrollment_ref}</span>{" "}
                ကို ထည့်ပါ
              </p>
            </div>
          </li>

          <li className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1a6b3c] text-sm font-bold text-white">
              3
            </span>
            <div className="text-sm text-gray-700">
              <p>Take a screenshot of the transfer confirmation</p>
              <p className="font-myanmar mt-1 text-gray-500">
                ငွေလွှဲပြီးကြောင်း ဓာတ်ပုံ ရိုက်ပါ
              </p>
            </div>
          </li>

          <li className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1a6b3c] text-sm font-bold text-white">
              4
            </span>
            <div className="text-sm text-gray-700">
              <p>Upload the screenshot below</p>
              <p className="font-myanmar mt-1 text-gray-500">
                အောက်တွင် ဓာတ်ပုံ တင်သွင်းပါ
              </p>
            </div>
          </li>
        </ol>
      </div>

      {/* ── Bank accounts ──────────────────────────────────────── */}
      {bankAccounts.length > 0 && (
        <div className="mb-8">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Bank Accounts / <span className="font-myanmar normal-case">ဘဏ်အကောင့်များ</span>
          </h3>
          <div className="space-y-3">
            {bankAccounts.map((account, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4"
              >
                <div>
                  <span
                    className={`mb-1.5 inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      BANK_COLORS[account.bank_name] ?? BANK_COLORS.Other
                    }`}
                  >
                    {account.bank_name}
                  </span>
                  <p className="text-sm font-medium text-gray-900">{account.account_holder}</p>
                  <p className="font-mono text-sm text-gray-600">{account.account_number}</p>
                </div>
                <CopyButton text={account.account_number} size="small" />
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
            Upload Payment Screenshot / <span className="font-myanmar">ငွေလွှဲပြေစာ တင်သွင်းမည်</span>
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
    </div>
  );
}
