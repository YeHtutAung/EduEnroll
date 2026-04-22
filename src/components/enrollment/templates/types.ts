import type { ClassStatus, TenantAppearance } from "@/types/database";

export interface TemplateClass {
  id: string;
  level: string;
  fee_amount: number;
  fee_formatted: string;
  seat_remaining: number;
  seat_total: number;
  enrollment_open_at: string | null;
  enrollment_close_at: string | null;
  status: ClassStatus;
  mode?: "online" | "offline";
  event_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  venue?: string | null;
  image_url?: string | null;
  max_tickets_per_person?: number;
}

export interface TemplateIntake {
  id: string;
  name: string;
  year: number;
  status: string;
  hero_image_url?: string | null;
}

export interface TemplateLabels {
  intake: string;
  class: string;
  student: string;
  seat: string;
  fee: string;
  orgType: string;
  currency: string;
}

export interface TemplateProps {
  appearance: Omit<TenantAppearance, "id" | "tenant_id" | "updated_at">;
  intake: TemplateIntake;
  classes: TemplateClass[];
  labels: TemplateLabels;
  slug: string;
  onSelectClass: (classId: string) => void;
}

export interface EventTemplateProps {
  appearance: Omit<TenantAppearance, "id" | "tenant_id" | "updated_at">;
  intake: TemplateIntake;
  classes: TemplateClass[];
  labels: TemplateLabels;
  slug: string;
  currency: string;
  onSelect: (classId: string, quantity: number) => void;
  onCartCheckout: (cartItems: { class_id: string; level: string; quantity: number; fee_amount: number; image_url: string | null }[]) => void;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

export function getCardState(cls: TemplateClass) {
  const isFull = cls.status === "full" || cls.seat_remaining === 0;
  const now = new Date();
  const notYetOpen = cls.enrollment_open_at ? now < new Date(cls.enrollment_open_at) : false;
  const alreadyClosed = cls.enrollment_close_at ? now > new Date(cls.enrollment_close_at) : false;
  const isDisabled = isFull || notYetOpen || alreadyClosed;
  const overlayState = isFull ? "full" : notYetOpen ? "not_open" : alreadyClosed ? "closed" : null;
  return { isFull, notYetOpen, alreadyClosed, isDisabled, overlayState };
}

export function fmtDate(iso: string, opts?: Intl.DateTimeFormatOptions) {
  return new Date(iso).toLocaleDateString("en-GB", opts ?? { day: "numeric", month: "short", year: "numeric" });
}

export const LEVEL_COLORS: Record<string, string> = {
  N5: "bg-emerald-100 text-emerald-800",
  N4: "bg-blue-100 text-blue-800",
  N3: "bg-purple-100 text-purple-800",
  N2: "bg-orange-100 text-orange-800",
  N1: "bg-red-100 text-red-800",
};
