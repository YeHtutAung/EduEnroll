// ─── AES-256-GCM decryption ───────────────────────────────────────────────────
// Encrypted format: iv:authTag:ciphertext  (all hex-encoded, colon-separated)
// Key source: TELEGRAM_ENCRYPTION_KEY env var (64-char hex = 32 bytes)

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export function encryptToken(plaintext: string): string {
  const hex = process.env.TELEGRAM_ENCRYPTION_KEY;
  if (!hex) throw new Error("TELEGRAM_ENCRYPTION_KEY is not set");

  const key = Buffer.from(hex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptToken(encryptedText: string): string {
  const hex = process.env.TELEGRAM_ENCRYPTION_KEY;
  if (!hex) throw new Error("TELEGRAM_ENCRYPTION_KEY is not set");

  const [ivHex, authTagHex, ciphertextHex] = encryptedText.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Invalid encrypted format. Expected iv:authTag:ciphertext (hex)");
  }

  const key = Buffer.from(hex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext) + decipher.final("utf8");
}
