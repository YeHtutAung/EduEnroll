import { describe, it, expect } from "vitest";
import { holderHistoryLine } from "@/app/admin/students/holderHistory";

// ─── Seat holder history in the order's Account section (plan 4) ───────────
// from → to names where the seat went, so it shows only for the events that
// move a seat between accounts.

const at = "2026-11-20T10:00:00Z";

describe("holderHistoryLine", () => {
  it.each(["claimed", "given_back", "order_moved"])("%s shows from → to", (event) => {
    const line = holderHistoryLine({ at, event, by: "a***@x.com", from: "a***@x.com", to: "b***@y.com" });
    expect(line).toContain("a***@x.com → b***@y.com");
    expect(line).toContain("by a***@x.com");
  });

  it("a moving event with one side missing shows a dash", () => {
    expect(holderHistoryLine({ at, event: "claimed", by: null, from: null, to: "b***@y.com" })).toContain(
      "— → b***@y.com",
    );
  });

  it.each(["link_created", "link_cancelled", "holder_deleted", "voided"])(
    "%s shows only the event and actor",
    (event) => {
      const line = holderHistoryLine({ at, event, by: "a***@x.com", from: "a***@x.com", to: "b***@y.com" });
      expect(line).not.toContain("→");
      expect(line).toContain("by a***@x.com");
    },
  );

  it("labels known events and passes unknown ones through", () => {
    expect(holderHistoryLine({ at, event: "claimed", by: null, from: null, to: null })).toContain("Seat claimed");
    expect(holderHistoryLine({ at, event: "something_new", by: null, from: null, to: null })).toContain(
      "something_new",
    );
  });
});
