type EnrollmentStatus = "pending_payment" | "payment_submitted" | "confirmed" | "rejected";
type ClassStatus = "open" | "full" | "closed" | "draft";
type BadgeStatus = EnrollmentStatus | ClassStatus;

const STATUS_CONFIG: Record<
  BadgeStatus,
  { label: string; bg: string; text: string; border: string }
> = {
  pending_payment: {
    label: "Pending Payment",
    bg: "bg-amber-50",
    text: "text-amber-800",
    border: "border-amber-300",
  },
  payment_submitted: {
    label: "Payment Submitted",
    bg: "bg-sky-50",
    text: "text-sky-800",
    border: "border-sky-300",
  },
  confirmed: {
    label: "Confirmed",
    bg: "bg-emerald-50",
    text: "text-emerald-800",
    border: "border-emerald-300",
  },
  rejected: {
    label: "Rejected",
    bg: "bg-red-50",
    text: "text-red-700",
    border: "border-red-300",
  },
  open: {
    label: "Open",
    bg: "bg-emerald-50",
    text: "text-emerald-800",
    border: "border-emerald-300",
  },
  full: {
    label: "Full",
    bg: "bg-orange-50",
    text: "text-orange-700",
    border: "border-orange-300",
  },
  closed: {
    label: "Closed",
    bg: "bg-gray-100",
    text: "text-gray-600",
    border: "border-gray-300",
  },
  draft: {
    label: "Draft",
    bg: "bg-gray-100",
    text: "text-gray-500",
    border: "border-gray-300",
  },
};

interface StatusBadgeProps {
  status: BadgeStatus;
  className?: string;
}

export default function StatusBadge({ status, className = "" }: StatusBadgeProps) {
  const cfg = STATUS_CONFIG[status] ?? {
    label: status,
    bg: "bg-gray-100",
    text: "text-gray-600",
    border: "border-gray-300",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${cfg.bg} ${cfg.text} ${cfg.border} ${className}`}
    >
      {cfg.label}
    </span>
  );
}
