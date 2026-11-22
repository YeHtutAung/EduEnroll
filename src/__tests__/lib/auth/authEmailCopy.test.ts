import { describe, it, expect } from "vitest";
import { authEmailMessages, type AuthHookPayload } from "@/lib/auth/authEmailCopy";
import { EMAIL_FOOTER_URL } from "@/lib/email";

// ─── Send Email Hook copy ───────────────────────────────────────────────────
// Buyer sign-in (signup, magiclink) is a code only, never a link. Staff types
// keep short copy; recovery and invite link to Supabase's own verify endpoint.

const SUPABASE_URL = "https://proj.supabase.test";
const MYANMAR = /[က-႟]/;

function payload(type: string, over: Partial<AuthHookPayload["email_data"]> = {}, user: Partial<AuthHookPayload["user"]> = {}): AuthHookPayload {
  return {
    user: { email: "buyer@example.test", ...user },
    email_data: {
      token: "482913",
      token_hash: "hash0123456789abcdef",
      redirect_to: "https://app.example.test/after?x=1",
      email_action_type: type,
      site_url: "https://site.example.test",
      token_new: "",
      token_hash_new: "",
      ...over,
    },
  };
}

/** Every href in the HTML. */
function hrefs(html: string): string[] {
  return Array.from(html.matchAll(/href="([^"]*)"/g), (m) => m[1]);
}

describe("authEmailMessages: buyer codes", () => {
  it.each(["signup", "magiclink"])("%s: one bilingual code email, no sign-in link", (type) => {
    const msgs = authEmailMessages(payload(type), SUPABASE_URL);
    expect(msgs).not.toBeNull();
    expect(msgs).toHaveLength(1);
    const [m] = msgs!;
    expect(m.to).toBe("buyer@example.test");
    expect(m.subject).toContain("482913");
    expect(m.subject).toMatch(MYANMAR);
    expect(m.html).toContain("482913");
    expect(m.html).toMatch(MYANMAR);
    expect(m.html).toMatch(/sign-in code/i);
    expect(m.html).toMatch(/10 minutes/);

    expect(m.html).not.toContain("/auth/v1/verify");
    expect(m.html).not.toContain("hash0123456789abcdef");
    expect(m.html).not.toContain("redirect_to");
    expect(m.html).not.toContain("app.example.test");
    expect(m.html).not.toContain("site.example.test");
    expect(hrefs(m.html)).toEqual([EMAIL_FOOTER_URL]);
  });

  it("refuses a code that isn't digits", () => {
    expect(authEmailMessages(payload("signup", { token: "<b>1</b>" }), SUPABASE_URL)).toBeNull();
    expect(authEmailMessages(payload("magiclink", { token: "" }), SUPABASE_URL)).toBeNull();
  });

  it("refuses a payload without a recipient", () => {
    expect(authEmailMessages(payload("signup", {}, { email: "" }), SUPABASE_URL)).toBeNull();
  });
});

describe("authEmailMessages: staff types", () => {
  it.each(["recovery", "invite"])("%s: links to Supabase's verify endpoint, not site_url", (type) => {
    const msgs = authEmailMessages(payload(type), SUPABASE_URL);
    expect(msgs).toHaveLength(1);
    const [m] = msgs!;
    expect(m.to).toBe("buyer@example.test");
    expect(m.html).toMatch(MYANMAR);
    const link =
      `${SUPABASE_URL}/auth/v1/verify?token=hash0123456789abcdef&amp;type=${type}` +
      `&amp;redirect_to=${encodeURIComponent("https://app.example.test/after?x=1")}`;
    expect(m.html).toContain(`href="${link}"`);
    expect(m.html).not.toContain("site.example.test");
  });

  it("recovery and invite have different subjects", () => {
    const r = authEmailMessages(payload("recovery"), SUPABASE_URL)![0];
    const i = authEmailMessages(payload("invite"), SUPABASE_URL)![0];
    expect(r.subject).not.toBe(i.subject);
  });

  it("refuses recovery without a token_hash", () => {
    expect(authEmailMessages(payload("recovery", { token_hash: "" }), SUPABASE_URL)).toBeNull();
  });

  it("refuses a link email when the Supabase URL is missing", () => {
    expect(authEmailMessages(payload("invite"), "")).toBeNull();
  });

  it("reauthentication shows the code and no link", () => {
    const msgs = authEmailMessages(payload("reauthentication"), SUPABASE_URL);
    expect(msgs).toHaveLength(1);
    expect(msgs![0].html).toContain("482913");
    expect(msgs![0].html).not.toContain("/auth/v1/verify");
    expect(msgs![0].html).toMatch(MYANMAR);
  });
});

describe("authEmailMessages: email_change", () => {
  it("produces two messages, each with its own code: token to the current address, token_new to the new one", () => {
    const msgs = authEmailMessages(
      payload("email_change", { token: "111111", token_new: "222222" }, { email: "old@example.test", new_email: "new@example.test" }),
      SUPABASE_URL,
    );
    expect(msgs).toHaveLength(2);
    const toOld = msgs!.find((m) => m.to === "old@example.test")!;
    const toNew = msgs!.find((m) => m.to === "new@example.test")!;
    expect(toOld.html).toContain("111111");
    expect(toOld.html).not.toContain("222222");
    expect(toNew.html).toContain("222222");
    expect(toNew.html).not.toContain("111111");
    for (const m of msgs!) {
      expect(m.html).toMatch(MYANMAR);
      expect(m.html).not.toContain("/auth/v1/verify");
    }
  });

  it("refuses an email_change missing either code or either address", () => {
    const base = { email: "old@example.test", new_email: "new@example.test" };
    expect(authEmailMessages(payload("email_change", { token: "111111", token_new: "" }, base), SUPABASE_URL)).toBeNull();
    expect(authEmailMessages(payload("email_change", { token: "", token_new: "222222" }, base), SUPABASE_URL)).toBeNull();
    expect(
      authEmailMessages(payload("email_change", { token: "111111", token_new: "222222" }, { email: "old@example.test" }), SUPABASE_URL),
    ).toBeNull();
  });
});

describe("authEmailMessages: other types", () => {
  it("returns null for an unlisted type", () => {
    expect(authEmailMessages(payload("password_changed_notification"), SUPABASE_URL)).toBeNull();
  });
});
