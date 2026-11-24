// ─── "Smartphone required" on a protected event (design 5.6) ────────────────
//
// Shown on the event page, the tickets page, the form and the checkout when
// intake.ticket_protection is true. Account-bound tickets work only as the
// live QR on the buyer's own phone.
//
// NEEDS NATIVE REVIEW: the Myanmar line is a draft; have a native speaker check
// it before this reaches main.

export const PROTECTED_NOTICE_EN = "Smartphone required. Open your ticket before you arrive.";
export const PROTECTED_NOTICE_MM = "စမတ်ဖုန်း လိုအပ်ပါသည်။ မရောက်မီ သင့်လက်မှတ်ကို ဖွင့်ထားပါ။";

export default function ProtectedNotice({ className = "" }: { className?: string }) {
  return (
    <div
      role="note"
      data-protected-notice=""
      className={`rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 ${className}`}
    >
      <p className="text-sm font-semibold">{PROTECTED_NOTICE_EN}</p>
      <p className="font-myanmar mt-1 text-xs text-amber-800">{PROTECTED_NOTICE_MM}</p>
    </div>
  );
}
