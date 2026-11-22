// Browser only ("use client" consumers import it). Design 6.1–6.3.
//
// One non-extractable P-256 key per (browser, buyer), kept in IndexedDB. The
// private key never leaves this browser: IndexedDB stores the CryptoKey object
// itself, which can sign but can't be exported.
//
// Never log or display a bound token, a device key or a k2 string.
import { k2SignedText } from "./k2Text";

const DB = "kuunyi-tickets";
const STORE = "keys";
const TOKENS = "tokens";

/**
 * offset = server time minus Date.now()/1000 when saved (wall clock: it must
 * survive a reload, which a performance.now() anchor doesn't); publicKey = the
 * key this token was bound to.
 */
export interface StoredToken {
  token: string;
  jti: string;
  offset: number;
  publicKey: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
      req.result.createObjectStore(TOKENS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("indexeddb blocked"));
  });
  // A failed open (private window, storage off) must not stick for the page's life.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

async function get<T>(store: string, key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

async function write(store: string, fn: (s: IDBObjectStore) => void): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    fn(tx.objectStore(store));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const b64u = (b: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** The raw uncompressed public point, base64url without padding (87 chars). */
export async function exportPublicKey(pair: CryptoKeyPair): Promise<string> {
  return b64u(await crypto.subtle.exportKey("raw", pair.publicKey));
}

/** Where the keys live; an interface so the create-once logic is testable without IndexedDB. */
export interface KeyStore {
  get(buyerId: string): Promise<CryptoKeyPair | undefined>;
  /** Writes only if no key is stored yet: "exists" when another tab got there first. */
  add(buyerId: string, pair: CryptoKeyPair): Promise<"added" | "exists">;
}

/**
 * The stored key, or a new one. Two tabs opening their first ticket at once
 * both generate a key, but `add` lets only one write; the other re-reads and
 * uses the winner's, so both bind the same key and neither revokes the other.
 */
export async function getOrCreateKey(
  buyerId: string,
  store: KeyStore,
  generate: () => Promise<CryptoKeyPair>,
): Promise<CryptoKeyPair> {
  const existing = await store.get(buyerId);
  if (existing) return existing;
  const pair = await generate();
  if ((await store.add(buyerId, pair)) === "added") return pair;
  const winner = await store.get(buyerId);
  if (!winner) throw new Error("device key missing after a conflicting add");
  return winner;
}

async function addKey(buyerId: string, pair: CryptoKeyPair): Promise<"added" | "exists"> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    let exists = false;
    const r = tx.objectStore(STORE).add(pair, buyerId);
    r.onerror = (e) => {
      if (r.error?.name === "ConstraintError") {
        exists = true;
        e.preventDefault(); // keep the transaction from aborting
        e.stopPropagation();
      }
    };
    tx.oncomplete = () => resolve(exists ? "exists" : "added");
    tx.onerror = () => {
      if (!exists) reject(tx.error);
    };
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb transaction aborted"));
  });
}

const idbKeyStore: KeyStore = { get: (id) => get<CryptoKeyPair>(STORE, id), add: addKey };

const generateDeviceKey = async () =>
  (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

/** The buyer's key on this browser, created on first use. Returns the public key, base64url. */
export async function deviceKey(buyerId: string): Promise<{ pair: CryptoKeyPair; publicKey: string }> {
  const pair = await getOrCreateKey(buyerId, idbKeyStore, generateDeviceKey);
  return { pair, publicKey: await exportPublicKey(pair) };
}

// Keyed by buyer and ticket: two accounts on one browser never share a token.
const tokenKey = (buyerId: string, ticketId: string) => `${buyerId}:${ticketId}`;

export const loadToken = (buyerId: string, ticketId: string) =>
  get<StoredToken>(TOKENS, tokenKey(buyerId, ticketId));

export const saveToken = (buyerId: string, ticketId: string, t: StoredToken) =>
  write(TOKENS, (s) => s.put(t, tokenKey(buyerId, ticketId)));

export const clearToken = (buyerId: string, ticketId: string) =>
  write(TOKENS, (s) => s.delete(tokenKey(buyerId, ticketId)));

/** The QR text for a given ts: k2.<token>.<ts>.<devsig> (design 6.2). Pure apart from WebCrypto. */
export async function k2TextAt(
  pair: CryptoKeyPair,
  t: Pick<StoredToken, "token" | "jti">,
  tsSeconds: number,
): Promise<string> {
  const ts = String(Math.floor(tsSeconds));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(k2SignedText(t.jti, ts)),
  );
  return `k2.${t.token}.${ts}.${b64u(sig)}`;
}

/** The QR text for "now" by the phone clock plus the stored offset. */
export async function k2Text(pair: CryptoKeyPair, t: StoredToken, phoneNowSeconds: number): Promise<string> {
  return k2TextAt(pair, t, phoneNowSeconds + t.offset);
}
