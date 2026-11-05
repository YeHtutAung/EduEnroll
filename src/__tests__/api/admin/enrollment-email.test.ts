import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Result = { data: unknown; error: unknown };

let lookup: Result;
let rpcResult: Result;
const eqCalls: [string, unknown][] = [];
const rpc = vi.fn(() => Promise.resolve(rpcResult));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, requireAuth: vi.fn() };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc,
    from: () => {
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          eqCalls.push([column, value]);
          return chain;
        },
        maybeSingle: () => Promise.resolve(lookup),
      };
      return chain;
    },
  }),
}));

import { requireAuth } from "@/lib/api";
import { PATCH } from "@/app/api/admin/enrollments/[id]/email/route";

const params = { params: { id: "order-1" } };

function send(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/admin/enrollments/order-1/email", {
      method: "PATCH",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    params,
  );
}

function signedIn(isAgent = false) {
  vi.mocked(requireAuth).mockResolvedValue({
    tenantId: "tenant-A",
    user: { id: "admin-1" },
    isAgent,
  } as unknown as Awaited<ReturnType<typeof requireAuth>>);
}

beforeEach(() => {
  rpc.mockClear();
  eqCalls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  signedIn();
  lookup = {
    data: {
      id: "order-1",
      email: "a@gmail.con",
      form_data: { email: "a@gmail.con", custom_email_1: "guardian@gmail.com" },
    },
    error: null,
  };
  rpcResult = { data: true, error: null };
});

describe("PATCH /api/admin/enrollments/[id]/email", () => {
  it("changes the address everywhere the order holds it, and names who did it", async () => {
    const res = await send({ email: " a@gmail.com " });

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("change_enrollment_email", {
      p_enrollment_id: "order-1",
      p_tenant_id: "tenant-A",
      p_old_email: "a@gmail.con",
      p_new_email: "a@gmail.com",
      p_form_data: { email: "a@gmail.com", custom_email_1: "guardian@gmail.com" },
      p_changed_by: "admin-1",
    });
    await expect(res.json()).resolves.toMatchObject({ ok: true, email: "a@gmail.com" });
  });

  it("only looks for the order inside the admin's own tenant", async () => {
    lookup = { data: null, error: null };
    const res = await send({ email: "a@gmail.com" });

    expect(res.status).toBe(404);
    expect(eqCalls).toContainEqual(["tenant_id", "tenant-A"]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses the bot", async () => {
    signedIn(true);
    const res = await send({ email: "a@gmail.com" });

    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ email: "not an email" }],
    [{ email: "a@gmail.com,b@gmail.com" }],
    [{ email: 42 }],
    [{}],
    ["{not json"],
  ])("refuses %j", async (body) => {
    const res = await send(body);

    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses the address the order already has", async () => {
    const res = await send({ email: "a@gmail.con" });

    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("corrects an order whose address is only in its saved answers", async () => {
    lookup = { data: { id: "order-1", email: null, form_data: { email: "a@gmail.con" } }, error: null };
    const res = await send({ email: "a@gmail.com" });

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "change_enrollment_email",
      expect.objectContaining({ p_old_email: null, p_form_data: { email: "a@gmail.com" } }),
    );
  });

  it("says so when someone else changed the address first", async () => {
    rpcResult = { data: false, error: null };
    const res = await send({ email: "a@gmail.com" });

    expect(res.status).toBe(409);
  });

  it("reports a failure and never claims success, for example before the migration", async () => {
    rpcResult = { data: null, error: { code: "PGRST202" } };
    const res = await send({ email: "a@gmail.com" });

    expect(res.status).toBe(500);
  });

  it("reports a failed lookup as a failure, not as a missing order", async () => {
    lookup = { data: null, error: { code: "57014" } };
    const res = await send({ email: "a@gmail.com" });

    expect(res.status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
  });
});
