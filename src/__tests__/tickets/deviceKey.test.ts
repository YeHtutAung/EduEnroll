import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync } from "crypto";
import { exportPublicKey, getOrCreateKey, k2Text, type KeyStore, type StoredToken } from "@/lib/tickets/deviceKey";
import { verifyK2, K2_PAST_SECONDS, K2_FUTURE_SECONDS } from "@/lib/tickets/k2";
import { signBoundTicket } from "@/lib/tickets/sign";

// ─── deviceKey.ts: the browser half of the k2 QR (plan Task 8) ──────────────
// fake-indexeddb is not a devDependency, so the IndexedDB parts are not run
// here. What matters is the round trip: a QR built by the browser module, with
// a WebCrypto key, verifies with the server's verifyK2. Node has WebCrypto.

const JTI = "11111111-2222-4333-8444-555555555555";
const EID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SERVER_NOW = 1_800_000_000;

let pair: CryptoKeyPair;
let publicKey: string;
let token: string;

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  process.env.TICKET_KID = "test-kid";
  // As the page creates it: private key non-extractable.
  pair = (await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  publicKey = await exportPublicKey(pair);
  token = signBoundTicket({ jti: JTI, eid: EID, tier: "VIP", admits: 1, exp: SERVER_NOW + 86_400 }, publicKey);
});

const stored = (offset: number, overrides: Partial<StoredToken> = {}): StoredToken => ({
  token,
  jti: JTI,
  offset,
  publicKey,
  ...overrides,
});

describe("exportPublicKey", () => {
  it("is the raw uncompressed point, base64url without padding: 87 chars", () => {
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(Buffer.from(publicKey, "base64url")[0]).toBe(0x04);
  });

  it("keeps the private key non-extractable", () => {
    expect(pair.privateKey.extractable).toBe(false);
  });
});

describe("k2Text → verifyK2 round trip", () => {
  it("verifies at the matching time and carries this phone's key", async () => {
    const qr = await k2Text(pair, stored(0), SERVER_NOW);
    const v = verifyK2(qr, SERVER_NOW);
    expect(v).not.toBeNull();
    expect(v?.dk).toBe(publicKey);
    expect(v?.claims).toMatchObject({ jti: JTI, eid: EID, tier: "VIP", admits: 1 });
  });

  it("is k2.<3-segment token>.<ts>.<devsig>, devsig 64 bytes base64url", async () => {
    const qr = await k2Text(pair, stored(0), SERVER_NOW + 0.9);
    const parts = qr.split(".");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("k2");
    expect(parts.slice(1, 4).join(".")).toBe(token);
    expect(parts[4]).toBe(String(SERVER_NOW)); // floored, canonical decimal
    expect(parts[5]).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(Buffer.from(parts[5], "base64url")).toHaveLength(64);
  });

  it("applies the server-time offset, so a phone clock 5 minutes fast still lands in the window", async () => {
    const phoneNow = SERVER_NOW + 300;
    const qr = await k2Text(pair, stored(-300), phoneNow);
    expect(qr.split(".")[4]).toBe(String(SERVER_NOW));
    expect(verifyK2(qr, SERVER_NOW)).not.toBeNull();
    // Without the offset the same phone would be refused.
    expect(verifyK2(await k2Text(pair, stored(0), phoneNow), SERVER_NOW)).toBeNull();
  });

  it("stays valid for the whole 15 s it is shown, and no longer than the window", async () => {
    const qr = await k2Text(pair, stored(0), SERVER_NOW);
    expect(verifyK2(qr, SERVER_NOW + 15)).not.toBeNull();
    expect(verifyK2(qr, SERVER_NOW + K2_PAST_SECONDS)).not.toBeNull();
    expect(verifyK2(qr, SERVER_NOW + K2_PAST_SECONDS + 1)).toBeNull();
    expect(verifyK2(qr, SERVER_NOW - K2_FUTURE_SECONDS - 1)).toBeNull();
  });

  it("is refused when signed by another phone's key", async () => {
    const other = (await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    expect(verifyK2(await k2Text(other, stored(0), SERVER_NOW), SERVER_NOW)).toBeNull();
  });
});

// ─── getOrCreateKey: two tabs never end up with two keys (review M1) ────────
// The IndexedDB store's `add` refuses an existing key (ConstraintError →
// "exists"); this fake does the same, so the create-once logic runs here.

function fakeStore(initial?: CryptoKeyPair) {
  const map = new Map<string, CryptoKeyPair>();
  if (initial) map.set("b1", initial);
  const store: KeyStore & { adds: number } = {
    adds: 0,
    get: async (id) => map.get(id),
    add: async (id, p) => {
      store.adds++;
      if (map.has(id)) return "exists";
      map.set(id, p);
      return "added";
    },
  };
  return { store, map };
}

const newPair = async () =>
  (await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

describe("getOrCreateKey", () => {
  it("returns the stored key without generating", async () => {
    const { store } = fakeStore(pair);
    let generated = 0;
    const got = await getOrCreateKey("b1", store, async () => {
      generated++;
      return newPair();
    });
    expect(got).toBe(pair);
    expect(generated).toBe(0);
    expect(store.adds).toBe(0);
  });

  it("creates and adds a key on first use", async () => {
    const { store, map } = fakeStore();
    const fresh = await newPair();
    expect(await getOrCreateKey("b1", store, async () => fresh)).toBe(fresh);
    expect(map.get("b1")).toBe(fresh);
  });

  it("two tabs racing: both read nothing, both generate, both end up with the first tab's key", async () => {
    const { store, map } = fakeStore();
    const a = await newPair();
    const b = await newPair();
    // Both reads happen before either add.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const racing: KeyStore = {
      get: async (id) => {
        const v = map.get(id);
        await gate;
        return v;
      },
      add: store.add,
    };
    const [gotA, gotB] = await Promise.all([
      getOrCreateKey("b1", racing, async () => a),
      getOrCreateKey("b1", racing, async () => b),
      Promise.resolve().then(release),
    ]);
    expect(map.get("b1")).toBeDefined();
    expect(gotA).toBe(map.get("b1"));
    expect(gotB).toBe(map.get("b1"));
    expect(gotA).toBe(gotB);
  });

  it("add says exists but the re-read finds nothing → throws (the page shows its storage error)", async () => {
    const store: KeyStore = { get: async () => undefined, add: async () => "exists" };
    await expect(getOrCreateKey("b1", store, newPair)).rejects.toThrow();
  });
});
