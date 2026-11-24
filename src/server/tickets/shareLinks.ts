import { createHash, randomBytes } from "crypto";

// A share link's secret lives only in the link's fragment (design 6.4).
// The database keeps its SHA-256. Never log a token or a hash.
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const newShareToken = (): string => randomBytes(32).toString("base64url");
export const isShareToken = (t: unknown): t is string => typeof t === "string" && TOKEN.test(t);
export const hashShareToken = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");
export const shareLinkUrl = (origin: string, token: string): string => `${origin}/t/claim#${token}`;
