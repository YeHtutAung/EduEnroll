"use client";

import { useState } from "react";

export type SavePayNowQrOutcome = "shared" | "downloaded" | "cancelled";

/**
 * Save a PayNow QR as a real image file.
 *
 * Mobile browsers prefer the Web Share API because it exposes native actions
 * such as Save Image and compatible banking apps. Desktop browsers and older
 * phones fall back to a normal PNG download.
 */
export async function savePayNowQrImage(
  imageUrl: string,
  enrollmentRef: string,
): Promise<SavePayNowQrOutcome> {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error("Could not prepare the PayNow QR image.");

  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error("The PayNow QR response was not an image.");
  }

  const safeRef = enrollmentRef.replace(/[^a-zA-Z0-9_-]/g, "-");
  const fileName = `PayNow-${safeRef}.png`;
  const file = new File([blob], fileName, { type: blob.type || "image/png" });

  if (
    typeof navigator !== "undefined"
    && typeof navigator.share === "function"
    && navigator.canShare?.({ files: [file] })
  ) {
    try {
      await navigator.share({
        files: [file],
        title: `PayNow QR — ${enrollmentRef}`,
      });
      return "shared";
    } catch (error) {
      // Cancelling the native sheet is not a download failure and must not
      // unexpectedly start a second download behind the user's back.
      if (error instanceof DOMException && error.name === "AbortError") {
        return "cancelled";
      }
      // A platform share failure falls through to the ordinary download.
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Revoking immediately can cancel the download in mobile Safari.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  return "downloaded";
}

export default function PayNowQrSaveButton({
  imageUrl,
  enrollmentRef,
}: {
  imageUrl: string;
  enrollmentRef: string;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await savePayNowQrImage(imageUrl, enrollmentRef);
    } catch {
      setError("Could not save the QR. Take a screenshot and upload it in your banking app.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="mx-auto flex items-center justify-center gap-2 rounded-lg border border-[#d8d5c9] bg-white px-4 py-2.5 text-[11.5px] font-semibold text-[#0f1f42] disabled:opacity-60"
      >
        <svg
          aria-hidden="true"
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
          />
        </svg>
        {saving ? "Preparing QR..." : "Save / Share PayNow QR"}
      </button>
      <p className="mt-1.5 text-center text-[9.5px] text-[#8b8f9a]">
        Paying on this phone? Save the QR, then open it in your banking app.
      </p>
      {error && (
        <p role="alert" className="mt-1.5 text-center text-[10px] text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
