import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import {
  enrollmentStatusLabels,
  paymentPageCopy,
  statusLookupCopy,
  statusNotFoundMessage,
} from "@/lib/enrollment/orderWording";
import { EnrollmentDetails } from "@/app/(public)/status/StatusLookupClient";

// Event buyers still read "enrollment" on /status, which their emails link to, and
// on the payment page, which shows the status API's label. Language schools keep
// the wording they always had.

const db = vi.hoisted(() => ({
  tenant: null as Record<string, unknown> | null,
  tenantFails: false,
  enrollment: null as Record<string, unknown> | null,
}));

vi.mock("next/headers", () => ({
  headers: () => new Headers({ "x-tenant-slug": "thebeatsrun" }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", () => ({ resolveTenantId: vi.fn(async () => "ten-1") }));

vi.mock("@/server/payments/partialPayment", () => ({
  loadPartialPayment: vi.fn(async () => null),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const answer = () => {
        if (table === "tenants") {
          return db.tenantFails
            ? { data: null, error: { message: "connection lost" } }
            : { data: db.tenant, error: null };
        }
        if (table === "enrollments") {
          return db.enrollment
            ? { data: db.enrollment, error: null }
            : { data: null, error: { code: "PGRST116", message: "no rows" } };
        }
        return { data: null, error: null };
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        single: async () => answer(),
        maybeSingle: async () => answer(),
      };
      return chain;
    },
  }),
}));

const eventTenant = { org_type: "event", label_student: "Attendee", currency: "MMK" };
const schoolTenant = { org_type: "language_school", label_student: "Student", currency: "MMK" };

const confirmedEnrollment = (status = "confirmed") => ({
  id: "enr-1",
  enrollment_ref: "R",
  status,
  class_id: "cls-1",
  quantity: 1,
  student_name_en: "Aung Aung",
  classes: { id: "cls-1", level: "5K", fee_amount: 1000, image_url: null, pack_size: 1, intakes: null },
});

beforeEach(() => {
  db.tenant = null;
  db.tenantFails = false;
  db.enrollment = null;
});

describe("GET /api/public/status labels", () => {
  const get = async () => {
    const { GET } = await import("@/app/api/public/status/route");
    const res = await GET(new NextRequest("https://t.kuunyi.com/api/public/status?ref=R"));
    return { status: res.status, body: await res.json() };
  };

  it.each([
    ["confirmed", "Order Confirmed", "အော်ဒါ အတည်ပြုပြီး"],
    ["rejected", "Order Rejected", "အော်ဒါ ငြင်းဆိုထားသည်"],
  ])("names a %s event order", async (status, en, mm) => {
    db.tenant = eventTenant;
    db.enrollment = confirmedEnrollment(status);
    const { body } = await get();
    expect(body.status_label_en).toBe(en);
    expect(body.status_label_mm).toBe(mm);
  });

  it.each([
    ["confirmed", "Enrollment Confirmed", "စာရင်းသွင်းမှု အတည်ပြုပြီး"],
    ["rejected", "Enrollment Rejected", "စာရင်းသွင်းမှု ငြင်းဆိုထားသည်"],
  ])("keeps a language school's %s label", async (status, en, mm) => {
    db.tenant = schoolTenant;
    db.enrollment = confirmedEnrollment(status);
    const { body } = await get();
    expect(body.status_label_en).toBe(en);
    expect(body.status_label_mm).toBe(mm);
  });

  it("falls back to the existing label when the tenant cannot be read", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    db.tenantFails = true;
    db.enrollment = confirmedEnrollment();
    const { body } = await get();
    expect(body.status_label_en).toBe("Enrollment Confirmed");
    expect(body.org_type).toBeNull();
    consoleError.mockRestore();
  });

  it("tells an event buyer no order was found", async () => {
    db.tenant = eventTenant;
    const { status, body } = await get();
    expect(status).toBe(404);
    expect(body.message).toBe("No order found for this reference.");
    expect(body.org_type).toBe("event");
  });

  it("keeps a language school's not-found message", async () => {
    db.tenant = schoolTenant;
    const { status, body } = await get();
    expect(status).toBe(404);
    expect(body.message).toBe("No enrollment found for this reference.");
    expect(body.org_type).toBe("language_school");
  });

  it("still answers 404 when the tenant cannot be read either", async () => {
    db.tenantFails = true;
    const { status, body } = await get();
    expect(status).toBe(404);
    expect(body.message).toBe("No enrollment found for this reference.");
    expect(body.org_type).toBeNull();
  });
});

describe("shared labels", () => {
  it("only differ where a label named the enrollment", () => {
    const event = enrollmentStatusLabels("event");
    const school = enrollmentStatusLabels("language_school");
    for (const status of ["pending_payment", "payment_submitted", "partial_payment"] as const) {
      expect(event[status]).toEqual(school[status]);
    }
  });

  it.each(["training_center", null, undefined])("treats %j as the school wording", (orgType) => {
    expect(enrollmentStatusLabels(orgType)).toEqual(enrollmentStatusLabels("language_school"));
    expect(paymentPageCopy(orgType)).toEqual(paymentPageCopy("language_school"));
    expect(statusNotFoundMessage(orgType)).toBe(statusNotFoundMessage("language_school"));
    expect(statusLookupCopy({ org_type: orgType })).toEqual(statusLookupCopy({ org_type: "language_school" }));
  });
});

describe("payment page wording", () => {
  it("reads as an order for an event", () => {
    const copy = paymentPageCopy("event");
    expect(copy.notFoundTitle).toEqual({ en: "Order Not Found", mm: "အော်ဒါ ရှာမတွေ့ပါ" });
    expect(copy.referenceLabel).toBe("Order Reference");
    expect(copy.reviewNote.en).toBe("We will review your payment and confirm your order shortly.");
    expect(copy.reviewNote.mm).toBe("သင့်ငွေပေးချေမှုကို စစ်ဆေးပြီး အော်ဒါကို မကြာမီ အတည်ပြုပေးပါမည်။");
    expect(copy.transferNotePrefix).toBe("Use your order reference");
    expect(copy.itemFallback).toBe("Ticket");
  });

  it("is unchanged for a language school", () => {
    const copy = paymentPageCopy("language_school");
    expect(copy.notFoundTitle).toEqual({ en: "Enrollment Not Found", mm: "စာရင်းသွင်းမှု ရှာမတွေ့ပါ" });
    expect(copy.referenceLabel).toBe("Enrollment Reference");
    expect(copy.reviewNote.en).toBe("We will review your payment and confirm your enrollment shortly.");
    expect(copy.reviewNote.mm).toBe("သင့်ငွေပေးချေမှုကို စစ်ဆေးပြီး စာရင်းသွင်းမှုကို မကြာမီ အတည်ပြုပေးပါမည်။");
    expect(copy.transferNotePrefix).toBe("Use your enrollment ref");
    expect(copy.itemFallback).toBe("Class");
  });

  // A Next page file can only export the page, so its pieces cannot be rendered
  // here. These hold the wiring; the screens were checked in a browser.
  const source = readFileSync(
    path.resolve(process.cwd(), "src/app/(public)/enroll/payment/[ref]/page.tsx"),
    "utf8",
  );

  it("takes every school string from the wording module", () => {
    expect(source).not.toMatch(/"Enrollment Confirmed"|"Enrollment Rejected"/);
    expect(source).not.toContain(">Enrollment Not Found<");
    expect(source).not.toContain(">Enrollment Reference<");
    expect(source).not.toContain("Use your enrollment ref");
    expect(source).not.toContain("confirm your enrollment shortly");
  });

  it("knows the org type as soon as the status answers, found or not", () => {
    expect(source).toContain("if (statusData.org_type) setOrgType(statusData.org_type);");
    expect(source).toContain("if (body.org_type) setOrgType(body.org_type);");
  });

  it("labels a Stripe return from the order's own org type", () => {
    // The effect's orgType state is still the initial value when this resolves.
    expect(source).toContain("enrollmentStatusLabels(prev.org_type)");
  });
});

describe("/status lookup page", () => {
  const renderPage = async () => {
    const { default: Page } = await import("@/app/(public)/status/page");
    return renderToStaticMarkup(await Page());
  };

  it("shows an event tenant an order lookup", async () => {
    db.tenant = eventTenant;
    const html = await renderPage();
    expect(html).toContain("Check Your Order Status");
    expect(html).toContain("သင်၏ အော်ဒါ အခြေအနေ စစ်ဆေးရန်");
    expect(html).toContain("Order Reference");
    expect(html).toContain("အော်ဒါ ရည်ညွှန်းကုဒ်");
    expect(html).toContain("Your order reference");
    expect(html).not.toMatch(/Enrollment|စာရင်းသွင်း|NM-2026/);
  });

  it("keeps a language school's lookup", async () => {
    db.tenant = schoolTenant;
    const html = await renderPage();
    expect(html).toContain("Check Your Enrollment Status");
    expect(html).toContain("သင်၏ စာရင်းသွင်းမှု အခြေအနေ စစ်ဆေးရန်");
    expect(html).toContain("Enrollment Reference");
    expect(html).toContain("စာရင်းသွင်းမှု ရည်ညွှန်းကုဒ်");
    expect(html).toContain("NM-2026-XXXXX");
    expect(html).not.toMatch(/Order|အော်ဒါ/);
  });

  it("still renders, and logs, when the tenant cannot be read", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    db.tenantFails = true;
    expect(await renderPage()).toContain("Check Your Enrollment Status");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("/status details", () => {
  const details = (orgType: string, personLabel: string) =>
    renderToStaticMarkup(
      <EnrollmentDetails
        personLabel={personLabel}
        data={{
          enrollment_ref: "R",
          student_name_en: "Aung Aung",
          student_name_mm: null,
          class_level: "5K",
          fee_amount: 1000,
          fee_formatted: "1,000 MMK",
          status: "confirmed",
          status_label_en: "",
          status_label_mm: "",
          org_type: orgType,
          payment: null,
        }}
      />,
    );

  it("names the buyer with the tenant's label on an event order", () => {
    const html = details("event", statusLookupCopy({ org_type: "event", label_student: "Runner" }).personLabel);
    expect(html).toContain("Runner");
    expect(html).not.toContain("Student");
  });

  it.each(["Student", "", "  ", null, undefined])("reads the unset label %j as Attendee", (label_student) => {
    expect(statusLookupCopy({ org_type: "event", label_student }).personLabel).toBe("Attendee");
  });

  it("keeps Student for a language school, whatever its label says", () => {
    const html = details(
      "language_school",
      statusLookupCopy({ org_type: "language_school", label_student: "Learner" }).personLabel,
    );
    expect(html).toContain("Student");
    expect(html).not.toContain("Learner");
  });
});
