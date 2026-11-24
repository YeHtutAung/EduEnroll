import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Example env files ship in a public repo. A value that isn't an obvious
// placeholder could be mistaken for, or be, a real secret.
const text = fs.readFileSync(path.join(process.cwd(), ".env.local.example"), "utf8");

function value(name: string): string | undefined {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).replace(/^"|"$/g, "");
}

const PLACEHOLDER = /^(<[^>]+>|(.)\2+|)$/; // <something>, a repeated character, or empty

// Booleans only: a failing toMatch() would print the value in the diff.
const isPlaceholder = (name: string) => {
  const v = value(name);
  return v !== undefined && PLACEHOLDER.test(v);
};

describe(".env.local.example", () => {
  it("uses a placeholder for MESSENGER_VERIFY_TOKEN", () => {
    expect(isPlaceholder("MESSENGER_VERIFY_TOKEN")).toBe(true);
  });

  it.each(["SUPABASE_SEND_EMAIL_HOOK_SECRET", "RATE_LIMIT_HMAC_SECRET"])(
    "names %s with a placeholder value",
    (name) => {
      expect(isPlaceholder(name)).toBe(true);
    },
  );
});
