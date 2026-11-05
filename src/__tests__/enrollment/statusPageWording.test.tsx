import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { statusPageCopy } from "@/lib/enrollment/statusPageCopy";
import {
  LookupForm,
  StatusResult,
  StepTracker,
  type StatusInfo,
} from "@/app/(public)/enroll/[slug]/status/StatusClient";

// The public status page was written for a language school and showed the same
// words to everyone, so a ticket buyer read "Class Level" and "school tuition".
// The step line's fill also started 32px in and was 100% wide, which pushed it
// past the last step and made the page scroll sideways on a phone.

const tenantRow = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  error: null as { message: string } | null,
  slugsRead: [] as unknown[],
}));

vi.mock("next/headers", () => ({
  headers: () => new Headers({ "x-tenant-slug": "thebeatsrun" }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "beats-run-2026" }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: (_column: string, value: unknown) => {
          tenantRow.slugsRead.push(value);
          return {
            maybeSingle: async () => ({ data: tenantRow.current, error: tenantRow.error }),
          };
        },
      }),
    }),
  }),
}));

const order = (overrides: Partial<StatusInfo> = {}): StatusInfo => ({
  enrollment_ref: "TBR-1105-ABC123",
  student_name_en: "Aung Aung",
  student_name_mm: null,
  class_level: "5K Run",
  fee_amount: 30000,
  fee_formatted: "30,000 MMK",
  currency: "MMK",
  status: "confirmed",
  status_label_en: "Enrollment Confirmed",
  status_label_mm: "စာရင်းသွင်းမှု အတည်ပြုပြီး",
  payment: null,
  ...overrides,
});

const eventCopy = statusPageCopy({ org_type: "event", label_class: "Ticket Type", label_fee: "Fee" });
const schoolCopy = statusPageCopy({ org_type: "language_school", label_class: "Level", label_fee: "Fee" });

const result = (copy: typeof eventCopy, data: StatusInfo = order()) =>
  renderToStaticMarkup(<StatusResult data={data} copy={copy} slug="beats-run-2026" onReset={() => {}} />);

const SCHOOL_WORDS = /Enrollment|enrollment|Enrolled|Class Level|Back to Classes|ကျောင်းလခ|စာရင်းသွင်း/;

describe("status page for an event order", () => {
  it.each([
    ["confirmed", "Enrollment Confirmed", "စာရင်းသွင်းမှု အတည်ပြုပြီး"],
    ["rejected", "Enrollment Rejected", "စာရင်းသွင်းမှု ငြင်းဆိုထားသည်"],
  ] as const)("has no school wording in %s, whatever the API's label says", (status, en, mm) => {
    const html = result(eventCopy, order({ status, status_label_en: en, status_label_mm: mm }));
    expect(html).not.toMatch(SCHOOL_WORDS);
  });

  it("names the confirmed order and its ticket", () => {
    const html = result(eventCopy);
    expect(html).toContain("Order Status");
    expect(html).toContain("အော်ဒါ အခြေအနေ");
    expect(html).toContain("Back to Tickets");
    expect(html).toContain("Order Confirmed");
    expect(html).toContain("အော်ဒါ အတည်ပြုပြီး");
    expect(html).toContain("Ticket Type");
    expect(html).toContain("Price");
    expect(html).toContain("စျေးနှုန်း");
    expect(html).toContain("Ordered");
  });

  it("names a rejected order", () => {
    const html = result(eventCopy, order({ status: "rejected", status_label_en: "Enrollment Rejected" }));
    expect(html).toContain("Order Rejected");
    expect(html).toContain("အော်ဒါ ငြင်းဆိုထားသည်");
  });

  it("keeps the API's label for statuses that never named the enrollment", () => {
    const html = result(eventCopy, order({
      status: "payment_submitted",
      status_label_en: "Payment Under Review",
      status_label_mm: "ငွေပေးချေမှု စစ်ဆေးနေဆဲ",
    }));
    expect(html).toContain("Payment Under Review");
    expect(html).not.toMatch(SCHOOL_WORDS);
  });

  it("asks for an order reference in the lookup form", () => {
    const html = renderToStaticMarkup(<LookupForm copy={eventCopy} onLookup={() => {}} />);
    expect(html).toContain("Enter your order reference");
    expect(html).not.toMatch(SCHOOL_WORDS);
  });
});

describe("the tenant's own labels on an event order", () => {
  it("uses labels the tenant set", () => {
    const copy = statusPageCopy({ org_type: "event", label_class: "Race Category", label_fee: "Entry Fee" });
    expect(copy.itemLabel).toBe("Race Category");
    expect(copy.feeLabel).toBe("Entry Fee");
  });

  // Old event tenants still hold the column defaults from migration 024, and the
  // sign-up preset gives every event "Fee". None of these were chosen for a ticket.
  it.each(["Class Type", "Level", "Class", "", "   ", null, undefined])(
    "reads the unset label %j as Ticket",
    (label_class) => {
      expect(statusPageCopy({ org_type: "event", label_class, label_fee: "Fee" }).itemLabel).toBe("Ticket");
    },
  );

  it.each(["Fee", "", null, undefined])("reads the unset fee label %j as Price", (label_fee) => {
    expect(statusPageCopy({ org_type: "event", label_class: null, label_fee }).feeLabel).toBe("Price");
  });
});

describe("status page for a language school is unchanged", () => {
  it("keeps every school word in the result", () => {
    const html = result(schoolCopy);
    for (const word of [
      "Enrollment Status",
      "စာရင်းသွင်းမှု အခြေအနေ",
      "Enrollment Confirmed",
      "စာရင်းသွင်းမှု အတည်ပြုပြီး",
      "Enrolled",
      "စာရင်းသွင်းပြီး",
      "Class Level",
      "Fee",
      "ကျောင်းလခ",
      "Back to Classes",
    ]) {
      expect(html).toContain(word);
    }
    expect(html).not.toMatch(/Order|Ticket|Price|အော်ဒါ|စျေးနှုန်း/);
  });

  it("does not take a tenant label, so the wording stays as it was", () => {
    const copy = statusPageCopy({ org_type: "language_school", label_class: "JLPT Level", label_fee: "Tuition" });
    expect(copy.itemLabel).toBe("Class Level");
    expect(copy.feeLabel).toBe("Fee");
  });

  it("keeps the lookup form's wording", () => {
    const html = renderToStaticMarkup(<LookupForm copy={schoolCopy} onLookup={() => {}} />);
    expect(html).toContain("Enter your enrollment reference to check your status.");
    expect(html).toContain("သင့်စာရင်းသွင်းမှု ရည်ညွှန်းကုဒ်ကို ထည့်သွင်းပါ။");
  });

  it("uses the school wording for any other org type and for an unread tenant", () => {
    for (const row of [{ org_type: "training_center" }, { org_type: null }, null]) {
      expect(statusPageCopy(row)).toEqual(schoolCopy);
    }
  });
});

describe("the page reads the tenant before anything is looked up", () => {
  beforeEach(() => {
    tenantRow.current = null;
    tenantRow.error = null;
    tenantRow.slugsRead = [];
  });

  const renderPage = async () => {
    const { default: Page } = await import("@/app/(public)/enroll/[slug]/status/page");
    return renderToStaticMarkup(await Page());
  };

  it("shows an event tenant the order lookup form", async () => {
    tenantRow.current = { org_type: "event", label_class: "Ticket Type", label_fee: "Fee" };
    expect(await renderPage()).toContain("Enter your order reference");
    expect(tenantRow.slugsRead).toEqual(["thebeatsrun"]);
  });

  it("shows a language school the enrollment lookup form", async () => {
    tenantRow.current = { org_type: "language_school", label_class: "Level", label_fee: "Fee" };
    expect(await renderPage()).toContain("Enter your enrollment reference");
  });

  it("still renders, and logs, when the tenant cannot be read", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    tenantRow.error = { message: "connection lost" };
    expect(await renderPage()).toContain("Check Your Status");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("step line", () => {
  const track = (active: number) => renderToStaticMarkup(<StepTracker activeStep={active} copy={eventCopy} />);

  it("runs between the centres of the first and last steps", () => {
    // Four equal columns, so the outer centres sit 12.5% in from each edge.
    expect(track(1)).toContain("left:12.5%;right:12.5%");
  });

  it("fills inside that track, so a finished order cannot run past the last step", () => {
    const html = track(4);
    expect(html).toContain("width:100%");
    expect(html).not.toContain("mx-8");
    const trackAt = html.indexOf("left:12.5%");
    const fillAt = html.indexOf("width:100%");
    expect(trackAt).toBeGreaterThan(-1);
    // The fill's percentage is of the track only if it is nested inside it.
    expect(html.slice(trackAt, fillAt)).not.toContain("</div>");
  });

  it("fills nothing on the first step", () => {
    expect(track(1)).toContain("width:0%");
  });
});
