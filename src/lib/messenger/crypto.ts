// ─── AES-256-GCM encryption for Messenger page tokens ───────────────────────
//
// Uses MESSENGER_ENCRYPTION_KEY env var (64-char hex = 32 bytes).
// Format: base64(iv:ciphertext:authTag)

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

function getKey(): Buffer {
  const hex = process.env.MESSENGER_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("MESSENGER_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).");
  }
  return Buffer.from(hex, "hex");
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Pack as iv:ciphertext:authTag then base64
  const packed = Buffer.concat([iv, encrypted, authTag]);
  return packed.toString("base64");
}

export function decryptToken(encoded: string): string {
  const key = getKey();
  const packed = Buffer.from(encoded, "base64");
  const iv = packed.subarray(0, 12);
  const authTag = packed.subarray(packed.length - 16);
  const ciphertext = packed.subarray(12, packed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}
