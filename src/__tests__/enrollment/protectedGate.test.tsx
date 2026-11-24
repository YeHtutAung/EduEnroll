import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { submitTrustedOfficialOrder } from "@/lib/enrollment/trustedOfficialCheckout";
import ProtectedGate, { AccountEmailField } from "@/components/enroll/ProtectedGate";
import ProtectedNotice, { PROTECTED_NOTICE_EN, PROTECTED_NOTICE_MM } from "@/components/enroll/ProtectedNotice";
import {
  accountSignInHref,
  eventIsProtected,
  gateStateFromStatus,
  resolveProtectedGate,
  STAFF_MESSAGE,
} from "@/lib/enrollment/protectedGate";

// Task 13 (design 5.1–5.2, 5.6): the sign-in gate on a protected event's form
// and checkout. The server is the control; these are the pages' decisions.

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("accountSignInHref", () => {
  it("carries the current path and query, URL-encoded", () => {
    expect(accountSignInHref("/enroll/form", "?slug=sky&class_id=c1&quantity=2")).toBe(
      "/account?next=%2Fenroll%2Fform%3Fslug%3Dsky%26class_id%3Dc1%26quantity%3D2",
    );
  });

  it("round-trips through URLSearchParams to the exact path and query", () => {
    const href = accountSignInHref("/enroll/sky/checkout/new", "?cart_key=123");
    expect(new URL(href, "https://x.test").searchParams.get("next")).toBe("/enroll/sky/checkout/new?cart_key=123");
  });

  it("leaves out an empty query", () => {
    expect(accountSignInHref("/enroll/form", "")).toBe("/account?next=%2Fenroll%2Fform");
    expect(accountSignInHref("/enroll/form", "?")).toBe("/account?next=%2Fenroll%2Fform");
  });
});

describe("gateStateFromStatus", () => {
  it("maps the profile route's answers", () => {
    expect(gateStateFromStatus(200)).toBe("signedIn");
    expect(gateStateFromStatus(401)).toBe("signedOut");
    expect(gateStateFromStatus(403)).toBe("staff");
  });

  it("fails closed on anything else", () => {
    expect(gateStateFromStatus(503)).toBe("unavailable");
    expect(gateStateFromStatus(500)).toBe("unavailable");
    expect(gateStateFromStatus(302)).toBe("unavailable");
  });
});

describe("resolveProtectedGate", () => {
  it("an unprotected event is open and makes no profile call", async () => {
    const fetcher = vi.fn();
    await expect(resolveProtectedGate(false, fetcher)).resolves.toEqual({ state: "open", email: null });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a protected event asks the profile route, uncached", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(200, { buyerId: "b1", email: "buyer@example.com" }));
    await expect(resolveProtectedGate(true, fetcher)).resolves.toEqual({ state: "signedIn", email: "buyer@example.com" });
    expect(fetcher).toHaveBeenCalledWith("/api/account/profile", { cache: "no-store" });
  });

  it("401 is signed out, 403 is staff", async () => {
    await expect(resolveProtectedGate(true, vi.fn().mockResolvedValue(response(401)))).resolves.toEqual({
      state: "signedOut",
      email: null,
    });
    await expect(resolveProtectedGate(true, vi.fn().mockResolvedValue(response(403)))).resolves.toEqual({
      state: "staff",
      email: null,
    });
  });

  it("a 200 without an email, a 503 or a network error is unavailable, never open", async () => {
    await expect(resolveProtectedGate(true, vi.fn().mockResolvedValue(response(200, {})))).resolves.toMatchObject({
      state: "unavailable",
    });
    await expect(resolveProtectedGate(true, vi.fn().mockResolvedValue(response(503)))).resolves.toMatchObject({
      state: "unavailable",
    });
    await expect(resolveProtectedGate(true, vi.fn().mockRejectedValue(new Error("offline")))).resolves.toMatchObject({
      state: "unavailable",
    });
  });
});

describe("ProtectedGate", () => {
  const next = accountSignInHref("/enroll/form", "?slug=sky&class_id=c1");
  const form = <form id="the-form"><input name="email" /></form>;

  it("a protected intake without a session shows the sign-in button with the right next", () => {
    const html = renderToStaticMarkup(<ProtectedGate state="signedOut" next={next}>{form}</ProtectedGate>);
    expect(html).toContain("Sign in to continue");
    expect(html).toContain(`href="/account?next=%2Fenroll%2Fform%3Fslug%3Dsky%26class_id%3Dc1"`);
    // No field before sign-in.
    expect(html).not.toContain("the-form");
    expect(html).toContain("font-myanmar");
  });

  it("a staff session shows the staff message and no form", () => {
    const html = renderToStaticMarkup(<ProtectedGate state="staff" next={next}>{form}</ProtectedGate>);
    expect(html).toContain(STAFF_MESSAGE.replace("'", "&#x27;"));
    expect(html).not.toContain("the-form");
    expect(html).not.toContain("href=");
  });

  it("an unchecked session shows try again and no form", () => {
    const html = renderToStaticMarkup(<ProtectedGate state="unavailable" next={next}>{form}</ProtectedGate>);
    expect(html).toContain("try again");
    expect(html).not.toContain("the-form");
  });

  it("with a session, the form renders and the email input is read-only and holds the profile email", () => {
    const html = renderToStaticMarkup(
      <ProtectedGate state="signedIn" next={next}>
        <AccountEmailField email="buyer@example.com" />
      </ProtectedGate>,
    );
    const input = html.match(/<input[^>]*>/)?.[0] ?? "";
    expect(input).toContain('type="email"');
    expect(input).toContain('value="buyer@example.com"');
    expect(input).toContain('readonly=""');
    expect(html).toContain("Tickets are sent to your account.");
    expect(html).not.toContain("Sign in to continue");
  });

  it("an unprotected intake renders exactly as before", () => {
    expect(renderToStaticMarkup(<ProtectedGate state="open" next={next}>{form}</ProtectedGate>)).toBe(
      renderToStaticMarkup(form),
    );
  });
});

describe("ProtectedNotice", () => {
  it("says smartphone required in English and Myanmar", () => {
    const html = renderToStaticMarkup(<ProtectedNotice />);
    expect(html).toContain(PROTECTED_NOTICE_EN);
    expect(html).toContain(PROTECTED_NOTICE_MM);
    expect(PROTECTED_NOTICE_EN).toBe("Smartphone required. Open your ticket before you arrive.");
  });
});

describe("eventIsProtected", () => {
  const intake = (over: Record<string, unknown>) => response(200, { intake: { id: "i1", ...over } });

  it("reads intake.ticket_protection from the event route", async () => {
    const fetcher = vi.fn().mockResolvedValue(intake({ ticket_protection: true }));
    await expect(eventIsProtected("sky", undefined, fetcher)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/api/public/enroll/sky");
    await expect(eventIsProtected("sky", undefined, vi.fn().mockResolvedValue(intake({ ticket_protection: false })))).resolves.toBe(false);
  });

  it("counts the flag only for the order's own intake when one is given", async () => {
    await expect(eventIsProtected("sky", "i1", vi.fn().mockResolvedValue(intake({ ticket_protection: true })))).resolves.toBe(true);
    await expect(eventIsProtected("sky", "i2", vi.fn().mockResolvedValue(intake({ ticket_protection: true })))).resolves.toBe(false);
  });

  it("a failed read is false: the page behaves as before and the server decides", async () => {
    await expect(eventIsProtected("sky", undefined, vi.fn().mockResolvedValue(response(404)))).resolves.toBe(false);
    await expect(eventIsProtected("sky", undefined, vi.fn().mockRejectedValue(new Error("offline")))).resolves.toBe(false);
  });
});

describe("checkout/new: the server's protected-event refusals bring up the gate", () => {
  const attempt = { slug: "sky", cartKey: "123", idempotencyKey: "k", body: {} };

  it("401 → sign-in, 403 → staff, and the stash is kept", async () => {
    const removeItem = vi.fn();
    vi.stubGlobal("sessionStorage", { removeItem, getItem: vi.fn(), setItem: vi.fn() });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401, { error: "Unauthorized", message: "Sign in to buy tickets for this event." })));
    await expect(submitTrustedOfficialOrder(attempt)).resolves.toEqual({ kind: "sign-in" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(403, { error: "Forbidden", message: STAFF_MESSAGE })));
    await expect(submitTrustedOfficialOrder(attempt)).resolves.toEqual({ kind: "staff" });
    expect(removeItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
