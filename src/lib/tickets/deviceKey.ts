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

/** offset = serverTime - phone time, seconds; publicKey = the key this token was bound to. */
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

/** The buyer's key on this browser, created on first use. Returns the public key, base64url. */
export async function deviceKey(buyerId: string): Promise<{ pair: CryptoKeyPair; publicKey: string }> {
  let pair = await get<CryptoKeyPair>(STORE, buyerId);
  if (!pair) {
    pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const created = pair;
    await write(STORE, (s) => s.put(created, buyerId));
  }
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

/** The QR text for "now": k2.<token>.<ts>.<devsig> (design 6.2). Pure apart from WebCrypto. */
export async function k2Text(pair: CryptoKeyPair, t: StoredToken, phoneNowSeconds: number): Promise<string> {
  const ts = String(Math.floor(phoneNowSeconds + t.offset));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(k2SignedText(t.jti, ts)),
  );
  return `k2.${t.token}.${ts}.${b64u(sig)}`;
}
