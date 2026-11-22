import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync, createPrivateKey, sign as edSign } from "crypto";

const subtle = globalThis.crypto.subtle;
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as ArrayBuffer).toString("base64url");

let pair: CryptoKeyPair;
let dk: string;

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  process.env.TICKET_KID = "test-kid";
  pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  dk = b64u(await subtle.exportKey("raw", pair.publicKey));
});

async function qr(jti: string, ts: string, key = pair.privateKey, dkOverride?: string) {
  const { signBoundTicket } = await import("@/lib/tickets/sign");
  const token = signBoundTicket({ jti, eid: "i1", tier: "VIP", admits: 1, exp: 2_000_000_000 }, dkOverride ?? dk);
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`k2|${jti}|${ts}`));
  return `k2.${token}.${ts}.${b64u(sig)}`;
}

describe("verifyK2", () => {
  const NOW = 1_800_000_000;

  it("accepts a fresh QR and returns the claims and dk", async () => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    const r = verifyK2(await qr("t1", String(NOW)), NOW);
    expect(r).toMatchObject({ claims: { jti: "t1", eid: "i1" }, dk });
  });

  it.each([
    ["20 s old", NOW - 20, true],
    ["21 s old", NOW - 21, false],
    ["10 s ahead", NOW + 10, true],
    ["11 s ahead", NOW + 11, false],
  ])("window: %s", async (_n, ts, ok) => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    expect(verifyK2(await qr("t1", String(ts)), NOW) !== null).toBe(ok);
  });

  it.each(["0" + NOW, "+" + NOW, NOW + ".0", ""])("rejects a non-canonical ts %j", async (ts) => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    expect(verifyK2(await qr("t1", ts), NOW)).toBeNull();
  });

  it("rejects a wrong segment count, a plain token and a missing prefix", async () => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    const good = await qr("t1", String(NOW));
    expect(verifyK2(good + ".x", NOW)).toBeNull();
    expect(verifyK2(good.slice(3), NOW)).toBeNull();
    expect(verifyK2(good.split(".").slice(0, 5).join("."), NOW)).toBeNull();
  });

  it("rejects a signature by another key, or over another jti", async () => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    const other = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])) as CryptoKeyPair;
    expect(verifyK2(await qr("t1", String(NOW), other.privateKey), NOW)).toBeNull();
    const a = (await qr("t1", String(NOW))).split(".");
    const b = (await qr("t2", String(NOW))).split(".");
    expect(verifyK2([...a.slice(0, 5), b[5]].join("."), NOW)).toBeNull();
  });

  it("rejects a plain (unbound) ticket token inside the envelope", async () => {
    const { signTicketJwt } = await import("@/lib/tickets/sign");
    const { verifyK2 } = await import("@/lib/tickets/k2");
    const token = signTicketJwt({ jti: "t1", eid: "i1", tier: "VIP", admits: 1, exp: 2_000_000_000 });
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`k2|t1|${NOW}`));
    expect(verifyK2(`k2.${token}.${NOW}.${b64u(sig)}`, NOW)).toBeNull();
  });

  it("rejects a wrong prefix with the right segment count", async () => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    const good = await qr("t1", String(NOW));
    expect(verifyK2("k3" + good.slice(2), NOW)).toBeNull();
  });

  // The property that stops a forged QR: an attacker can't put their own dk in a token.
  async function devsig(jti: string, ts: string) {
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`k2|${jti}|${ts}`));
    return b64u(sig);
  }
  function edToken(payload: unknown, edKey = generateKeyPairSync("ed25519").privateKey) {
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "test-kid" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const s = edSign(null, Buffer.from(`${header}.${body}`), edKey).toString("base64url");
    return `${header}.${body}.${s}`;
  }
  const claims = { jti: "t1", eid: "i1", tier: "VIP", admits: 1, exp: 2_000_000_000, typ: "bound" };

  it("rejects a bound token signed by a key other than the ticket key", async () => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    const token = edToken({ ...claims, dk });
    expect(verifyK2(`k2.${token}.${NOW}.${await devsig("t1", String(NOW))}`, NOW)).toBeNull();
  });

  it("rejects a real bound token whose payload was re-encoded with another dk", async () => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    const other = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const otherDk = b64u(await subtle.exportKey("raw", other.publicKey));
    const [h, p, s] = (await qr("t1", String(NOW), pair.privateKey, otherDk)).split(".").slice(1, 4);
    const swapped = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), dk }),
    ).toString("base64url");
    expect(verifyK2(`k2.${h}.${swapped}.${s}.${NOW}.${await devsig("t1", String(NOW))}`, NOW)).toBeNull();
  });

  it("refuses, without throwing, a correctly signed payload that is JSON null", async () => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    const serverKey = createPrivateKey({
      key: Buffer.from(process.env.TICKET_SIGNING_KEY!, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const qrNull = `k2.${edToken(null, serverKey)}.${NOW}.${await devsig("t1", String(NOW))}`;
    expect(() => verifyK2(qrNull, NOW)).not.toThrow();
    expect(verifyK2(qrNull, NOW)).toBeNull();
  });

  it("refuses when the clock value is not a finite number", async () => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    const old = await qr("t1", "0");
    expect(verifyK2(old, NaN)).toBeNull();
    expect(verifyK2(await qr("t1", String(NOW)), Infinity)).toBeNull();
  });

  it("rejects a dk that is not a P-256 point", async () => {
    const { verifyK2 } = await import("@/lib/tickets/k2");
    expect(verifyK2(await qr("t1", String(NOW), pair.privateKey, "B" + "A".repeat(86)), NOW)).toBeNull();
  });

  it("isK2 tells the envelope apart from a plain token", async () => {
    const { isK2 } = await import("@/lib/tickets/k2");
    expect(isK2("k2.a.b.c.d.e")).toBe(true);
    expect(isK2("eyJ.a.b")).toBe(false);
  });

  it("k2.ts and the browser-safe k2Text.ts share one signed-text definition", async () => {
    const k2 = await import("@/lib/tickets/k2");
    const text = await import("@/lib/tickets/k2Text");
    expect(k2.k2SignedText).toBe(text.k2SignedText);
    expect(text.k2SignedText("t1", "5")).toBe("k2|t1|5");
  });
});
