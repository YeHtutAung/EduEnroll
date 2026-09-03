import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthContext } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, requireOwner: vi.fn() };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
  interestConfirmationEmail: vi.fn(() => ({ subject: "s", html: "<p>h</p>" })),
  priorityWindowReminderEmail: vi.fn(() => ({ subject: "s", html: "<p>h</p>" })),
}));

import { requireOwner } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import { PATCH } from "@/app/api/admin/interest/entry/[id]/route";
import { makeInterestMock, scheduledIntake, OWNER_TENANT } from "./interestMocks";

const ENTRY = {
  id: "entry-1",
  intake_id: "intake-1",
  name: "Aung Aung",
  email: "aung@example.com",
  token_prefix: "Ab12Cd34",
  revoked_at: null,
  superseded_expires_at: null,
};

function request(body: unknown) {
  return new Request("http://acme.localhost/api/admin/interest/entry/entry-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireOwner).mockResolvedValue({
    supabase: {} as never,
    tenantId: OWNER_TENANT,
    user: {} as never,
    isAgent: false,
    agentChatId: null,
  } satisfies AuthContext);
  vi.mocked(sendEmail).mockResolvedValue(true);
});

describe("PATCH /api/admin/interest/entry/[id]", () => {
  it("404s for a record outside the caller's tenant, and writes nothing", async () => {
    // The lookup carries .eq("tenant_id", …), so another tenant's record is
    // simply not found. Asserted on the WRITES, because "before any write" is
    // the property that matters: no revoke, no rotation.
    const mock = makeInterestMock({ entry: { data: null } });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await PATCH(request({ action: "revoke" }) as never, {
      params: { id: "someone-elses-entry" },
    });

    expect(res.status).toBe(404);
    expect(mock.updates).toHaveLength(0);
    expect(mock.rpcCalls).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rejects an unknown action before touching the database", async () => {
    const mock = makeInterestMock({ entry: { data: ENTRY } });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await PATCH(request({ action: "delete" }) as never, { params: { id: "entry-1" } });

    expect(res.status).toBe(400);
    expect(mock.client.from).not.toHaveBeenCalled();
  });

  it("revoke stamps revoked_at, scoped by tenant", async () => {
    const mock = makeInterestMock({ entry: { data: ENTRY } });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await PATCH(request({ action: "revoke" }) as never, { params: { id: "entry-1" } });

    expect(res.status).toBe(200);
    expect(mock.updates).toHaveLength(1);
    expect(mock.updates[0].payload).toHaveProperty("revoked_at");
    expect(mock.updates[0].eqs).toMatchObject({ id: "entry-1", tenant_id: OWNER_TENANT });
  });

  it("revoke is idempotent — an already-revoked record is not re-stamped", async () => {
    const mock = makeInterestMock({
      entry: { data: { ...ENTRY, revoked_at: "2026-08-01T00:00:00.000Z" } },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await PATCH(request({ action: "revoke" }) as never, { params: { id: "entry-1" } });

    expect(res.status).toBe(200);
    expect(mock.updates).toHaveLength(0);
  });

  it("refuses to resend a revoked record", async () => {
    const mock = makeInterestMock({
      entry: { data: { ...ENTRY, revoked_at: "2026-08-01T00:00:00.000Z" } },
      intake: { data: scheduledIntake() },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await PATCH(request({ action: "resend" }) as never, { params: { id: "entry-1" } });

    expect(res.status).toBe(409);
    expect(mock.rpcCalls).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("resend rotates with the cooldown bypassed, then sends", async () => {
    const mock = makeInterestMock({
      entry: { data: ENTRY },
      intake: { data: scheduledIntake() },
      supersededExpiresAt: "2026-08-02T00:00:00.000Z",
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await PATCH(request({ action: "resend" }) as never, { params: { id: "entry-1" } });

    expect(res.status).toBe(200);

    const rotate = mock.rpcCalls.find((c) => c.name === "rotate_interest_token");
    expect(rotate).toBeDefined();
    // Zero, not null: rotate_interest_token refuses a null cooldown outright.
    expect(rotate!.args.p_cooldown).toBe("0 seconds");
    expect(rotate!.args.p_interest_id).toBe("entry-1");

    // Persist, then send — the rotation is recorded before the mail goes out.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(mock.rpcCalls.map((c) => c.name)).not.toContain("rollback_interest_rotation");
  });

  it("rolls the rotation back when the send fails, and reports failure", async () => {
    vi.mocked(sendEmail).mockResolvedValue(false);
    const mock = makeInterestMock({ entry: { data: ENTRY }, intake: { data: scheduledIntake() } });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await PATCH(request({ action: "resend" }) as never, { params: { id: "entry-1" } });

    expect(res.status).toBe(502);

    const rollback = mock.rpcCalls.find((c) => c.name === "rollback_interest_rotation");
    expect(rollback).toBeDefined();
    // The prefix cannot be derived from a hash, so it must be the one read
    // before rotating.
    expect(rollback!.args.p_restore_prefix).toBe("Ab12Cd34");

    // A resend that never reached an inbox must not stamp a send.
    expect(mock.updates).toHaveLength(0);
  });

  it("returns the grace deadline the UI needs to warn before the next rotation", async () => {
    const mock = makeInterestMock({
      entry: { data: { ...ENTRY, superseded_expires_at: "2026-08-02T00:00:00.000Z" } },
      intake: { data: scheduledIntake() },
      supersededExpiresAt: "2026-08-02T00:00:00.000Z",
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await PATCH(request({ action: "resend" }) as never, { params: { id: "entry-1" } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.entry).not.toBeNull();
    expect(body.entry).toHaveProperty("superseded_expires_at");
  });
});
