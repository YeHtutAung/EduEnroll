"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

// ── Types ────────────────────────────────────────────────────────────────────

type ToastVariant = "success" | "error" | "info";

interface ToastItem {
  id: string;
  variant: ToastVariant;
  message: string;
}

interface ToastContextValue {
  addToast: (variant: ToastVariant, message: string) => void;
  removeToast: (id: string) => void;
}

// ── Context ──────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (variant: ToastVariant, message: string) => {
      const id = Math.random().toString(36).slice(2, 9);
      setToasts((prev) => [...prev, { id, variant, message }]);
      setTimeout(() => removeToast(id), 3000);
    },
    [removeToast],
  );

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      {/* Toast stack — bottom-right */}
      <div
        className="fixed bottom-5 right-5 z-[200] flex flex-col-reverse gap-2 pointer-events-none"
        aria-live="polite"
        aria-label="Notifications"
      >
        {toasts.map((toast) => (
          <ToastBubble key={toast.id} toast={toast} onDismiss={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ── Individual toast bubble ───────────────────────────────────────────────────

const VARIANT_STYLES: Record<
  ToastVariant,
  { bg: string; icon: string; ring: string }
> = {
  success: { bg: "bg-[#1a6b3c]", icon: "✓", ring: "ring-green-700" },
  error:   { bg: "bg-[#c0392b]", icon: "✕", ring: "ring-red-700" },
  info:    { bg: "bg-[#0891b2]", icon: "ℹ", ring: "ring-sky-700" },
};

function ToastBubble({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const s = VARIANT_STYLES[toast.variant];

  return (
    <div
      role="alert"
      className={`pointer-events-auto flex items-start gap-3 rounded-xl px-4 py-3 shadow-lg ring-1 text-white min-w-[280px] max-w-sm animate-in fade-in slide-in-from-bottom-2 duration-200 ${s.bg} ${s.ring}`}
    >
      <span className="text-base font-bold leading-none mt-0.5 shrink-0">
        {s.icon}
      </span>
      <p className="flex-1 text-sm leading-snug">{toast.message}</p>
      <button
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="shrink-0 text-white/60 hover:text-white text-xl leading-none transition-colors"
      >
        ×
      </button>
    </div>
  );
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");

  return {
    success: (message: string) => ctx.addToast("success", message),
    error:   (message: string) => ctx.addToast("error", message),
    info:    (message: string) => ctx.addToast("info", message),
  };
}
