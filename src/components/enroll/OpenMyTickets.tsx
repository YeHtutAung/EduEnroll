import { ACCOUNT_TICKETS_PATH } from "@/lib/tickets/accountTickets";

// ─── "Open My Tickets" on the order pages (design 6.3, 8.1) ─────────────────
//
// Shown on the checkout success page and /enroll/payment/[ref] when the order
// has tickets on an account-bound event. Those tickets have no QR or PDF here;
// they open only on the buyer's signed-in ticket page, on the same host.
//
// NEEDS NATIVE REVIEW: the Myanmar lines are drafts.

export const OPEN_MY_TICKETS_EN = "Open My Tickets";
export const OPEN_MY_TICKETS_MM = "ကျွန်ုပ်၏ လက်မှတ်များကို ဖွင့်ရန်";
export const ACCOUNT_TICKETS_LINE_EN = "Your ticket is on your account. Sign in on this site to open it.";
export const ACCOUNT_TICKETS_LINE_MM =
  "သင့်လက်မှတ်သည် သင့်အကောင့်ထဲတွင် ရှိပါသည်။ ဤဝက်ဘ်ဆိုက်တွင် အကောင့်ဝင်၍ ဖွင့်ပါ။";

export default function OpenMyTickets({ count, className = "" }: { count: number; className?: string }) {
  if (count <= 0) return null;

  return (
    <div
      data-account-tickets=""
      className={`rounded-xl border border-blue-200 bg-blue-50 p-4 text-center ${className}`}
    >
      <a
        href={ACCOUNT_TICKETS_PATH}
        className="inline-flex w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-bold text-white"
        style={{ background: "#0f1f42" }}
      >
        {OPEN_MY_TICKETS_EN} / <span className="font-myanmar ml-1">{OPEN_MY_TICKETS_MM}</span>
      </a>
      <p className="mt-2 text-xs text-blue-900">{ACCOUNT_TICKETS_LINE_EN}</p>
      <p className="font-myanmar mt-1 text-xs text-blue-800">{ACCOUNT_TICKETS_LINE_MM}</p>
    </div>
  );
}
