// ─── "Account-bound tickets" on the event edit form (design 3, 9) ───────────
//
// A pure view so it renders the same under renderToStaticMarkup. Disabled once
// the event has orders: the database trigger intakes_lock_ticket_protection
// refuses the change then anyway (PATCH /api/intakes/[id] answers 409).
//
// The second helper line is decision 8 (2026-11-23): while a protected event is
// on sale or upcoming, the tenant's tag scripts are off on the whole host.

export const ACCOUNT_BOUND_HELP =
  "Buyers sign in to buy, and tickets work only on the buyer's phone as a live QR. Can't be changed once the event has orders.";
export const ACCOUNT_BOUND_TRACKING_HELP =
  "While this event is on sale or upcoming, ad tracking (Google Tag Manager) is off on your whole site.";

export default function AccountBoundToggle({
  checked,
  hasOrders,
  onChange,
}: {
  checked: boolean;
  hasOrders: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div>
      <label className={`flex items-center gap-2 text-sm font-medium text-gray-700 ${hasOrders ? "opacity-60" : "cursor-pointer"}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={hasOrders}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300"
        />
        Account-bound tickets (stop resale)
      </label>
      <p className="mt-1.5 text-xs text-gray-400">{ACCOUNT_BOUND_HELP}</p>
      <p className="mt-1 text-xs text-gray-400">{ACCOUNT_BOUND_TRACKING_HELP}</p>
    </div>
  );
}
