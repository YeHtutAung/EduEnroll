import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AccountBoundToggle, {
  ACCOUNT_BOUND_HELP,
  ACCOUNT_BOUND_TRACKING_HELP,
} from "@/components/admin/AccountBoundToggle";

// Task 14: the switch on the event edit form.

function checkbox(html: string): string {
  return html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? "";
}

describe("AccountBoundToggle", () => {
  it("is labelled and carries both helper texts, including decision 8's", () => {
    const html = renderToStaticMarkup(<AccountBoundToggle checked={false} hasOrders={false} onChange={() => {}} />);
    expect(html).toContain("Account-bound tickets (stop resale)");
    expect(html).toContain(ACCOUNT_BOUND_HELP.replace(/'/g, "&#x27;"));
    expect(html).toContain(ACCOUNT_BOUND_TRACKING_HELP);
    expect(ACCOUNT_BOUND_HELP).toBe(
      "Buyers sign in to buy, and tickets work only on the buyer's phone as a live QR. Can't be changed once the event has orders.",
    );
    expect(ACCOUNT_BOUND_TRACKING_HELP).toBe(
      "While this event is on sale or upcoming, ad tracking (Google Tag Manager) is off on your whole site.",
    );
  });

  it("is enabled while the event has no orders", () => {
    const box = checkbox(renderToStaticMarkup(<AccountBoundToggle checked={false} hasOrders={false} onChange={() => {}} />));
    expect(box).not.toContain("disabled");
    expect(box).not.toContain("checked");
  });

  it("is disabled once the event has orders, and shows the saved value", () => {
    const box = checkbox(renderToStaticMarkup(<AccountBoundToggle checked hasOrders onChange={() => {}} />));
    expect(box).toContain('disabled=""');
    expect(box).toContain('checked=""');
  });
});
