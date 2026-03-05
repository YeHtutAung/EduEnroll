"use client";

import { useEffect } from "react";

interface ConfirmModalProps {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: "danger" | "success";
  confirmLabel?: string;
  cancelLabel?: string;
}

export default function ConfirmModal({
  title,
  message,
  onConfirm,
  onCancel,
  variant = "danger",
  confirmLabel,
  cancelLabel = "Cancel",
}: ConfirmModalProps) {
  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  const isDanger = variant === "danger";
  const defaultConfirmLabel = isDanger ? "Delete" : "Confirm";
  const btnClass = isDanger
    ? "bg-[#c0392b] hover:bg-red-700 focus-visible:ring-red-500"
    : "bg-[#1a6b3c] hover:bg-green-800 focus-visible:ring-green-500";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-xl p-6">
        {/* Icon */}
        <div
          className={`w-11 h-11 rounded-full flex items-center justify-center mb-4 ${
            isDanger ? "bg-red-100" : "bg-emerald-100"
          }`}
        >
          {isDanger ? (
            <svg
              className="w-5 h-5 text-[#c0392b]"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
              />
            </svg>
          ) : (
            <svg
              className="w-5 h-5 text-[#1a6b3c]"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          )}
        </div>

        <h2 id="modal-title" className="text-lg font-semibold text-gray-900">
          {title}
        </h2>
        <p className="mt-2 text-sm text-gray-500">{message}</p>

        <div className="mt-6 flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 transition-colors ${btnClass}`}
          >
            {confirmLabel ?? defaultConfirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
