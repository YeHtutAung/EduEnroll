import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: { message: string } | null };

let tables: Record<string, Result>;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const result = tables[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        maybeSingle: () => Promise.resolve(result),
        then: (resolve: (value: Result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
  }),
}));

import { loadEventEmailImages } from "@/server/notifications/eventEmailImages";

const ok = (data: unknown): Result => ({ data, error: null });
const url = (name: string) =>
  `https://project.supabase.co/storage/v1/object/public/class-images/t/i/${name}.jpg`;

const day = (n: number, overrides: Record<string, unknown> = {}) => ({
  level: `Day ${n}`,
  event_date: `2026-11-${20 + n}`,
  end_time: `2026-11-${20 + n}`,
  email_image_url: url(`day-${n}`),
  ...overrides,
});
const allDay = {
  level: "All Day",
  event_date: "2026-11-21",
  end_time: "2026-11-24",
  email_image_url: null,
};

function order(classes: unknown[]) {
  tables = {
    enrollments: ok({ class_id: null }),
    enrollment_items: ok(classes.map((_, i) => ({ class_id: `class-${i}` }))),
    classes: ok(classes),
  };
}

beforeEach(() => {
  order([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadEventEmailImages", () => {
  it("returns the day's poster for a one-day order", async () => {
    order([day(1)]);
    await expect(loadEventEmailImages("order-1")).resolves.toEqual([
      { url: url("day-1"), alt: "Day 1" },
    ]);
  });

  it("finds a single-ticket order's poster through the enrollment", async () => {
    tables.enrollments = ok({ class_id: "class-1" });
    tables.enrollment_items = ok([]);
    tables.classes = ok([day(2)]);
    await expect(loadEventEmailImages("order-1")).resolves.toEqual([
      { url: url("day-2"), alt: "Day 2" },
    ]);
  });

  it("returns each day's poster in date order, whatever order they were bought in", async () => {
    order([day(3), day(1)]);
    const images = await loadEventEmailImages("order-1");
    expect(images.map((image) => image.alt)).toEqual(["Day 1", "Day 3"]);
  });

  it("returns nothing for All Day alone when it has no image of its own", async () => {
    order([allDay]);
    await expect(loadEventEmailImages("order-1")).resolves.toEqual([]);
  });

  it("keeps a single day's poster when the order also includes All Day", async () => {
    order([day(2), allDay]);
    await expect(loadEventEmailImages("order-1")).resolves.toEqual([
      { url: url("day-2"), alt: "Day 2" },
    ]);
  });

  it("returns All Day's own image when it has one", async () => {
    order([{ ...allDay, email_image_url: url("all-day") }]);
    await expect(loadEventEmailImages("order-1")).resolves.toEqual([
      { url: url("all-day"), alt: "All Day" },
    ]);
  });

  it("gives the same order when All Day and Day 1 share a date", async () => {
    const pass = { ...allDay, email_image_url: url("all-day") };
    order([day(1), pass]);
    const first = await loadEventEmailImages("order-1");
    order([pass, day(1)]);
    const second = await loadEventEmailImages("order-1");
    expect(first).toEqual(second);
    expect(first.map((image) => image.alt)).toEqual(["All Day", "Day 1"]);
  });

  it("returns nothing for a tier with no poster, which is every other client's", async () => {
    order([day(1, { email_image_url: null }), day(2, { email_image_url: "  " })]);
    await expect(loadEventEmailImages("order-1")).resolves.toEqual([]);
  });

  it("repeats a poster shared by two tiers only once", async () => {
    order([day(1), day(2, { email_image_url: url("day-1") })]);
    await expect(loadEventEmailImages("order-1")).resolves.toEqual([
      { url: url("day-1"), alt: "Day 1" },
    ]);
  });

  it("drops anything that is not https", async () => {
    order([day(1, { email_image_url: "http://example.com/a.jpg" }), day(2)]);
    const images = await loadEventEmailImages("order-1");
    expect(images.map((image) => image.alt)).toEqual(["Day 2"]);
  });

  // A database without the column answers like this: the buyer must still get
  // their confirmation and ticket.
  it.each(["enrollments", "enrollment_items", "classes"])(
    "returns nothing instead of failing when %s cannot be read",
    async (table) => {
      order([day(1)]);
      tables[table] = { data: null, error: { message: "failed" } };
      await expect(loadEventEmailImages("order-1")).resolves.toEqual([]);
    },
  );

  it("returns nothing when the client itself throws", async () => {
    tables = new Proxy(
      {},
      {
        get: () => {
          throw new Error("boom");
        },
      },
    );
    await expect(loadEventEmailImages("order-1")).resolves.toEqual([]);
  });
});

describe("confirmation email senders", () => {
  it.each([
    "src/server/payments/notifyEnrollmentConfirmed.ts",
    "src/server/notifications/dispatchPaymentApproved.ts",
    "src/app/api/webhooks/mmpay/route.ts",
    "src/app/api/webhooks/abank/route.ts",
    "src/app/api/public/payments/abank/status/route.ts",
    "src/app/api/admin/enrollments/[id]/resend-email/route.ts",
  ])("%s passes the order's posters", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const call = source.slice(source.indexOf("enrollmentApprovedEmail({"));
    expect(call.slice(0, call.indexOf("});"))).toContain("eventImages: await loadEventEmailImages(");
  });
});
