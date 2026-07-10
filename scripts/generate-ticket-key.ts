// scripts/generate-ticket-key.ts — run: node --experimental-strip-types scripts/generate-ticket-key.ts
import { generateKeyPairSync } from "crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const priv = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32); // last 32 bytes = raw ed25519 pubkey

console.log("TICKET_SIGNING_KEY (private, pkcs8 base64):\n" + priv + "\n");
console.log("Public key (raw, base64url) for the app bundle:\n" + rawPub.toString("base64url") + "\n");
console.log("Set TICKET_KID to a stable id, e.g. kuunyi-ed25519-1");
