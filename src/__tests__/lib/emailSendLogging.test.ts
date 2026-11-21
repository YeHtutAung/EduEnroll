import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── sendEmail logs fixed fields only ───────────────────────────────────────
// Resend writes its own error message, and it can repeat the recipient
// address. The real sendEmail must never log the message or the object.

const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...a: unknown[]) => send(...a) };
  },
}));

import { sendEmail } from "@/lib/email";

const ADDRESS = "leaky.person@example.test";
let logs: unknown[][];
const spies: Array<ReturnType<typeof vi.spyOn>> = [];

function logText(): string {
  return logs
    .map((a) => a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x) ?? String(x); } catch { return String(x); } })())).join(" "))
    .join("\n");
}

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("RESEND_API_KEY", "re_test_placeholder");
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    spies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a)));
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  spies.splice(0).forEach((s) => s.mockRestore());
});

describe("sendEmail logging", () => {
  it("a Resend error whose message repeats the address → false, logs name and status only", async () => {
    send.mockResolvedValue({
      data: null,
      error: { name: "validation_error", statusCode: 422, message: `Invalid \`to\` field: ${ADDRESS}` },
    });
    expect(await sendEmail({ to: ADDRESS, subject: "s", html: "h" })).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
    expect(logText()).not.toContain(ADDRESS);
    expect(logText()).toContain("validation_error");
    expect(logText()).toContain("422");
  });

  it("a thrown error whose message repeats the address → false, logs the error name only", async () => {
    send.mockRejectedValue(new TypeError(`fetch failed for ${ADDRESS}`));
    expect(await sendEmail({ to: ADDRESS, subject: "s", html: "h" })).toBe(false);
    expect(logText()).not.toContain(ADDRESS);
    expect(logText()).toContain("TypeError");
  });

  it("passes the caller's signal through to Resend", async () => {
    send.mockResolvedValue({ data: { id: "x" }, error: null });
    const ac = new AbortController();
    expect(await sendEmail({ to: ADDRESS, subject: "s", html: "h", signal: ac.signal })).toBe(true);
    expect(send.mock.calls[0][1]).toEqual({ signal: ac.signal });
  });
});
