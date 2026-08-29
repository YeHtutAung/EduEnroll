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
import { sendEmail, priorityWindowReminderEmail } from "@/lib/email";
import { POST } from "@/app/api/admin/interest/[intakeId]/invite/route";
import { makeInterestMock, scheduledIntake, OWNER_TENANT } from "./interestMocks";

function candidate(n: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `entry-${n}`,
    name: `Person ${n}`,
    email: `${n}@example.com`,
    token_prefix: `prefix-${n}`,
    revoked_at: null,
    ...overrides,
  };
}

const request = () =>
  new Request("http://acme.localhost/api/admin/interest/intake-1/invite", { method: "POST" });

const params = { params: { intakeId: "intake-1" } };

/** Rows the run stamped as invited, in order. */
const invitedIds = (updates: { payload: Record<string, unknown>; eqs: Record<string, unknown> }[]) =>
  updates.filter((u) => "invited_at" in u.payload).map((u) => u.eqs.id);

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

describe("POST /api/admin/interest/[intakeId]/invite", () => {
  it("404s when the intake is not the caller's, and rotates nothing", async () => {
    // The tenant check runs before a single row is read or rotated. Asserted on
    // the rotations, because a rotation invalidates a live credential — doing
    // one for another tenant would kill their attendees' links.
    const mock = makeInterestMock({
      intake: { data: null },
      entries: { data: [candidate("a")] },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await POST(request() as never, { params: { intakeId: "someone-elses-intake" } });

    expect(res.status).toBe(404);
    expect(mock.rpcCalls).toHaveLength(0);
    expect(mock.updates).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses when no priority window is scheduled", async () => {
    const mock = makeInterestMock({
      intake: { data: scheduledIntake({ priority_open_at: null }) },
      entries: { data: [candidate("a")] },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await POST(request() as never, params);

    expect(res.status).toBe(409);
    expect(mock.rpcCalls).toHaveLength(0);
  });

  it("skips revoked rows — it filters them out and refuses to rotate one that slips through", async () => {
    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: {
        data: [
          candidate("a"),
          candidate("b", { revoked_at: "2026-08-01T00:00:00.000Z" }),
          candidate("c"),
        ],
      },
      remainingCount: 1,
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await POST(request() as never, params);
    const body = await res.json();

    // The query asks the database to exclude them...
    expect(mock.isFilters).toContainEqual({ column: "revoked_at", value: null });
    expect(mock.isFilters).toContainEqual({ column: "invited_at", value: null });

    // ...and the loop refuses the one the stub handed back anyway. Rotating a
    // revoked row would spend an email on a link the gate refuses.
    const rotatedIds = mock.rpcCalls
      .filter((c) => c.name === "rotate_interest_token")
      .map((c) => c.args.p_interest_id);
    expect(rotatedIds).toEqual(["entry-a", "entry-c"]);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(body.sent).toBe(2);
    expect(body.skipped).toBe(1);
  });

  it("stamps invited_at only for rows whose send succeeded", async () => {
    // Row b's provider call fails. a and c must still be delivered and stamped;
    // b must be left unstamped so a re-run picks up only the remainder.
    vi.mocked(sendEmail).mockImplementation(async ({ to }: { to: string }) => to !== "b@example.com");

    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: { data: [candidate("a"), candidate("b"), candidate("c")] },
      remainingCount: 1,
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await POST(request() as never, params);
    const body = await res.json();

    expect(invitedIds(mock.updates)).toEqual(["entry-a", "entry-c"]);
    expect(invitedIds(mock.updates)).not.toContain("entry-b");

    expect(body.sent).toBe(2);
    expect(body.failed).toBe(1);
    // Still owed an invitation — the run is resumable, not silently complete.
    expect(body.remaining).toBe(1);
  });

  it("rolls back the rotation of a row whose send failed", async () => {
    vi.mocked(sendEmail).mockImplementation(async ({ to }: { to: string }) => to !== "b@example.com");

    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: { data: [candidate("a"), candidate("b"), candidate("c")] },
      remainingCount: 1,
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    await POST(request() as never, params);

    const rollbacks = mock.rpcCalls.filter((c) => c.name === "rollback_interest_rotation");
    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0].args.p_interest_id).toBe("entry-b");
    // The prefix is unrecoverable from a hash, so it has to be the one read
    // before rotating.
    expect(rollbacks[0].args.p_restore_prefix).toBe("prefix-b");
  });

  it("rotates per row with the cooldown bypassed, and sends the reminder template", async () => {
    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: { data: [candidate("a"), candidate("b")] },
      remainingCount: 0,
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await POST(request() as never, params);
    const body = await res.json();

    const rotations = mock.rpcCalls.filter((c) => c.name === "rotate_interest_token");
    expect(rotations).toHaveLength(2);
    for (const r of rotations) expect(r.args.p_cooldown).toBe("0 seconds");

    // The reminder carries a freshly minted link, never the recipient's old one
    // — a hash cannot be reversed.
    expect(priorityWindowReminderEmail).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(priorityWindowReminderEmail).mock.calls[0][0];
    expect(firstCall.link).toContain("#pa=");

    expect(body).toMatchObject({ sent: 2, remaining: 0 });
  });

  it("stops the chunk after repeated send failures rather than churning every credential", async () => {
    vi.mocked(sendEmail).mockResolvedValue(false);

    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: { data: [candidate("a"), candidate("b"), candidate("c"), candidate("d")] },
      remainingCount: 4,
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await POST(request() as never, params);
    const body = await res.json();

    expect(body.sent).toBe(0);
    expect(body.stopped_early).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(3);
    // Every attempted rotation was undone.
    expect(mock.rpcCalls.filter((c) => c.name === "rollback_interest_rotation")).toHaveLength(3);
    expect(mock.updates).toHaveLength(0);
  });
});
