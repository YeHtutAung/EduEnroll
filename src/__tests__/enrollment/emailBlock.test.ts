import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));

vi.mock("@/lib/api", () => ({
  resolveTenantId: vi.fn().mockResolvedValue("tenant-abc"),
}));

const checkTerms = vi.fn();
vi.mock("@/server/legal/organiserRules", () => ({
  checkTermsAcceptance: (...args: unknown[]) => checkTerms(...args),
}));

import { POST } from "@/app/api/public/enroll/route";
import { PATCH } from "@/app/api/public/enrollment/[ref]/route";

const CLASS_ID = "8e733a38-855a-4a39-a382-9e2db4e9e897";

function enroll(body: object) {
  return POST(
    new NextRequest("http://localhost/api/public/enroll", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

function saveDetails(email: string) {
  return PATCH(
    new NextRequest("http://localhost/api/public/enrollment/SF-1", {
      method: "PATCH",
      body: JSON.stringify({ student_name_en: "A", email }),
      headers: { "x-forwarded-for": "8.8.4.4" },
    }),
    { params: { ref: "SF-1" } },
  );
}

beforeEach(() => {
  mockRpc.mockReset();
  mockFrom.mockReset();
  checkTerms.mockReset();
  // Stops the order right after the email check, so a test can see it got past.
  checkTerms.mockResolvedValue({ ok: false, status: 422, body: { error: "past the email check" } });
});

describe("POST /api/public/enroll", () => {
  it.each([
    ["email", { email: "a@gmail.con" }],
    ["a custom email field", { custom_email_123: "a@gamil.com" }],
  ])("refuses a mistyped address in %s before reserving anything", async (_name, form_data) => {
    const res = await enroll({ class_id: CLASS_ID, form_data });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.suggestion).toMatch(/^a@gmail\.com$/);
    expect(body.message_mm).toContain("a@gmail.com");
    expect(checkTerms).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("refuses it on a cart order too", async () => {
    const res = await enroll({ items: [{ class_id: CLASS_ID, quantity: 1 }], form_data: { email: "a@gmail.co" } });

    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each(["a@gmail.com", "a@email.com", "a@yaho.com", "a@company.con"])("lets %s through", async (email) => {
    const res = await enroll({ class_id: CLASS_ID, form_data: { email } });

    expect(res.status).toBe(422);
    expect(checkTerms).toHaveBeenCalled();
  });

  it("lets an order with no email through", async () => {
    const res = await enroll({ class_id: CLASS_ID, form_data: { name_en: "A" } });

    expect(res.status).toBe(422);
  });
});

describe("PATCH /api/public/enrollment/[ref]", () => {
  it("refuses a mistyped address before reading or writing the order", async () => {
    const res = await saveDetails("a@gmail.con");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ suggestion: "a@gmail.com" });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
