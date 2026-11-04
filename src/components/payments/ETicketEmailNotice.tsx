/**
 * Tells a buyer on the confirmed-order page that their e-tickets come by email.
 *
 * Only for an event order with tickets known to exist. A failed or empty lookup
 * shows "contact support" at the download button, and promising an email here
 * would contradict it. `ticketCount` is null while that is still unknown.
 */
export default function ETicketEmailNotice({
  orgType,
  ticketCount,
}: {
  orgType?: string | null;
  ticketCount: number | null;
}) {
  if (orgType !== "event" || !ticketCount) return null;

  return (
    <div
      data-testid="eticket-email-notice"
      className="mt-4 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-left"
    >
      <span
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white"
      >
        <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
          />
        </svg>
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-emerald-900">You will get your e-tickets via email</p>
        <p className="font-myanmar mt-0.5 text-sm text-emerald-800">
          သင့် E-Ticket များကို email မှတစ်ဆင့် ရရှိပါမည်
        </p>
        <p className="mt-1 text-xs text-emerald-700">
          Check your inbox and spam folder. / <span className="font-myanmar">Inbox နှင့် Spam folder ကို စစ်ဆေးပါ။</span>
        </p>
      </div>
    </div>
  );
}
