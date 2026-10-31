import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTrustedOfficialOrder,
  currentNavigationType,
  prepareTrustedOfficialOrder,
  submitTrustedOfficialOrder,
} from "@/lib/enrollment/trustedOfficialCheckout";

const SLUG = "sky";
const CART = "1761900000000";
const STASH = {
  slug: SLUG,
  items: [
    { class_id: "c1", quantity: 2 },
    { class_id: "c2", quantity: 1 },
  ],
  terms_accepted: true,
  terms_version: "2026-07",
  organiser_terms_sha256: "abc123",
};

let store: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;

function ok(ref = "ENR-1") {
  return { ok: true, json: async () => ({ enrollment_ref: ref }) };
}

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  fetchMock = vi.fn(async () => ok());
  vi.stubGlobal("fetch", fetchMock);
  store.set(`cart_${CART}`, JSON.stringify(STASH));
});

afterEach(() => vi.unstubAllGlobals());

function body(call = 0) {
  return JSON.parse((fetchMock.mock.calls[call][1] as { body: string }).body);
}

describe("createTrustedOfficialOrder", () => {
  it("POSTs the stashed body once, with the fields the template used to send", async () => {
    const r = await createTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: "navigate" });
    expect(r).toEqual({ kind: "created", ref: "ENR-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/public/enroll");
    expect((fetchMock.mock.calls[0][1] as { method: string }).method).toBe("POST");
    const b = body();
    expect(Object.keys(b).sort()).toEqual(
      ["idempotency_key", "items", "organiser_terms_sha256", "terms_accepted", "terms_version"].sort(),
    );
    expect(b.items).toEqual(STASH.items);
    expect(b.terms_accepted).toBe(true);
    expect(b.terms_version).toBe("2026-07");
    expect(b.organiser_terms_sha256).toBe("abc123");
    expect(typeof b.idempotency_key).toBe("string");
  });

  it("includes the priority token when pa_<slug> is present", async () => {
    store.set(`pa_${SLUG}`, "tok_123");
    await createTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: "navigate" });
    expect(body().priority_token).toBe("tok_123");
  });

  it("omits priority_token when absent", async () => {
    await createTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: "navigate" });
    expect("priority_token" in body()).toBe(false);
  });

  it("deletes the stash and ck_ on success", async () => {
    await createTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: "navigate" });
    expect(store.has(`cart_${CART}`)).toBe(false);
    expect(store.has(`ck_${CART}`)).toBe(false);
  });

  it("creates the key on this page and writes it before the POST", async () => {
    let atPost: string | null = null;
    fetchMock.mockImplementationOnce(async () => {
      atPost = store.get(`ck_${CART}`) ?? null;
      return ok();
    });
    await createTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: "navigate" });
    expect(atPost).toBeTruthy();
    expect(body().idempotency_key).toBe(atPost);
  });

  it("reuses the key from ck_ on a reload of this page", async () => {
    store.set(`ck_${CART}`, "existing-key");
    await createTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: "reload" });
    expect(body().idempotency_key).toBe("existing-key");
  });

  it.each(["navigate", "back_forward", "prerender"])(
    "on a %s navigation, mints a fresh key and overwrites an existing ck_",
    async (type) => {
      store.set(`ck_${CART}`, "existing-key");
      await createTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: type });
      const sent = body().idempotency_key;
      expect(sent).not.toBe("existing-key");
      expect(typeof sent).toBe("string");
      expect(store.get(`ck_${CART}`)).not.toBe("existing-key");
    },
  );

  it("mints a fresh key when the navigation type is unavailable", async () => {
    store.set(`ck_${CART}`, "existing-key");
    await createTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: undefined });
    expect(body().idempotency_key).not.toBe("existing-key");
  });

  it("never reads a key or ref from the stash", async () => {
    store.set(
      `cart_${CART}`,
      JSON.stringify({ ...STASH, idempotency_key: "from-stash", enrollment_ref: "ENR-X" }),
    );
    await createTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: "navigate" });
    expect(body().idempotency_key).not.toBe("from-stash");
    expect(JSON.stringify(body())).not.toContain("ENR-X");
  });

  it.each([
    ["missing stash", () => store.delete(`cart_${CART}`)],
    ["malformed JSON", () => store.set(`cart_${CART}`, "{not json")],
    ["other-slug stash", () => store.set(`cart_${CART}`, JSON.stringify({ ...STASH, slug: "other" }))],
    ["empty items", () => store.set(`cart_${CART}`, JSON.stringify({ ...STASH, items: [] }))],
    [
      "bad quantity",
      () => store.set(`cart_${CART}`, JSON.stringify({ ...STASH, items: [{ class_id: "c1", quantity: 0 }] })),
    ],
    ["terms not accepted", () => store.set(`cart_${CART}`, JSON.stringify({ ...STASH, terms_accepted: false }))],
  ])("redirects to tickets on %s, without POSTing", async (_name, arrange) => {
    arrange();
    const r = await createTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: "navigate" });
    expect(r).toEqual({ kind: "redirect-tickets" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redirects to tickets on a missing or non-numeric cart_key", async () => {
    expect(await createTrustedOfficialOrder({ slug: SLUG, cartKey: null, navigationType: "navigate" })).toEqual({ kind: "redirect-tickets" });
    expect(await createTrustedOfficialOrder({ slug: SLUG, cartKey: "../x", navigationType: "navigate" })).toEqual({ kind: "redirect-tickets" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the server message on a failed POST and keeps ck_ and the stash", async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, json: async () => ({ message: "Sold out" }) }));
    const r = await createTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: "navigate" });
    expect(r).toEqual({ kind: "error", message: "Sold out" });
    expect(store.has(`ck_${CART}`)).toBe(true);
    expect(store.has(`cart_${CART}`)).toBe(true);
  });

  it("keeps ck_ when the network fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const r = await createTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: "navigate" });
    expect(r).toEqual({ kind: "error", message: "offline" });
    expect(store.has(`ck_${CART}`)).toBe(true);
  });

  it("a reload after an error re-sends the same key", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await createTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: "navigate" });
    await createTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: "reload" });
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
  });
});

describe("currentNavigationType", () => {
  it("reads the first navigation entry's type", () => {
    expect(currentNavigationType({ getEntriesByType: () => [{ type: "reload" }] })).toBe("reload");
  });
  it("is undefined without an entry, without the API, or when it throws", () => {
    expect(currentNavigationType({ getEntriesByType: () => [] })).toBeUndefined();
    expect(currentNavigationType(undefined)).toBeUndefined();
    expect(
      currentNavigationType({
        getEntriesByType: () => {
          throw new Error("x");
        },
      }),
    ).toBeUndefined();
  });
});

describe("retry from the same document", () => {
  async function prepared() {
    const p = await prepareTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: "navigate" });
    if (p.kind !== "ready") throw new Error(`expected ready, got ${p.kind}`);
    return p.attempt;
  }

  it("prepare does not POST; it mints the key and writes ck_ first", async () => {
    const attempt = await prepared();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get(`ck_${CART}`)).toBe(attempt.idempotencyKey);
  });

  it("prepare redirects on a bad stash", async () => {
    store.delete(`cart_${CART}`);
    const p = await prepareTrustedOfficialOrder({ slug: SLUG, cartKey: CART, navigationType: "navigate" });
    expect(p).toEqual({ kind: "redirect-tickets" });
  });

  it("a failed POST then Try again sends the same idempotency_key and the same body", async () => {
    store.set(`pa_${SLUG}`, "tok_1");
    const attempt = await prepared();
    fetchMock.mockImplementationOnce(async () => ({ ok: false, json: async () => ({ message: "Busy" }) }));
    expect(await submitTrustedOfficialOrder(attempt)).toEqual({ kind: "error", message: "Busy" });
    await submitTrustedOfficialOrder(attempt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body(1)).toEqual(body(0));
    expect(body(1).idempotency_key).toBe(attempt.idempotencyKey);
  });

  it("a network error then Try again behaves the same way", async () => {
    const attempt = await prepared();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await submitTrustedOfficialOrder(attempt)).toEqual({ kind: "error", message: "offline" });
    expect(store.has(`ck_${CART}`)).toBe(true);
    await submitTrustedOfficialOrder(attempt);
    expect(body(1)).toEqual(body(0));
  });

  it("the retry does not depend on storage: ck_ removed in between still re-sends the in-memory key", async () => {
    const attempt = await prepared();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await submitTrustedOfficialOrder(attempt);
    store.delete(`ck_${CART}`);
    await submitTrustedOfficialOrder(attempt);
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key);
  });

  it("success after a retry returns the ref and deletes the stash and ck_", async () => {
    const attempt = await prepared();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await submitTrustedOfficialOrder(attempt);
    fetchMock.mockImplementationOnce(async () => ok("ENR-9"));
    expect(await submitTrustedOfficialOrder(attempt)).toEqual({ kind: "created", ref: "ENR-9" });
    expect(store.has(`cart_${CART}`)).toBe(false);
    expect(store.has(`ck_${CART}`)).toBe(false);
  });
});

describe("/checkout/new page wiring (static)", () => {
  const src = readFileSync(
    join(process.cwd(), "src/app/(public)/enroll/[slug]/checkout/new/page.tsx"),
    "utf8",
  );

  it("prepares the attempt once and retries from the in-memory attempt", () => {
    expect(src.match(/prepareTrustedOfficialOrder\s*\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/createTrustedOfficialOrder/);
    expect(src).toMatch(/submitTrustedOfficialOrder\s*\(\s*attempt\s*\)/);
    expect(src).toMatch(/attemptRef\.current\s*=\s*prepared\.attempt/);
  });

  it("offers Try again, guarded against a second click, and keeps Back to tickets", () => {
    expect(src).toContain("Try again");
    expect(src).toMatch(/inFlight\.current\)\s*return/);
    expect(src).toContain("Back to tickets");
  });

  it("on success replaces to /checkout/?ref=", () => {
    expect(src).toContain("router.replace(`/enroll/${slug}/checkout/?ref=${result.ref}`)");
  });
});
